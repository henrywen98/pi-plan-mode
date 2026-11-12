import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PlanRef } from "./state.ts";

export const MAX_BYTES = 50_000;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function normalizePlan(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("Plan must be nonempty Markdown.");
  const body = input.trim() + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`Plan exceeds ${MAX_BYTES} UTF-8 bytes.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) throw new Error("Plan contains terminal control characters.");
  return body;
}
export function titleOf(body: string): string {
  return (body.split("\n").find(line => line.trim()) ?? "Plan").replace(/^#+\s*/, "").slice(0, 180);
}

/** One editable draft; each approval remains a separate immutable execution snapshot. */
export class PlanFiles {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private check(path: string) {
    if (dirname(resolve(path)) !== this.root || !/^plan-[\w-]+\.(draft|approved)\.md$/.test(path.split(/[\\/]/).at(-1)!)) {
      throw new Error("Plan reference is outside this plugin's plan directory.");
    }
  }
  async read(ref: PlanRef, exact = false): Promise<string> {
    this.check(ref.path);
    const handle = await open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Plan is not a bounded regular file.");
      const text = await handle.readFile("utf8");
      normalizePlan(text);
      if (exact && digest(text) !== ref.hash) throw new Error("Approved plan changed. Review and approve a new version.");
      return text;
    } finally { await handle.close(); }
  }
  async canEdit(ref: PlanRef, path: unknown, cwd: string): Promise<boolean> {
    if (typeof path !== "string" || resolve(cwd, path) !== ref.path || !ref.path.endsWith(".draft.md")) return false;
    try {
      this.check(ref.path);
      const handle = await open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        return stat.isFile() && stat.nlink === 1;
      } finally { await handle.close(); }
    } catch (error) {
      // A missing current draft can be repaired, but aliases and other file types cannot.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  async update(ref: PlanRef, body: string, current: () => boolean): Promise<PlanRef> {
    normalizePlan(body);
    return withFileMutationQueue(ref.path, async () => {
      if (!current() || !(await this.canEdit(ref, ref.path, this.root))) throw new Error("Current draft is not writable.");
      const temporary = join(this.root, `.plan-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
        if (!(await this.canEdit(ref, ref.path, this.root)) || !current()) throw new Error("Planning changed during submission.");
        await rename(temporary, ref.path);
      } finally { await unlink(temporary).catch(() => {}); }
      return { ...ref, hash: digest(body), title: titleOf(body) };
    });
  }
  async create(body: string, kind: "draft" | "approved" = "draft"): Promise<PlanRef> {
    // Preserve the exact bytes shown by the reviewer when saving an approval.
    normalizePlan(body);
    const id = randomUUID();
    const path = join(this.root, `plan-${id}.${kind}.md`);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.plan-${id}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
    return { id, path, hash: digest(body), title: titleOf(body) };
  }
}
