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
cli = Path(os.environ["PLAN_TEST_CLI"]) if os.environ.get("PLAN_TEST_CLI") else REPO / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
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
    session_id = (WORK / ".fixture-session-id").read_text()
    return [row["data"] for _, rows in entries() if rows[0]["id"] == session_id for row in rows
            if row.get("type") == "custom" and row.get("customType") == "review-plan-state-v1"]


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

    initial_draft = states()[-1]["proposal"]["path"]
    request_count = len((WORK / ".fixture-requests.jsonl").read_text().splitlines())
    mark = command("/plan")
    wait("批准这一版计划", mark)
    send("\x1b[B"); send("\x1b[B")
    pump(0.2)
    checkpoint("inline-feedback-empty")
    mark = send("\r")
    wait("继续讨论并修改当前计划文件", mark)
    assert states()[-1]["mode"] == "planning"
    assert len((WORK / ".fixture-requests.jsonl").read_text().splitlines()) == request_count
    print("PASS: empty Enter on Continue editing returns to chat without a model request")
    mark = command("submitfile")
    wait("批准这一版计划", mark)
    send("\x1b[B"); send("\x1b[B")
    send("inline-feedback 补充逐项核对记录")
    pump(0.3)
    checkpoint("inline-feedback-input")
    mark = send("\r")
    wait("批准这一版计划", mark)
    pump(0.3)
    assert states()[-1]["mode"] == "ready"
    assert states()[-1]["proposal"]["path"] == initial_draft
    assert "并保留逐项核对记录" in Path(initial_draft).read_text()
    assert not states()[-1].get("approved") and not (WORK / "result.txt").exists()
    feedback_messages = [block["text"] for _, rows in entries() for row in rows if row.get("type") == "message"
                         and row.get("message", {}).get("role") == "user"
                         for block in row["message"].get("content", []) if isinstance(block, dict)
                         and block.get("type") == "text" and "修改要求：" in block["text"] and "inline-feedback" in block["text"]]
    assert len(feedback_messages) == 1
    print("PASS: inline Chinese feedback is sent once, revises the same draft, and returns to review without execution")
    request_count = len((WORK / ".fixture-requests.jsonl").read_text().splitlines())
    send("\x1b[B"); send("\x1b[B")
    send("不发送这段取消的修改意见")
    send("\x1b")
    pump(0.4)
    assert states()[-1]["mode"] == "ready"
    assert len((WORK / ".fixture-requests.jsonl").read_text().splitlines()) == request_count
    assert not (WORK / "result.txt").exists()
    print("PASS: Esc discards unsent inline feedback without executing or changing the plan")

    mark = command("/fixture-block-kickoff")
    wait("OFFLINE_KICKOFF_BLOCK_ARMED", mark)
    mark = command("/plan")
    wait("批准这一版计划", mark)
    mark = send("\r")
    wait("OFFLINE_KICKOFF_BLOCKED", mark)
    assert states()[-1]["mode"] == "ready"
    assert not (WORK / "result.txt").exists()
    checkpoint("kickoff-not-started")
    print("PASS: unstarted kickoff remains ready; no automatic execution")

    mark = command("/plan")
    wait("批准这一版计划", mark)
    mark = send("\r")
    wait("EXECUTION_COMPLETE", mark)
    assert (WORK / "result.txt").read_text() == "OK"
    assert states()[-1]["mode"] == "off"
    assert states()[-1].get("approved")
    original_draft = states()[-1]["proposal"]["path"]
    approved_a = states()[-1]["approved"]["path"]
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

    mark = command("reviseplan")
    wait("批准这一版计划", mark)
    send("\x1b")
    pump(0.3)
    assert states()[-1]["proposal"]["path"] == original_draft
    revised_body = Path(original_draft).read_text()
    assert "# 离线修订计划" in revised_body
    assert "# 离线测试计划" in Path(approved_a).read_text()
    assert len(list((AGENT / "plans").glob("*.draft.md"))) == 1
    print("PASS: real edit and empty submission reuse the current draft; approved A is unchanged")
    mark = send("\x1bp")
    wait("已退出规划", mark)
    assert states()[-1]["mode"] == "off"
    mark = command("/plan show")
    wait("离线修订计划", mark)
    mark = command("/plan export selected.md")
    wait("已导出", mark)
    assert (WORK / "selected.md").read_text() == revised_body
    checkpoint("current-plan-after-exit")
    print("PASS: Alt+P exits without execution; show/export select current B instead of approved A")
    mark = command("/plan start")
    wait("已进入规划", mark)
    mark = command("submitfile")
    wait("批准这一版计划", mark)
    send("\x1b")
    pump(0.3)
    assert states()[-1]["proposal"]["path"] == original_draft
    previous = len(entries())
    source_path = entries()[0][0]
    (WORK / "result.txt").unlink()
    mark = command("/fixture-mismatch")
    wait("OFFLINE_MISMATCH_ARMED", mark)
    mark = command("/plan fresh")
    wait("执行刚展示的计划", mark)
    mark = send("\r")
    wait("环境未保持一致", mark)
    assert not (WORK / "result.txt").exists()
    mark = command("/fixture-return")
    wait("计划待确认", mark)
    source_states = [row["data"] for path, rows in entries() if path == source_path for row in rows
                     if row.get("type") == "custom" and row.get("customType") == "review-plan-state-v1"]
    assert source_states[-1]["mode"] == "ready"
    assert not (WORK / "result.txt").exists()
    checkpoint("source-ready-after-failure")
    print("PASS: rejected fresh handoff keeps source ready without auto retry")
    mark = command("/plan fresh")
    wait("执行刚展示的计划", mark)
    mark = send("\r")
    wait("EXECUTION_COMPLETE", mark)
    assert (WORK / "result.txt").read_text() == "OK"
    # Pi may not persist a rejected child that never had a model turn.
    assert len(entries()) >= previous + 1
    assert any(path != source_path and rows[0].get("parentSession") == str(source_path)
               for path, rows in entries())
    checkpoint("fresh-handoff")
    print("PASS: fresh handoff succeeds after explicit retry from original session")

    mark = command("/reload")
    pump(2)
    assert states()[-1]["mode"] == "off"
    assert "批准这一版计划" not in plain(bytes(raw[mark:]))
    print("PASS: reload does not reopen old approval or restart execution")
    handoffs = [block["text"] for _, rows in entries() for row in rows if row.get("type") == "message"
                and row.get("message", {}).get("role") == "user"
                for block in row["message"].get("content", [])
                if isinstance(block, dict) and block.get("type") == "text" and block["text"].startswith("规划已结束")]
    assert len(handoffs) == 2
    assert all("先读取批准文件" not in body and "无需重复读取" in body for body in handoffs)
    assert all(body.count("## 1. 目标与范围") == 1 for body in handoffs)
    print("PASS: both execution handoffs contain one plan body and no mandatory reread")
    def as_text(message):
        content = message.get("content", [])
        return content if isinstance(content, str) else "".join(b.get("text", "") for b in content if b.get("type") == "text")
    def body_copies(messages, body):
        values = []
        for message in messages:
            content = message.get("content", [])
            if isinstance(content, str):
                values.append(content)
                continue
            for block in content:
                if block.get("type") == "text":
                    values.append(block["text"])
                elif block.get("type") == "toolCall":
                    args = block.get("arguments", {})
                    values += [value for value in [args.get("plan"), args.get("content")] if isinstance(value, str)]
        return sum(body in value for value in values)
    executions = []
    for row in (WORK / ".fixture-requests.jsonl").read_text().splitlines():
        request = json.loads(row)
        users = [m for m in request["messages"] if m.get("role") == "user" and not as_text(m).startswith("[PLAN MODE —")]
        if not users or not as_text(users[-1]).startswith("规划已结束"):
            continue
        authorization = as_text(users[-1])
        path = re.search(r"从批准快照恢复：([^\n]+)", authorization).group(1)
        body = Path(path).read_text()
        assert body_copies(request["messages"], body) == 1
        assert request["messages"][0]["role"] == "system"
        assert "范围、验收标准或关键假设变化时先暂停确认" in authorization
        executions.append({"session": request["session"], "path": path, "inline": body in authorization, "bodyCopies": 1})
    assert len(executions) == 6
    assert [e["inline"] for e in executions] == [False, False, False, True, True, True]
    artifact = os.environ.get("PLAN_TEST_ARTIFACT_DIR")
    if artifact:
        Path(artifact, "request-summary.json").write_text(json.dumps(executions, ensure_ascii=False, indent=2))
        shutil.copyfile(WORK / ".fixture-requests.jsonl", Path(artifact, "provider-requests.jsonl"))
    print("PASS: six actual provider requests retain the exact approved body once; raw handoffs remain complete")
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
