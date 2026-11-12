import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HANDOFF, approvedBody, projectHandoff, userText } from "../src/handoff.ts";
import { digest, MAX_BYTES } from "../src/files.ts";
import { kickoff } from "../src/prompts.ts";
import { SUBMIT, type PlanRef } from "../src/state.ts";

const body = "# Exact plan\n\nCreate one result, then verify it.\n";
const ref: PlanRef = { id: "approved", path: "/plans/plan-approved.approved.md", hash: digest(body), title: "Exact plan" };
const user = (content: any, timestamp = 2): any => ({ role: "user", content, timestamp });
const assistant = (content: any): any => ({ role: "assistant", content, timestamp: 1 });
const plain = (value: string) => ({ type: "text", text: value });
function setup(source?: any, marked = true) {
  const sm = SessionManager.inMemory();
  if (source) sm.appendMessage(source);
  const request = kickoff(ref, body);
  const messageId = sm.appendMessage(user([plain(request)]));
  if (marked) sm.appendCustomEntry(HANDOFF, { version: 1, messageId, requestHash: digest(request), approvedId: ref.id, approvedHash: ref.hash });
  const projection = sm.buildSessionProjection();
  const messages: any[] = [{ role: "system", content: "KEEP SYSTEM AND TOOLS", timestamp: 0 }, ...projection.messages];
  return { sm, request, messageId, projection, messages };
}
function project(f: ReturnType<typeof setup>, messages = f.messages, approved = ref) {
  return projectHandoff(messages, f.sm.getBranch(), f.sm.buildSessionProjection(), approved);
}

const complete = [
  ["user text", user(`Earlier plan:\n${body}`, 1)],
  ["assistant text", assistant([plain(body)])],
  ["plan submission", assistant([{ type: "toolCall", name: SUBMIT, arguments: { plan: body } }])],
  ["full write", assistant([{ type: "toolCall", name: "write", arguments: { path: "/plans/plan-draft.draft.md", content: body } }])],
  ["full read", { role: "toolResult", toolName: "read", isError: false, content: [plain(body)], timestamp: 1 }],
] as const;
for (const [name, source] of complete) {
  test(`handoff projection: reuses ${name} without changing raw records`, () => {
    const f = setup(source), original = JSON.stringify(f.messages), raw = JSON.stringify(f.sm.getBranch());
    const result = project(f);
    assert.equal(userText(result.at(-1)!), kickoff(ref, body, true));
    assert.equal(result[0], f.messages[0]); assert.equal(result[1], f.messages[1]);
    assert.equal(JSON.stringify(f.messages), original); assert.equal(JSON.stringify(f.sm.getBranch()), raw);
    assert.equal(project(f, result), result, "Projection is idempotent.");
    assert.match(userText(result.at(-1)!)!, /不要跟随草稿后续修改/);
    assert.match(userText(result.at(-1)!)!, /范围、验收标准或关键假设变化时先暂停确认/);
  });
}

const incomplete = [
  ["title, path and hash", user(`${ref.title}\n${ref.path}\n${ref.hash}`, 1)],
  ["old revision", assistant([plain(body.replace("one result", "two results"))])],
  ["truncated read", { role: "toolResult", toolName: "read", isError: false, content: [plain(body.slice(0, -8) + "[truncated]")], timestamp: 1 }],
  ["failed read", { role: "toolResult", toolName: "read", isError: true, content: [plain(body)], timestamp: 1 }],
  ["read with unknown success status", { role: "toolResult", toolName: "read", content: [plain(body)], timestamp: 1 }],
  ["unknown tool output", { role: "toolResult", toolName: "custom", isError: false, content: [plain(body)], timestamp: 1 }],
  ["unknown tool arguments", assistant([{ type: "toolCall", name: "custom", arguments: { plan: body } }])],
  ["split blocks", assistant([plain(body.slice(0, 12)), plain(body.slice(12))])],
  ["thinking block", assistant([{ type: "thinking", thinking: body }])],
] as const;
for (const [name, source] of incomplete) {
  test(`handoff projection: ${name} does not justify omitting the body`, () => {
    const f = setup(source);
    assert.equal(project(f), f.messages);
  });
}

test("handoff projection: summaries and system text are not an authoritative plan copy", () => {
  const f = setup();
  for (const message of [
    { role: "compactionSummary", content: body, timestamp: 1 },
    { role: "custom", customType: "summary", content: body, timestamp: 1 },
    { role: "system", content: body, timestamp: 1 },
  ]) {
    const messages = [message, ...f.messages];
    assert.equal(project(f, messages), messages);
  }
});

test("handoff projection: unmarked and ambiguous user copies stay untouched", () => {
  const unmarked = setup(user(body, 1), false);
  assert.equal(project(unmarked), unmarked.messages);
  const f = setup(user(body, 1));
  f.sm.appendMessage(user([plain(f.request)], 3));
  const messages = f.sm.buildSessionProjection().messages;
  assert.equal(project(f, messages), messages);
});

test("handoff projection: stale approval and changed or omitted owner keep the request unchanged", () => {
  const f = setup(user(body, 1));
  assert.equal(project(f, f.messages, { ...ref, id: "another" }), f.messages);
  assert.equal(project(f, f.messages, { ...ref, hash: digest("other") }), f.messages);
  const changed = f.messages.map(m => userText(m) === f.request ? user(`Quoted, not an approval:\n${f.request}`) : m);
  assert.equal(project(f, changed), changed);
  f.sm.appendContextEdit(f.messageId, null);
  assert.equal(project(f), f.messages, "A source removed by context edits must not be inferred from raw history.");
});

test("handoff projection: removed candidate or later copies do not permit omission", () => {
  const f = setup(user(body, 1));
  const withoutSource = f.messages.filter((_, i) => i !== 1);
  assert.equal(project(f, withoutSource), withoutSource);
  const laterCopy = [...withoutSource, assistant([plain(body)])];
  assert.equal(project(f, laterCopy), laterCopy);
});

test("handoff projection: ambiguous filtered owners and image-bearing messages stay untouched", () => {
  const f = setup(user(body, 1));
  const duplicated = [...f.messages, f.messages.at(-1)];
  assert.equal(project(f, duplicated), duplicated);
  const images = f.messages.map(m => userText(m) === f.request ? { ...m, content: [...m.content, { type: "image", data: "fixture", mimeType: "image/png" }] } : m);
  assert.equal(project(f, images), images);
});

test("handoff projection: unknown or malformed ownership metadata keeps the complete handoff", () => {
  for (const patch of [{ version: 2 }, { messageId: "missing" }, { requestHash: "wrong" }, { approvedId: "other" }, { approvedHash: "wrong" }]) {
    const f = setup(user(body, 1));
    f.sm.appendCustomEntry(HANDOFF, { version: 1, messageId: f.messageId, requestHash: digest(f.request), approvedId: ref.id, approvedHash: ref.hash, ...patch });
    assert.equal(project(f), f.messages);
  }
});

test("handoff projection: rejects altered, oversized and invalid request bodies", () => {
  assert.equal(approvedBody(ref, kickoff(ref, body)), body);
  assert.equal(approvedBody(ref, kickoff(ref, body, true)), undefined);
  assert.equal(approvedBody(ref, kickoff(ref, body.replace("one", "two"))), undefined);
  for (const invalid of ["", "\u001b[31m", "x".repeat(MAX_BYTES + 1)]) {
    const invalidRef = { ...ref, hash: digest(invalid) };
    assert.equal(approvedBody(invalidRef, kickoff(invalidRef, invalid)), undefined);
  }
});
