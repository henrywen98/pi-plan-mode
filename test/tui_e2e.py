"""Drive a real Pi TUI through a PTY, using deterministic local provider events."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[1]
ROOT = Path(tempfile.mkdtemp(prefix="pi-plan-tui-"))
AGENT = ROOT / "agent"
WORK = ROOT / "project"
AGENT.mkdir()
WORK.mkdir()
(AGENT / "settings.json").write_text(json.dumps({"lastChangelogVersion": "1.5.0", "quietStartup": True,
    "defaultProvider": "fixture", "defaultModel": "scripted", "defaultThinkingLevel": "medium",
    "compaction": {"enabled": False}, "retry": {"enabled": False}}))
(WORK / "AGENTS.md").write_text("Only use this temporary project. Never contact external services.\n")
cli = REPO / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
args = ["node", str(cli), "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
        "-e", str(REPO / "index.ts"), "-e", str(REPO / "test/fixture-extension.ts"),
        "--provider", "fixture", "--model", "scripted", "--thinking", "high"]
for env_key in ["PLAN_TEST_ASK_EXTENSION", "PLAN_TEST_FOOTER_EXTENSION"]:
    if os.environ.get(env_key):
        args += ["-e", os.environ[env_key]]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.environ["PI_CODING_AGENT_DIR"] = str(AGENT)
    os.environ["TERM"] = "xterm-256color"
    os.environ["NO_COLOR"] = "1"
    os.execvp(args[0], args)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))
raw = bytearray()
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[=>])")

def plain(data):
    return ANSI.sub("", data.decode("utf-8", errors="replace"))

def pump(seconds=0.15):
    end = time.time() + seconds
    while time.time() < end:
        readable, _, _ = select.select([fd], [], [], min(0.05, max(0, end-time.time())))
        if readable:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            raw.extend(data)
            # Terminal size / cursor queries have deterministic local responses.
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")


def wait(needle, start=0, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        pump()
        if needle in plain(bytes(raw[start:])):
            return
    raise AssertionError(f"Timed out waiting for {needle!r}:\n{plain(bytes(raw[-9000:]))}")


def send(value):
    start = len(raw)
    os.write(fd, value.encode())
    return start


def command(value):
    start = send("\x1b[200~" + value + "\x1b[201~")
    pump(0.15)
    send("\r")
    return start


def entries():
    result = []
    for path in (AGENT / "sessions").rglob("*.jsonl"):
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        result.append((path, rows))
    return result


def states():
    return [row["data"] for _, rows in entries() for row in rows if row.get("type") == "custom" and row.get("customType") == "review-plan-state-v1"]


def checkpoint(name):
    artifact = os.environ.get("PLAN_TEST_ARTIFACT_DIR")
    if artifact:
        target = Path(artifact)
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{name}.ansi").write_bytes(raw)
        (target / f"{name}.txt").write_text(plain(bytes(raw)))

try:
    wait("scripted")
    mark = command("/plan start")
    wait("已进入规划", mark)
    mark = command("prepareplan")
    wait("批准这一版计划", mark)
    checkpoint("ready-menu")
    send("\x1b")
    pump(0.6)
    assert states()[-1]["mode"] == "ready"
    assert not (WORK / "result.txt").exists()
    print("PASS: real submit opens review; Esc preserves ready plan without execution")

    mark = command("/plan")
    wait("批准这一版计划", mark)
    mark = send("\r")
    wait("EXECUTION_COMPLETE", mark)
    assert (WORK / "result.txt").read_text() == "OK"
    assert states()[-1]["mode"] == "off"
    assert states()[-1].get("approved")
    print("PASS: same-session approval runs write and verification")

    mark = command("/plan start")
    wait("已进入规划", mark)
    if os.environ.get("PLAN_TEST_ASK_EXTENSION"):
        mark = command("show question")
        wait("Which output should we use?", mark)
        checkpoint("existing-question-tool")
        mark = send("\r")
        wait("QUESTION_COMPLETE", mark)
        assert states()[-1]["mode"] == "planning"
        print("PASS: existing ask_user_question renders and accepts a selection")
        mark = command("show question")
        wait("Which output should we use?", mark)
        send("\x1b[B\x1b[B\r")
        pump(0.4)
        mark = send("custom-answer\r")
        wait("QUESTION_COMPLETE", mark)
        assert "custom-answer" in json.dumps(entries(), default=str)
        print("PASS: existing ask_user_question accepts free text")
        mark = command("show question")
        wait("Which output should we use?", mark)
        mark = send("\x1b")
        wait("QUESTION_COMPLETE", mark)
        content = json.dumps(entries(), default=str)
        assert "User declined to answer questions" in content
        print("PASS: existing ask_user_question cancellation does not approve or exit")

    mark = command("prepareplan")
    wait("批准这一版计划", mark)
    send("\x1b")
    pump(0.3)
    previous = len(entries())
    (WORK / "result.txt").unlink()
    mark = command("/plan fresh")
    wait("执行刚展示的计划", mark)
    mark = send("\r")
    wait("EXECUTION_COMPLETE", mark)
    assert (WORK / "result.txt").read_text() == "OK"
    assert len(entries()) == previous + 1
    assert any(rows[0].get("parentSession") for _, rows in entries())
    checkpoint("fresh-handoff")
    print("PASS: real new-session handoff retains original session and executes approved plan")

    mark = command("/reload")
    pump(2)
    assert states()[-1]["mode"] == "off"
    assert "批准这一版计划" not in plain(bytes(raw[mark:]))
    print("PASS: reload does not reopen old approval or restart execution")
    print("PASS: TUI E2E finished; no network model requests")
finally:
    checkpoint("final")
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        result, _ = os.waitpid(pid, os.WNOHANG)
        if result:
            break
        time.sleep(0.1)
    else:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
    if os.environ.get("PLAN_TEST_KEEP"):
        print(f"Local artifacts: {ROOT}")
    else:
        shutil.rmtree(ROOT)
