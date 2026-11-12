import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";

export type ReviewDecision = { action: "here" | "fresh" | "revise"; feedback?: string };
export const REVIEW_OPTIONS = [
  { action: "here", label: "Execute in current session" },
  { action: "fresh", label: "Execute in fresh session" },
  { action: "revise", label: "Revise" },
] as const;
export const REVIEW_TITLE = "Approve this plan? Esc closes";
const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";

/** One interaction owns one input. Native Input handles editing, Unicode and cursor rendering. */
export class ReviewDialog implements Component, Focusable {
  private selected = 0;
  private hasFocus = false;
  private closed = false;
  private paste: string | undefined;
  private input: Input;
  private theme: Pick<Theme, "fg">;
  private keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  private done: (value: ReviewDecision | undefined) => void;
  private requestRender: () => void;
  private signal: AbortSignal;
  private abort = () => this.finish(undefined);

  constructor(theme: Pick<Theme, "fg">, keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    done: (value: ReviewDecision | undefined) => void, requestRender: () => void, signal: AbortSignal) {
    this.theme = theme; this.keys = keys; this.done = done; this.requestRender = requestRender; this.signal = signal;
    this.input = new Input({ prompt: "", placeholder: "Type revision notes, or press Enter to continue in chat", placeholderStyle: s => this.theme.fg("dim", s) });
    this.input.onSubmit = () => this.finish({ action: "revise", feedback: this.input.getValue() });
    this.input.onEscape = this.abort;
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus() { this.input.focused = this.hasFocus && this.selected === 2 && !this.closed; }
  private finish(value: ReviewDecision | undefined) {
    if (this.closed) return;
    this.closed = true;
    this.dispose(); this.updateFocus(); this.done(value);
  }
  dispose() { this.signal.removeEventListener("abort", this.abort); this.closed = true; this.input.focused = false; }
  invalidate() { this.input.invalidate(); }
  private refresh() { this.updateFocus(); this.invalidate(); this.requestRender(); }

  handleInput(data: string): void {
    if (this.closed) return;
    // Buffer paste before interpreting Enter or Escape as menu actions. Keep word boundaries on a single line.
    if (this.paste !== undefined || data.includes(PASTE_START)) {
      if (this.paste === undefined) {
        const start = data.indexOf(PASTE_START);
        const before = data.slice(0, start);
        if (before) this.handleInput(before);
        if (this.closed) return;
        this.paste = ""; data = data.slice(start + PASTE_START.length);
      }
      this.selected = 2;
      this.paste += data;
      const end = this.paste.indexOf(PASTE_END);
      if (end >= 0) {
        const value = this.paste.slice(0, end).replace(/\r\n|\r|\n/g, " ");
        const remaining = this.paste.slice(end + PASTE_END.length);
        this.paste = undefined;
        this.input.handleInput(PASTE_START + value + PASTE_END);
        if (remaining) this.handleInput(remaining);
      }
      this.refresh(); return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) { this.finish(undefined); return; }
    const editing = !!this.input.getValue().trim();
    if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
      // Unsent feedback cannot accidentally approve the old plan. Clear it to choose execution again.
      if (!editing) this.selected = (this.selected + (this.keys.matches(data, "tui.select.up") ? 2 : 1)) % 3;
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (editing || this.selected === 2) this.finish({ action: "revise", feedback: this.input.getValue() });
      else this.finish({ action: REVIEW_OPTIONS[this.selected].action });
      return;
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.selected = 2;
    }
    this.refresh();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const editing = !!this.input.getValue().trim();
    const lines = [this.theme.fg("border", "─".repeat(width)), this.theme.fg("accent", REVIEW_TITLE), ""];
    REVIEW_OPTIONS.forEach((option, i) => {
      const prefix = `${i === this.selected ? "→ " : "  "}${option.label}${i === 2 ? ": " : ""}`;
      if (i === 2 && this.selected === 2) {
        const label = this.theme.fg("accent", prefix);
        const available = width - visibleWidth(prefix);
        if (available >= 2) lines.push(label + this.input.render(available)[0]);
        else lines.push(label, ...this.input.render(width));
      } else {
        lines.push(this.theme.fg(editing && i !== 2 ? "dim" : i === this.selected ? "accent" : "text",
          prefix + (i === 2 ? "Type revision notes, or press Enter" : "")));
      }
    });
    const enter = this.keys.getKeys("tui.select.confirm").join("/"), cancel = this.keys.getKeys("tui.select.cancel").join("/");
    lines.push("", this.theme.fg("dim", editing
      ? `${enter} send revision notes · clear text to execute · ${cancel} close without sending`
      : `↑↓ select · ${enter} confirm · type to revise · ${cancel} close`), this.theme.fg("border", "─".repeat(width)));
    return lines.map(line => truncateToWidth(line, width));
  }
}

export async function selectReview(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<ReviewDecision | undefined> {
  if (signal.aborted) return undefined;
  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select(REVIEW_TITLE, REVIEW_OPTIONS.map(o => o.label), { signal });
    const option = REVIEW_OPTIONS.find(o => o.label === choice);
    return option ? { action: option.action } : undefined;
  }
  return ctx.ui.custom<ReviewDecision | undefined>((tui, theme, keys, done) =>
    new ReviewDialog(theme, keys, done, () => tui.requestRender(), signal),
  { blocked: { kind: "permission", message: "Review the plan or enter revision notes" } });
}
