"""Local web controller for launching isolated Codex TokenAPI clients.

The launcher intentionally keeps the browser out of the process-launching path:
the browser talks to this localhost-only server, while PowerShell performs the
Windows AppX launch used by the Codex desktop package.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("LOCALAPPDATA", str(ROOT / "data"))) / "CodexMultiLauncher"
PROFILES_ROOT = DATA_ROOT / "profiles"
PROFILES_FILE = DATA_ROOT / "profiles.json"
# The desktop runtime ships a PowerShell 7 executable ahead of the system
# PowerShell in this environment.  It carries the Security module needed for
# ConvertFrom-SecureString, so prefer it when available.
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"

DEFAULT_BASE_URL = "https://tokenapi.happyelements.net/v1"
DEFAULT_MODEL = "gpt-6.1-sol"
DEFAULT_REASONING = "xhigh"
DEFAULT_WIRE_API = "responses"
USER_HOME = Path(os.environ.get("USERPROFILE", str(Path.home())))

STATE_LOCK = threading.RLock()
PROCESSES: dict[str, subprocess.Popen[Any]] = {}
PROCESS_STARTED: dict[str, str] = {}
PROCESS_SNAPSHOT: list[dict[str, Any]] = []
PROCESS_SNAPSHOT_TIME = 0.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_profiles() -> list[dict[str, Any]]:
    if not PROFILES_FILE.exists():
        return []
    try:
        data = json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return normalize_profiles(data) if isinstance(data, list) else []


def normalize_profiles(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one stable default profile while migrating older profile files."""
    normalized = [dict(profile) for profile in profiles]
    default_ids = [profile.get("id") for profile in normalized if profile.get("isDefault")]
    default_id = default_ids[0] if default_ids else None
    if default_id is None and normalized:
        preferred = next((profile for profile in normalized if profile.get("id") == "import-sub2api"), normalized[0])
        default_id = preferred.get("id")
    for profile in normalized:
        profile["isDefault"] = bool(default_id and profile.get("id") == default_id)
    return normalized


def save_profiles(profiles: list[dict[str, Any]]) -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    temporary = PROFILES_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(normalize_profiles(profiles), ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(PROFILES_FILE)


def find_profile(profile_id: str) -> dict[str, Any] | None:
    with STATE_LOCK:
        return next((item for item in load_profiles() if item.get("id") == profile_id), None)


def profile_root(profile_id: str) -> Path:
    return PROFILES_ROOT / profile_id


def get_codex_processes() -> list[dict[str, Any]]:
    global PROCESS_SNAPSHOT_TIME
    global PROCESS_SNAPSHOT
    now = time.monotonic()
    if now - PROCESS_SNAPSHOT_TIME < 1.0:
        return PROCESS_SNAPSHOT
    command = (
        "Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" "
        "| Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0 or not completed.stdout.strip():
            PROCESS_SNAPSHOT = []
        else:
            value = json.loads(completed.stdout)
            PROCESS_SNAPSHOT = value if isinstance(value, list) else [value]
    except (OSError, json.JSONDecodeError):
        PROCESS_SNAPSHOT = []
    PROCESS_SNAPSHOT_TIME = now
    return PROCESS_SNAPSHOT


def profile_appdata_roots(profile: dict[str, Any]) -> list[Path]:
    roots = [
        profile_root(profile["id"]) / "codex-home" / "appdata" / "Roaming",
    ]
    source_root = str(profile.get("sourceRoot") or "").strip()
    source_appdata = str(profile.get("sourceAppData") or "").strip()
    if source_appdata:
        roots.append(Path(source_appdata))
    elif source_root:
        roots.append(Path(source_root) / "appdata" / "Roaming")
    return roots


def discover_profile_processes(profile: dict[str, Any]) -> list[int]:
    markers = [
        str(path).replace("/", "\\").rstrip("\\").lower()
        for path in profile_appdata_roots(profile)
        if path
    ]
    records = get_codex_processes()
    processes_by_id = {
        int(record["ProcessId"]): record
        for record in records
        if record.get("ProcessId") is not None
    }
    matched_ids = {
        int(record["ProcessId"])
        for record in records
        if any(marker in str(record.get("CommandLine") or "").lower() for marker in markers)
    }
    root_ids: set[int] = set()
    for process_id in matched_ids:
        candidate = process_id
        visited: set[int] = set()
        while candidate in processes_by_id and candidate not in visited:
            visited.add(candidate)
            parent_id = int(processes_by_id[candidate].get("ParentProcessId") or 0)
            if parent_id not in processes_by_id:
                break
            candidate = parent_id
        root_ids.add(candidate)
    return sorted(root_ids)


def toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def write_profile_files(profile: dict[str, Any]) -> None:
    root = profile_root(profile["id"])
    home = root / "codex-home"
    (home / "appdata" / "Roaming").mkdir(parents=True, exist_ok=True)
    (home / "appdata" / "Local").mkdir(parents=True, exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)

    config_lines = [
        "model_provider = \"tokenapi\"",
        f"model = {toml_string(profile.get('model') or DEFAULT_MODEL)}",
        f"model_reasoning_effort = {toml_string(profile.get('reasoningEffort') or DEFAULT_REASONING)}",
        "disable_response_storage = true",
    ]
    if profile.get("contextWindow"):
        config_lines.append(f"model_context_window = {int(profile['contextWindow'])}")
    if profile.get("autoCompactTokenLimit"):
        config_lines.append(f"model_auto_compact_token_limit = {int(profile['autoCompactTokenLimit'])}")
    catalog_source = profile.get("modelCatalogSource")
    if catalog_source and Path(str(catalog_source)).is_file():
        catalog_target = home / "model-catalog.json"
        shutil.copy2(str(catalog_source), catalog_target)
        config_lines.append(f"model_catalog_json = {toml_string(str(catalog_target))}")
    config_lines.extend(
        [
            "",
            "[model_providers.tokenapi]",
            "name = \"tokenapi\"",
            f"base_url = {toml_string(profile.get('baseUrl') or DEFAULT_BASE_URL)}",
            f"wire_api = {toml_string(profile.get('wireApi') or DEFAULT_WIRE_API)}",
            "requires_openai_auth = false",
            "env_key = \"TOKENAPI_API_KEY\"",
            "",
        ]
    )
    config = "\n".join(config_lines)
    (home / "config.toml").write_text(config, encoding="utf-8")

    persisted = {
        "id": profile["id"],
        "name": profile.get("name") or profile["id"],
        "isDefault": bool(profile.get("isDefault")),
        "tokenProtected": profile.get("tokenProtected", ""),
        "workspace": profile.get("workspace", ""),
        "executablePath": profile.get("executablePath", ""),
        "sourceRoot": profile.get("sourceRoot", ""),
        "sourceAppData": profile.get("sourceAppData", ""),
    }
    (root / "profile.json").write_text(json.dumps(persisted, ensure_ascii=False, indent=2), encoding="utf-8")


def protect_token(token: str) -> str:
    """Protect a token with the current Windows user DPAPI via PowerShell."""
    command = (
        "$value = [Console]::In.ReadToEnd(); "
        "$secure = ConvertTo-SecureString -String $value.TrimEnd([char]13,[char]10) -AsPlainText -Force; "
        "ConvertFrom-SecureString -SecureString $secure"
    )
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
        input=token,
        text=True,
        capture_output=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise RuntimeError(completed.stderr.strip() or "Windows DPAPI encryption failed")
    return completed.stdout.strip()


def sanitize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    profile_id = profile["id"]
    process = PROCESSES.get(profile_id)
    discovered_pids = discover_profile_processes(profile)
    if process is None:
        status = "running" if discovered_pids else "stopped"
        pid = discovered_pids[0] if discovered_pids else None
    elif process.poll() is None:
        status = "running"
        pid = process.pid
    else:
        status = "running" if discovered_pids else ("failed" if process.returncode else "stopped")
        pid = discovered_pids[0] if discovered_pids else process.pid
        PROCESSES.pop(profile_id, None)
        PROCESS_STARTED.pop(profile_id, None)
    return {
        "id": profile_id,
        "name": profile.get("name", profile_id),
        "isDefault": bool(profile.get("isDefault")),
        "enabled": bool(profile.get("enabled", True)),
        "baseUrl": profile.get("baseUrl", DEFAULT_BASE_URL),
        "model": profile.get("model", DEFAULT_MODEL),
        "reasoningEffort": profile.get("reasoningEffort", DEFAULT_REASONING),
        "wireApi": profile.get("wireApi", DEFAULT_WIRE_API),
        "workspace": profile.get("workspace", ""),
        "executablePath": profile.get("executablePath", ""),
        "tokenConfigured": bool(profile.get("tokenProtected")),
        "status": status,
        "pid": pid,
        "startedAt": PROCESS_STARTED.get(profile_id),
        "detectedPids": discovered_pids,
    }


def validate_profile(profile: dict[str, Any]) -> None:
    required = {
        "name": "名称",
        "baseUrl": "TokenAPI 地址",
        "model": "模型",
        "workspace": "工作区",
    }
    for key, label in required.items():
        if not str(profile.get(key, "")).strip():
            raise ValueError(f"{label}不能为空")
    if not str(profile["baseUrl"]).startswith(("http://", "https://")):
        raise ValueError("TokenAPI 地址必须以 http:// 或 https:// 开头")
    if not Path(str(profile["workspace"])).expanduser().is_dir():
        raise ValueError(f"工作区不存在：{profile['workspace']}")
    if profile.get("wireApi") not in {"responses", "chat"}:
        raise ValueError("协议必须是 responses 或 chat")


def read_toml_value(text: str, key: str) -> str:
    match = re.search(rf"^\s*{re.escape(key)}\s*=\s*(\"(?:\\.|[^\"])*\"|[^\s#]+)\s*$", text, re.MULTILINE)
    if not match:
        return ""
    raw = match.group(1)
    if not raw.startswith('"'):
        return raw
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    return str(value)


def import_existing_profiles() -> tuple[list[dict[str, Any]], list[str]]:
    """Import the two configs used by the supplied Codex isolation shortcut.

    The TokenAPI credential is already DPAPI-protected.  The Sub2API config
    contains a bearer token, so it is immediately re-encrypted with the
    current Windows user's DPAPI before it enters this tool's data directory.
    """
    imported: list[dict[str, Any]] = []
    errors: list[str] = []
    workspace = r"S:\P4SilverRoot"
    if not Path(workspace).is_dir():
        workspace = str(ROOT)

    tokenapi_root = USER_HOME / ".codex-sub2api"
    tokenapi_config_path = tokenapi_root / "config.toml"
    tokenapi_key_path = tokenapi_root / "tokenapi.key"
    if tokenapi_config_path.is_file() and tokenapi_key_path.is_file():
        try:
            config = tokenapi_config_path.read_text(encoding="utf-8")
            protected = tokenapi_key_path.read_text(encoding="utf-8").strip()
            profile = {
                "id": "import-tokenapi",
                "name": "TokenAPI（隔离）",
                "isDefault": False,
                "enabled": True,
                "baseUrl": read_toml_value(config, "base_url") or DEFAULT_BASE_URL,
                "model": read_toml_value(config, "model") or DEFAULT_MODEL,
                "reasoningEffort": read_toml_value(config, "model_reasoning_effort") or DEFAULT_REASONING,
                "wireApi": read_toml_value(config, "wire_api") or DEFAULT_WIRE_API,
                "workspace": workspace,
                "executablePath": "",
                "sourceRoot": str(tokenapi_root),
                "sourceAppData": str(tokenapi_root / "appdata" / "Roaming"),
                "tokenProtected": protected,
                "contextWindow": read_toml_value(config, "model_context_window"),
                "autoCompactTokenLimit": read_toml_value(config, "model_auto_compact_token_limit"),
                "modelCatalogSource": str(tokenapi_root / "tokenapi-model-catalog.json"),
            }
            validate_profile(profile)
            imported.append(profile)
        except Exception as error:  # noqa: BLE001
            errors.append(f"TokenAPI 导入失败：{error}")
    else:
        errors.append(f"未找到 TokenAPI 配置：{tokenapi_root}")

    sub2api_config_path = USER_HOME / ".codex" / "config.toml"
    if sub2api_config_path.is_file():
        try:
            config = sub2api_config_path.read_text(encoding="utf-8")
            token = read_toml_value(config, "experimental_bearer_token")
            if not token:
                raise ValueError("没有找到 experimental_bearer_token")
            profile = {
                "id": "import-sub2api",
                "name": "Sub2API（现有配置）",
                "isDefault": True,
                "enabled": True,
                "baseUrl": read_toml_value(config, "base_url") or "https://www.hkiller.com:18080",
                "model": read_toml_value(config, "model") or DEFAULT_MODEL,
                "reasoningEffort": read_toml_value(config, "model_reasoning_effort") or "high",
                "wireApi": read_toml_value(config, "wire_api") or DEFAULT_WIRE_API,
                "workspace": workspace,
                "executablePath": "",
                "sourceRoot": str(USER_HOME / ".codex"),
                "sourceAppData": str(USER_HOME / "AppData" / "Roaming"),
                "tokenProtected": protect_token(token),
                "contextWindow": read_toml_value(config, "model_context_window"),
                "autoCompactTokenLimit": read_toml_value(config, "model_auto_compact_token_limit"),
            }
            validate_profile(profile)
            imported.append(profile)
        except Exception as error:  # noqa: BLE001
            errors.append(f"Sub2API 导入失败：{error}")
    else:
        errors.append(f"未找到 Sub2API 配置：{sub2api_config_path}")

    with STATE_LOCK:
        profiles = load_profiles()
        default_id = next((item.get("id") for item in profiles if item.get("isDefault")), None)
        imported_ids = {item.get("id") for item in imported}
        if default_id is None:
            default_id = "import-sub2api" if "import-sub2api" in imported_ids else next(iter(imported_ids), None)
        for profile in imported:
            profile["isDefault"] = profile.get("id") == default_id
            profiles = [item for item in profiles if item.get("id") != profile["id"]]
            profiles.append(profile)
            write_profile_files(profile)
        save_profiles(profiles)
    return imported, errors


def upsert_profile(payload: dict[str, Any]) -> dict[str, Any]:
    profile_id = str(payload.get("id") or uuid.uuid4())
    profiles = load_profiles()
    old = next((item for item in profiles if item.get("id") == profile_id), {})
    token = payload.get("token")
    protected = old.get("tokenProtected", "")
    if payload.get("clearToken"):
        protected = ""
    elif token is not None and str(token).strip():
        protected = protect_token(str(token).strip())

    profile = {
        "id": profile_id,
        "name": str(payload.get("name") or old.get("name") or profile_id).strip(),
        "isDefault": bool(old.get("isDefault", not profiles)),
        "enabled": bool(payload.get("enabled", old.get("enabled", True))),
        "baseUrl": str(payload.get("baseUrl") or old.get("baseUrl") or DEFAULT_BASE_URL).strip().rstrip("/"),
        "model": str(payload.get("model") or old.get("model") or DEFAULT_MODEL).strip(),
        "reasoningEffort": str(payload.get("reasoningEffort") or old.get("reasoningEffort") or DEFAULT_REASONING).strip(),
        "wireApi": str(payload.get("wireApi") or old.get("wireApi") or DEFAULT_WIRE_API).strip(),
        "workspace": str(payload.get("workspace") or old.get("workspace") or "").strip(),
        "executablePath": str(payload.get("executablePath") or old.get("executablePath") or "").strip(),
        "sourceRoot": str(payload.get("sourceRoot") or old.get("sourceRoot") or "").strip(),
        "sourceAppData": str(payload.get("sourceAppData") or old.get("sourceAppData") or "").strip(),
        "tokenProtected": protected,
    }
    validate_profile(profile)
    with STATE_LOCK:
        if old:
            profiles = [profile if item.get("id") == profile_id else item for item in profiles]
        else:
            profiles.append(profile)
        save_profiles(profiles)
        write_profile_files(profile)
    return profile


def launch_profile(profile: dict[str, Any]) -> dict[str, Any]:
    if not profile.get("tokenProtected"):
        raise ValueError("请先配置 TokenAPI Token")
    profile_root(profile["id"]).mkdir(parents=True, exist_ok=True)
    write_profile_files(profile)
    with STATE_LOCK:
        current = PROCESSES.get(profile["id"])
        if current is not None and current.poll() is None:
            raise ValueError("该实例已经在运行")
        if discover_profile_processes(profile):
            raise ValueError("该实例已经在运行")
        script = ROOT / "launch-profile.ps1"
        command = [
            POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(script),
            "-ProfileRoot",
            str(profile_root(profile["id"])),
        ]
        startupinfo = None
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            startupinfo=startupinfo,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        PROCESSES[profile["id"]] = process
        PROCESS_STARTED[profile["id"]] = utc_now()
    return sanitize_profile(profile)


def stop_profile(profile_id: str) -> None:
    with STATE_LOCK:
        process = PROCESSES.get(profile_id)
        profile = next((item for item in load_profiles() if item.get("id") == profile_id), None)
    pids = set(discover_profile_processes(profile)) if profile else set()
    if process is not None and process.poll() is None:
        pids.add(process.pid)
    for pid in sorted(pids):
        subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    if process is not None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
    global PROCESS_SNAPSHOT_TIME
    PROCESS_SNAPSHOT_TIME = 0.0


def recent_log(profile_id: str) -> str:
    path = profile_root(profile_id) / "launcher.log"
    if not path.exists():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-80:])


def profile_id_from_action_path(path: str, action: str) -> str:
    prefix = "/api/profiles/"
    suffix = f"/{action}"
    if not path.startswith(prefix) or not path.endswith(suffix):
        return ""
    return unquote(path[len(prefix) : -len(suffix)].strip("/"))


class Handler(BaseHTTPRequestHandler):
    server_version = "CodexMultiLauncher/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2 * 1024 * 1024:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(value, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return value

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            with STATE_LOCK:
                profiles = [sanitize_profile(item) for item in load_profiles()]
            self.send_json({"profiles": profiles, "dataRoot": str(DATA_ROOT)})
            return
        if parsed.path.startswith("/api/profiles/") and parsed.path.endswith("/log"):
            profile_id = profile_id_from_action_path(parsed.path, "log")
            if find_profile(profile_id) is None:
                self.send_json({"error": "实例不存在"}, HTTPStatus.NOT_FOUND)
                return
            self.send_json({"log": recent_log(profile_id)})
            return
        if parsed.path == "/api/health":
            self.send_json({"ok": True})
            return
        if parsed.path == "/" or parsed.path == "/index.html":
            self.serve_file(ROOT / "index.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/app.js":
            self.serve_file(ROOT / "app.js", "text/javascript; charset=utf-8")
            return
        if parsed.path == "/styles.css":
            self.serve_file(ROOT / "styles.css", "text/css; charset=utf-8")
            return
        self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def serve_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_json({"error": "文件不存在"}, HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/profiles":
                profile = upsert_profile(payload)
                self.send_json(sanitize_profile(profile), HTTPStatus.CREATED if not payload.get("id") else HTTPStatus.OK)
                return
            if parsed.path == "/api/launch-all":
                results = []
                errors = []
                for profile in load_profiles():
                    try:
                        results.append(launch_profile(profile))
                    except Exception as error:  # noqa: BLE001
                        errors.append({"id": profile.get("id"), "error": str(error)})
                self.send_json({"started": results, "errors": errors})
                return
            if parsed.path == "/api/import-existing":
                imported, errors = import_existing_profiles()
                self.send_json({"imported": [sanitize_profile(item) for item in imported], "errors": errors})
                return
            if parsed.path == "/api/stop-all":
                for profile in load_profiles():
                    stop_profile(str(profile.get("id")))
                self.send_json({"ok": True})
                return
            if parsed.path.startswith("/api/profiles/") and parsed.path.endswith("/default"):
                profile_id = profile_id_from_action_path(parsed.path, "default")
                with STATE_LOCK:
                    profiles = load_profiles()
                    if not any(item.get("id") == profile_id for item in profiles):
                        self.send_json({"error": "实例不存在"}, HTTPStatus.NOT_FOUND)
                        return
                    profiles = [
                        {**item, "isDefault": item.get("id") == profile_id}
                        for item in profiles
                    ]
                    save_profiles(profiles)
                    for item in profiles:
                        write_profile_files(item)
                    profile = next(item for item in profiles if item.get("id") == profile_id)
                self.send_json(sanitize_profile(profile))
                return
            if parsed.path.startswith("/api/profiles/"):
                action = "launch" if parsed.path.endswith("/launch") else "stop" if parsed.path.endswith("/stop") else ""
                profile_id = profile_id_from_action_path(parsed.path, action) if action else unquote(parsed.path[len("/api/profiles/") :].strip("/"))
                profile = find_profile(profile_id)
                if profile is None:
                    self.send_json({"error": "实例不存在"}, HTTPStatus.NOT_FOUND)
                    return
                if parsed.path.endswith("/launch"):
                    self.send_json(launch_profile(profile))
                    return
                if parsed.path.endswith("/stop"):
                    stop_profile(profile_id)
                    self.send_json({"ok": True})
                    return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001
            self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/profiles/"):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        profile_id = unquote(parsed.path[len("/api/profiles/") :].strip("/"))
        profile = find_profile(profile_id)
        if profile is None:
            self.send_json({"error": "实例不存在"}, HTTPStatus.NOT_FOUND)
            return
        process = PROCESSES.get(profile_id)
        if process is not None and process.poll() is None:
            self.send_json({"error": "请先停止运行中的实例"}, HTTPStatus.CONFLICT)
            return
        with STATE_LOCK:
            save_profiles([item for item in load_profiles() if item.get("id") != profile_id])
        profile_directory = profile_root(profile_id)
        if profile_directory.exists():
            import shutil

            shutil.rmtree(profile_directory)
        self.send_json({"ok": True})


def main() -> None:
    parser = argparse.ArgumentParser(description="Codex TokenAPI 多实例本地控制台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    arguments = parser.parse_args()
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    PROFILES_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    address = f"http://{arguments.host}:{arguments.port}/"
    print(f"Codex Multi Launcher: {address}")
    print(f"数据目录: {DATA_ROOT}")
    if arguments.open:
        threading.Timer(0.35, lambda: webbrowser.open(address)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
