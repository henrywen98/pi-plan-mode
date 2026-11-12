import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { digest, normalizePlan } from "./files.ts";
import { kickoff } from "./prompts.ts";
import { SUBMIT, type PlanRef } from "./state.ts";

// Hidden ownership metadata, not a second plan or a new approval state.
export const HANDOFF = "review-plan-handoff-v1";
export interface HandoffMarker {
  version: 1;
  messageId: string;
  requestHash: string;
  approvedId: string;
  approvedHash: string;
}
type Message = { role: string; content?: unknown; timestamp?: number; toolName?: string; isError?: boolean };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function userText(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.length !== 1) return undefined;
  const block: unknown = message.content[0];
  return object(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/** Only recognize the complete request produced by this version for this exact approval. */
export function approvedBody(ref: PlanRef, request: string): string | undefined {
  const prefix = kickoff(ref, "");
  if (!request.startsWith(prefix)) return undefined;
  const body = request.slice(prefix.length);
  try { normalizePlan(body); } catch { return undefined; }
  return digest(body) === ref.hash ? body : undefined;
}

function containsBody(message: Message, body: string): boolean {
  if (!["user", "assistant", "toolResult"].includes(message.role)) return false;
  if (message.role === "toolResult" && (message.isError !== false || message.toolName !== "read")) return false;
  if (typeof message.content === "string") return message.role === "user" && message.content.includes(body);
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block: unknown) => {
    if (!object(block)) return false;
    if (block.type === "text" && typeof block.text === "string") {
      return message.role === "toolResult" ? block.text === body : block.text.includes(body);
    }
    if (message.role !== "assistant" || block.type !== "toolCall" || !object(block.arguments)) return false;
    return (block.name === SUBMIT && block.arguments.plan === body) || (block.name === "write" && block.arguments.content === body);
  });
}

/** Project only our recorded handoff. Raw entries and unrelated messages remain unchanged. */
export function projectHandoff<T extends Message>(messages: T[], branch: readonly SessionEntry[], projection: SessionProjection, approved?: PlanRef): T[] {
  if (!approved) return messages;
  const entry = branch.findLast(e => e.type === "custom" && e.customType === HANDOFF);
  if (entry?.type !== "custom" || !object(entry.data) || entry.data.version !== 1
    || entry.data.approvedId !== approved.id || entry.data.approvedHash !== approved.hash
    || typeof entry.data.messageId !== "string") return messages;
  const marker = entry.data;
  const owner = projection.entries.find(e => e.sourceEntry.id === marker.messageId);
  if (owner?.messages.length !== 1) return messages;
  const original = owner.messages[0];
  const request = userText(original);
  if (!request || digest(request) !== marker.requestHash) return messages;
  const body = approvedBody(approved, request);
  if (!body) return messages;
  // A user may paste the exact request. Ambiguous ownership disables this optimization.
  const originals = branch.filter(e => e.type === "message" && userText(e.message) === request);
  if (originals.length !== 1 || originals[0].id !== marker.messageId) return messages;
  const matches = messages.flatMap((m, i) => userText(m) === request && m.timestamp === original.timestamp ? [i] : []);
  if (matches.length !== 1) return messages;
  const index = matches[0];
  if (!messages.slice(0, index).some(m => containsBody(m, body))) return messages;
  const short = kickoff(approved, body, true);
  return messages.map((m, i) => i !== index ? m : {
    ...m,
    content: typeof m.content === "string" ? short : [{ ...(m.content as Record<string, unknown>[])[0], text: short }],
  });
}
