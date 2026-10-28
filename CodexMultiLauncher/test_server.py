import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import server


class ProfileRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = {
            "id": "imported", "name": "中文配置", "sourceRoot": str(self.root / "original"),
            "sourceAppData": str(self.root / "roaming"), "tokenProtected": "encrypted",
            "workspace": str(self.root), "baseUrl": "https://example.invalid/v1",
            "model": "test", "wireApi": "responses", "contextWindow": "123456",
        }
        for name, value in {"PROFILES_ROOT": self.root / "profiles", "PROFILES_FILE": self.root / "profiles.json",
                            "DATA_ROOT": self.root, "PROCESSES": {}, "PROCESS_STARTED": {},
                            "PROCESS_STARTED_MONOTONIC": {}, "PROCESS_CONFIRMED": set()}.items():
            scope = patch.object(server, name, value)
            scope.start()
            self.addCleanup(scope.stop)

    def records(self, roaming, parent=100, child=101):
        user_data = str(roaming / "Codex" / "web" / "Codex")
        return [{"ProcessId": parent, "ParentProcessId": 1, "CommandLine": '"app/ChatGPT.exe"'},
                {"ProcessId": child, "ParentProcessId": parent,
                 "CommandLine": f'"app/ChatGPT.exe" --type=crashpad-handler --user-data-dir="{user_data}" /prefetch:4'}]

    def test_imported_process_scope_excludes_old_copy_and_similar_paths(self):
        roaming = Path(self.profile["sourceAppData"])
        records = (self.records(roaming) + self.records(Path(str(roaming) + "-other"), 200, 201)
                   + self.records(server.profile_root("imported") / "codex-home/appdata/Roaming", 300, 301))
        with patch.object(server, "get_codex_processes", return_value=records):
            self.assertEqual(server.discover_profile_processes(self.profile), [100])
            state = server.sanitize_profile(self.profile)
        self.assertEqual(state["status"], "running")
        self.assertEqual(state["managedPids"], [100])
        self.assertEqual(state["externalPids"], [])

    def test_generated_files_select_original_without_overwriting_it(self):
        original = Path(self.profile["sourceRoot"])
        original.mkdir()
        config = original / "config.toml"
        config.write_text("# original settings\n", encoding="utf-8")
        server.write_profile_files(self.profile)
        persisted = json.loads((server.profile_root("imported") / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["runtimeHome"], str(original))
        self.assertEqual(persisted["runtimeLocalAppData"], str(Path(self.profile["sourceAppData"]).parent / "Local"))
        self.assertEqual(config.read_text(encoding="utf-8"), "# original settings\n")

    def test_new_profiles_still_use_isolated_home(self):
        profile = {"id": "new"}
        home, roaming, local = server.profile_runtime_paths(profile)
        self.assertEqual(home, server.profile_root("new") / "codex-home")
        with patch.object(server, "get_codex_processes", return_value=self.records(roaming)):
            self.assertEqual(server.discover_profile_processes(profile), [100])

    def test_launch_running_original_is_idempotent(self):
        with patch.object(server, "get_codex_processes", return_value=self.records(Path(self.profile["sourceAppData"]))), \
                patch.object(server, "write_profile_files") as write, patch.object(server.subprocess, "Popen") as spawn:
            self.assertEqual(server.launch_profile(self.profile)["status"], "running")
        spawn.assert_not_called()
        write.assert_not_called()

    def test_stop_original_targets_only_its_process_tree(self):
        with patch.object(server, "load_profiles", return_value=[self.profile]), \
                patch.object(server, "discover_profile_processes", side_effect=[[100], []]), \
                patch.object(server.subprocess, "run") as kill:
            server.stop_profile("imported")
        self.assertEqual(kill.call_args.args[0], ["taskkill.exe", "/PID", "100", "/T", "/F"])
        self.assertTrue((server.profile_root("imported") / "stop.requested").exists())

    def test_stop_failure_is_reported(self):
        with patch.object(server, "load_profiles", return_value=[self.profile]), \
                patch.object(server, "discover_profile_processes", return_value=[100]), \
                patch.object(server.subprocess, "run"):
            with self.assertRaisesRegex(RuntimeError, "100"):
                server.stop_profile("imported")

    def test_startup_timeout_and_client_exit(self):
        process = Mock(pid=42)
        process.poll.return_value = 0
        server.PROCESSES["imported"] = process
        server.PROCESS_STARTED_MONOTONIC["imported"] = time.monotonic()
        with patch.object(server, "discover_profile_processes", return_value=[]):
            self.assertEqual(server.sanitize_profile(self.profile)["status"], "starting")
            server.PROCESS_STARTED_MONOTONIC["imported"] -= 30
            self.assertEqual(server.sanitize_profile(self.profile)["status"], "failed")
            process.poll.return_value = None
            self.assertEqual(server.sanitize_profile(self.profile)["status"], "failed")
            server.PROCESS_CONFIRMED.add("imported")
            self.assertEqual(server.sanitize_profile(self.profile)["status"], "stopped")

    def test_save_retains_imported_model_metadata(self):
        server.save_profiles([self.profile])
        with patch.object(server, "get_codex_processes", return_value=[]):
            saved = server.upsert_profile({"id": "imported", "name": "renamed"})
        self.assertEqual(saved["contextWindow"], "123456")
        self.assertEqual(saved["sourceRoot"], self.profile["sourceRoot"])


if __name__ == "__main__":
    unittest.main()
