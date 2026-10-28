#!/usr/bin/env python3
"""Update gpclient-raycast-progress.json from bash helpers and the connect watcher."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from typing import Any

def load(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save(path: str, data: dict[str, Any]) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="gp-progress-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def set_step(data: dict[str, Any], step_id: str, status: str) -> bool:
    if data.get("status") == "succeeded" and status != "failed":
        return False
    steps = data.get("steps") or []
    for index, step in enumerate(steps):
        if step.get("id") != step_id:
            continue
        previous = step.get("status")
        if previous == "done" and status == "active":
            return False
        if previous == status:
            return False
        if previous == "failed":
            return False
        step["status"] = status
        if status == "done":
            for later in steps[index + 1 :]:
                if later.get("status") == "pending":
                    later["status"] = "active"
                    break
        if status == "failed":
            data["status"] = "failed"
            data["finishedAt"] = int(time.time() * 1000)
        return True
    return False


def succeed(data: dict[str, Any]) -> None:
    data["status"] = "succeeded"
    data["finishedAt"] = int(time.time() * 1000)
    for step in data.get("steps") or []:
        if step.get("status") in ("pending", "active"):
            step["status"] = "done"


def fail(data: dict[str, Any], message: str) -> None:
    data["status"] = "failed"
    data["error"] = message
    data["finishedAt"] = int(time.time() * 1000)
    for step in data.get("steps") or []:
        if step.get("status") == "active":
            step["status"] = "failed"
            break


def session_alive(path: str) -> bool:
    try:
        raw = open(path, encoding="utf-8").read().strip()
        pid = int(raw)
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


FATAL_LOG_MARKERS = (
    "already running",
    "Cannot find gateway specified",
    "a password is required",
    "no tty present",
    "Failed to connect to the gateway",
    # gpclient --no-auth-prompt refused to open a login window.
    "Sign-in required",
)

# What to do next, appended to the matching marker in the progress error.
FATAL_HINTS = {
    "Sign-in required": "The saved cookie was rejected. Use Sign in with SSO.",
}


def read_log(log_path: str, offset: int) -> str:
    """Only the current run: the reconnect log is appended across runs."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as handle:
            handle.seek(offset)
            return handle.read()
    except OSError:
        return ""


def watch(
    progress_path: str,
    log_path: str,
    session_path: str,
    timeout: float,
    offset: int = 0,
) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = load(progress_path)
        except OSError:
            time.sleep(0.5)
            continue
        if data.get("status") != "running":
            return
        log = read_log(log_path, offset)
        changed = False
        if "Using cached portal cookie" in log:
            changed = set_step(data, "portal", "active") or changed
        if "Cached-cookie getconfig" in log:
            changed = set_step(data, "portal", "done") or changed
        if "Gateway login with portal auth cookies succeeded" in log:
            changed = set_step(data, "gateway", "done") or changed
        if session_alive(session_path):
            set_step(data, "tunnel", "done")
            succeed(data)
            save(progress_path, data)
            return
        fatal = next((m for m in FATAL_LOG_MARKERS if m in log), None)
        if fatal:
            hint = FATAL_HINTS.get(fatal)
            fail(data, f"gpclient: {fatal}. {hint}" if hint else f"gpclient: {fatal}")
            save(progress_path, data)
            return
        if changed:
            save(progress_path, data)
        time.sleep(0.5)
    try:
        data = load(progress_path)
    except OSError:
        return
    if data.get("status") == "running":
        fail(data, "Timed out waiting for the tunnel")
        save(progress_path, data)


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(2)
    cmd = sys.argv[1]
    path = sys.argv[2]
    if cmd == "watch":
        log_path = sys.argv[3]
        session_path = sys.argv[4]
        timeout = float(sys.argv[5]) if len(sys.argv) > 5 else 60
        offset = int(sys.argv[6]) if len(sys.argv) > 6 else 0
        watch(path, log_path, session_path, timeout, offset)
        return
    data = load(path)
    if cmd == "set":
        set_step(data, sys.argv[3], sys.argv[4])
    elif cmd == "ok":
        succeed(data)
    elif cmd == "fail":
        fail(data, sys.argv[3] if len(sys.argv) > 3 else "failed")
    else:
        sys.exit(2)
    save(path, data)


if __name__ == "__main__":
    main()
