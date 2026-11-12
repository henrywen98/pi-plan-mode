import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { ReviewDialog, selectReview, type ReviewDecision } from "../src/review-ui.ts";

function dialog(keys = new KeybindingsManager(TUI_KEYBINDINGS), signal?: AbortSignal) {
  const controller = new AbortController(), results: (ReviewDecision | undefined)[] = [];
  let renders = 0;
  const view = new ReviewDialog({ fg: (_color, value) => value }, keys, result => results.push(result), () => renders++, signal ?? controller.signal);
  view.focused = true;
  return { view, results, controller, get renders() { return renders; } };
}
const down = "\x1b[B", up = "\x1b[A", enter = "\r";
function selectRevision(view: ReviewDialog) { view.handleInput(down); view.handleInput(down); }

test("review UI: execution choices retain their original positions", () => {
  const here = dialog(); here.view.handleInput(enter);
  assert.deepEqual(here.results, [{ action: "here" }]);
  const fresh = dialog(); fresh.view.handleInput(down); fresh.view.handleInput(enter);
  assert.deepEqual(fresh.results, [{ action: "fresh" }]);
});

test("review UI: empty Enter returns to conversation; text Enter submits feedback", () => {
  const blank = dialog(); selectRevision(blank.view); blank.view.handleInput(enter);
  assert.deepEqual(blank.results, [{ action: "revise", feedback: "" }]);
  const filled = dialog(); selectRevision(filled.view); filled.view.handleInput("先只做第一阶段。"); filled.view.handleInput(enter);
  assert.deepEqual(filled.results, [{ action: "revise", feedback: "先只做第一阶段。" }]);
});

test("review UI: typing moves focus to feedback and cannot accidentally approve", () => {
  const h = dialog(); h.view.handleInput("需要补充验收条件");
  h.view.handleInput(up); h.view.handleInput(enter);
  assert.deepEqual(h.results, [{ action: "revise", feedback: "需要补充验收条件" }]);
});

test("review UI: clearing feedback enables execution choices again", () => {
  const h = dialog(); h.view.handleInput("reconsider this"); h.view.handleInput("\x15");
  h.view.handleInput(up); h.view.handleInput(enter);
  assert.deepEqual(h.results, [{ action: "fresh" }]);
});

test("review UI: native editing removes a whole emoji", () => {
  const h = dialog(); selectRevision(h.view); h.view.handleInput("验证中文😊"); h.view.handleInput("\x7f"); h.view.handleInput(enter);
  assert.deepEqual(h.results, [{ action: "revise", feedback: "验证中文" }]);
});

for (const key of ["\x1b", "\x03"]) {
  test(`review UI: ${key === "\x1b" ? "Esc" : "Ctrl+C"} closes without sending typed feedback`, () => {
    const h = dialog(); h.view.handleInput("不要发送"); h.view.handleInput(key); h.view.handleInput(enter);
    assert.deepEqual(h.results, [undefined]);
  });
}

test("review UI: pasted line breaks become spaces and never act as confirmation keys", () => {
  const h = dialog(); selectRevision(h.view);
  h.view.handleInput("\x1b[200~first line\r\n第二行");
  h.view.handleInput("\nthird\x1b[20");
  assert.equal(h.results.length, 0);
  h.view.handleInput("1~");
  assert.equal(h.results.length, 0);
  h.view.handleInput(enter);
  assert.deepEqual(h.results, [{ action: "revise", feedback: "first line 第二行 third" }]);
});

test("review UI: paste followed by Enter submits once", () => {
  const h = dialog();
  h.view.handleInput("\x1b[200~保留当前范围\x1b[201~\r");
  h.view.handleInput(enter); h.controller.abort();
  assert.deepEqual(h.results, [{ action: "revise", feedback: "保留当前范围" }]);
});

test("review UI: abort invalidates a filled dialog and cleans up the listener", () => {
  const h = dialog(); h.view.handleInput("旧菜单中的意见"); h.controller.abort(); h.view.handleInput(enter);
  assert.deepEqual(h.results, [undefined]);
  const disposed = dialog(); disposed.view.dispose(); disposed.controller.abort(); disposed.view.handleInput(enter);
  assert.equal(disposed.results.length, 0);
});

test("review UI: a pre-aborted interaction immediately cancels", () => {
  const controller = new AbortController(); controller.abort();
  const h = dialog(undefined, controller.signal);
  assert.deepEqual(h.results, [undefined]);
});

test("review UI: focus reaches the native input cursor, including narrow layouts", () => {
  const h = dialog(); selectRevision(h.view); h.view.handleInput("中文宽字符😊".repeat(25));
  assert.ok(h.view.render(80).join("\n").includes(CURSOR_MARKER));
  for (const width of [1, 8, 16, 30, 80, 120]) {
    assert.ok(h.view.render(width).every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
  }
  h.view.focused = false;
  assert.ok(!h.view.render(80).join("\n").includes(CURSOR_MARKER));
  assert.deepEqual(h.view.render(0), []);
});

test("review UI: injected selection keybindings are honored", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+o" });
  const h = dialog(keys); h.view.handleInput("\x0e"); h.view.handleInput("\x0e"); h.view.handleInput("custom keys"); h.view.handleInput("\x0f");
  assert.deepEqual(h.results, [{ action: "revise", feedback: "custom keys" }]);
});

test("review UI: RPC keeps its existing select dialog", async () => {
  let customCalled = false;
  const ctx: any = { mode: "rpc", ui: { select: async (_title: string, items: string[]) => items[2], custom: () => { customCalled = true; } } };
  assert.deepEqual(await selectReview(ctx, new AbortController().signal), { action: "revise" });
  assert.equal(customCalled, false);
});
