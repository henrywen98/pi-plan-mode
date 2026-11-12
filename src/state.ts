export const STATE = "review-plan-state-v1";
export const REVIEW = "review-plan-display-v1";
export const CONTEXT = "review-plan-context-v1";
export const SUBMIT = "plan_submit";

export interface PlanRef {
  id: string;
  path: string;
  hash: string;
  title: string;
}
export interface RuntimeChoice {
  provider: string;
  modelId: string;
  thinking: string;
}
export interface PlanState {
  version: 1;
  mode: "off" | "planning" | "ready";
  workflow?: string;
  proposal?: PlanRef;
  approved?: PlanRef;
  shown?: string;
  pendingRuntime?: RuntimeChoice;
  pendingKickoff?: string;
  handoffError?: string;
}
export const emptyState = (): PlanState => ({ version: 1, mode: "off" });
export const planning = (s: PlanState) => s.mode !== "off";

export function restoreState(entries: readonly unknown[]): PlanState {
  const last = entries.findLast((entry: any) => entry.type === "custom" && entry.customType === STATE) as any;
  if (!last) return emptyState();
  const s = last.data;
  if (!s || s.version !== 1 || !["off", "planning", "ready"].includes(s.mode)) {
    throw new Error("Unsupported plan state. Do not approve this session until its state is repaired.");
  }
  for (const ref of [s.proposal, s.approved]) {
    if (ref && (!/^[\w-]+$/.test(ref.id) || typeof ref.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.hash) || typeof ref.title !== "string")) {
      throw new Error("Invalid plan reference.");
    }
  }
  if (s.mode === "ready" && !s.proposal) throw new Error("Ready state has no plan.");
  if (s.pendingKickoff !== undefined && (typeof s.pendingKickoff !== "string" || !/^[a-f0-9]{64}$/.test(s.pendingKickoff) || s.mode !== "ready" || !s.approved)) {
    throw new Error("Invalid pending kickoff.");
  }
  return structuredClone(s);
}
