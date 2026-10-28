"""Opt-in Windows AppX launch/stop test using a harmless local probe executable.

Run with CODEX_LAUNCHER_INTEGRATION=1. No real Codex client or API is used.
"""
import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server


@unittest.skipUnless(os.name == "nt" and os.environ.get("CODEX_LAUNCHER_INTEGRATION") == "1", "opt-in Windows integration")
class WindowsLauncherTests(unittest.TestCase):
    def test_controller_survives_termination_of_the_callers_process_tree(self):
        windows_ps = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe")
        with tempfile.TemporaryDirectory(prefix="codex-controller-probe-") as directory:
            root = Path(directory)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            coordinator = root / "coordinator.ps1"
            coordinator.write_text(
                "param($Launcher,$DataRoot,[int]$Port)\n$ErrorActionPreference='Stop'\n"
                "& $Launcher -NoBrowser -DataRoot $DataRoot -Port $Port\n"
                "Start-Sleep -Seconds 60\n", encoding="utf-8-sig")
            caller = subprocess.Popen([windows_ps, "-NoProfile", "-File", str(coordinator),
                                       str(server.ROOT / "start.ps1"), str(root), str(port)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
            health_url = f"http://127.0.0.1:{port}/api/health"
            service_pid = None
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        with urllib.request.urlopen(health_url, timeout=1) as response:
                            health = json.load(response)
                        service_pid = health["pid"]
                        break
                    except OSError:
                        time.sleep(0.2)
                self.assertIsNotNone(service_pid, "independent service did not start")
                subprocess.run(['taskkill.exe', '/PID', str(caller.pid), '/T', '/F'], check=True, capture_output=True)
                caller.wait(timeout=5)
                with urllib.request.urlopen(health_url, timeout=3) as response:
                    self.assertEqual(json.load(response)["pid"], service_pid)
                # Re-running the entry point must reuse this surviving service.
                subprocess.run([windows_ps, "-NoProfile", "-File", str(server.ROOT / "start.ps1"),
                                "-NoBrowser", "-DataRoot", str(root), "-Port", str(port)],
                               check=True, capture_output=True, timeout=15)
                with urllib.request.urlopen(health_url, timeout=3) as response:
                    self.assertEqual(json.load(response)["pid"], service_pid)
            finally:
                if caller.poll() is None:
                    subprocess.run(['taskkill.exe', '/PID', str(caller.pid), '/T', '/F'], capture_output=True)
                    caller.wait(timeout=5)
                if service_pid is not None:
                    subprocess.run(['taskkill.exe', '/PID', str(service_pid), '/F'], capture_output=True)

    def test_package_launch_and_stop_for_imported_and_new_profiles(self):
        with tempfile.TemporaryDirectory(prefix="codex-launch-probe-") as directory:
            root = Path(directory)
            probe = root / "ChatGPT.exe"
            source = root / "Probe.cs"
            source.write_text(r'''
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
public class Probe {
    public static void Main(string[] args) {
        if (args.Length > 0 && args[0].StartsWith("--user-data-dir=")) {
            Thread.Sleep(60000);
            return;
        }
        string home = Environment.GetEnvironmentVariable("CODEX_HOME");
        string roaming = Environment.GetEnvironmentVariable("APPDATA");
        File.WriteAllLines(Path.Combine(home, "probe.txt"), new [] {
            home, roaming, Environment.GetEnvironmentVariable("LOCALAPPDATA")
        });
        var child = Process.Start(new ProcessStartInfo {
            FileName = Assembly.GetExecutingAssembly().Location,
            Arguments = "--user-data-dir=\"" + Path.Combine(roaming, "Codex", "web", "Codex") + "\"",
            UseShellExecute = false, CreateNoWindow = true
        });
        child.WaitForExit();
    }
}
''', encoding="utf-8")
            windows_ps = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe")
            compile_script = root / "compile.ps1"
            compile_script.write_text(
                "param($SourcePath,$OutputPath)\n$ErrorActionPreference='Stop'\n"
                "Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath)) -Language CSharp "
                "-OutputAssembly $OutputPath -OutputType WindowsApplication\n", encoding="utf-8-sig")
            subprocess.run([windows_ps, "-NoProfile", "-File", str(compile_script), str(source), str(probe)],
                           check=True, capture_output=True)
            protected = server.protect_token("local-probe-only")
            with patch.multiple(server, DATA_ROOT=root, PROFILES_ROOT=root / "profiles",
                                PROFILES_FILE=root / "profiles.json", PROCESSES={}, PROCESS_STARTED={},
                                PROCESS_STARTED_MONOTONIC={}, PROCESS_CONFIRMED=set()):
                for imported in (True, False):
                    with self.subTest(imported=imported):
                        profile = {"id": "imported" if imported else "isolated", "name": "中文测试",
                                   "workspace": str(root), "executablePath": str(probe), "tokenProtected": protected}
                        if imported:
                            original = root / "中文 original"
                            original.mkdir()
                            (original / "config.toml").write_text("# preserve original\n", encoding="utf-8")
                            profile.update(sourceRoot=str(original), sourceAppData=str(original / "appdata/Roaming"))
                        server.save_profiles([profile])
                        try:
                            server.launch_profile(profile)
                            deadline = time.monotonic() + 15
                            state = None
                            while time.monotonic() < deadline:
                                state = server.sanitize_profile(profile)
                                if state["status"] == "running":
                                    break
                                time.sleep(0.25)
                            self.assertEqual(state["status"], "running", server.recent_log(profile["id"]))
                            home, roaming, local = server.profile_runtime_paths(profile)
                            self.assertEqual((home / "probe.txt").read_text(encoding="utf-8-sig").splitlines(),
                                             [str(home), str(roaming), str(local)])
                            if imported:
                                self.assertEqual((home / "config.toml").read_text(encoding="utf-8"), "# preserve original\n")
                            self.assertEqual(server.launch_profile(profile)["pid"], state["pid"])
                            server.stop_profile(profile["id"])
                            self.assertEqual(server.sanitize_profile(profile)["status"], "stopped")
                        finally:
                            server.stop_profile(profile["id"])


if __name__ == "__main__":
    unittest.main()
