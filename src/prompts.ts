import { SUBMIT, type PlanRef } from "./state.ts";

// Original wording. Workflow references and their licenses are recorded in NOTICE.
export function planPrompt(hasQuestionTool: boolean, draftPath?: string): string {
  return `[PLAN MODE — PLANNING, NOT APPROVED]
The user is planning and has not approved execution yet. Inspect the facts first, clarify material choices, and produce a complete plan for human review.
You cannot exit plan mode or approve the plan yourself. Chat replies such as "OK", "yes", or "continue" do not approve execution.
edit/write (including nested calls) may only modify the current plan file; all other files remain blocked. Bash, MCP, and other tools keep their existing permissions, but do not use them to implement early.
${draftPath
    ? `Current plan file: ${draftPath}\nRevise this single current plan. Use read to inspect sections, then use edit for targeted updates or write for a full rewrite. After editing, call ${SUBMIT}({}) alone to submit the file for review without resending the full text.`
    : `No current plan file yet. Call ${SUBMIT}({plan: "complete Markdown"}) alone once to create the plan; later revisions reuse the returned file.`}
Re-entering plan mode does not create a new draft. Continue editing the existing file for the same task; if the user switches to a different task, confirm the new scope first, then rewrite the current plan and remove outdated task content.
Use existing read and inspection tools to gather facts; follow workspace rules and do not install packages, publish, or modify business data during planning.
${hasQuestionTool
    ? "When a user decision is needed, you may use the existing ask_user_question tool. You decide whether and when to ask; follow the tool schema and do not force a questionnaire every turn."
    : "No interactive questionnaire tool is available; ask clarifying questions directly in chat and do not call unavailable tools."}
Verify facts you can check from the environment before asking. Confirm unknowns that affect scope, acceptance criteria, or approach instead of hiding them in default assumptions.

Start the document with a clear task title. By default, organize the plan into five sections and match the user's language:
1. Goals and Scope: Who has what problem, what outcome is needed, and what is in or out of scope.
2. Acceptance Criteria and Verification: For each item, state the expected result, how to verify it, and what evidence to keep. Define completion criteria before choosing the method.
3. Execution Plan: Describe what to do, why, and the order of dependencies by behavior or phase, mapped to acceptance items. Avoid file-by-file dumps and unrelated low-level details.
4. Assumptions and Stop Conditions: List only material unverified conditions, their basis, how to verify them, and what to do if they fail. Do not list confirmed requirements as assumptions.
5. Deliverables and References: List outputs, locations, and file paths or full URLs needed for handoff. Keep required constraints in the main text.

Write so someone who has not read the chat can understand the plan. Lead each paragraph with its conclusion, use clear subjects, and explain new terms. Keep simple tasks short instead of padding the five sections.
Define each condition in one place and reference it elsewhere. Distinguish confirmed requirements, proposed approaches, and unverified assumptions.
Distinguish acceptance criteria from verification methods. Do not write only "tests pass", and do not invent numbers. If there are no new assumptions, state that explicitly.
Once key decisions are settled, verify that the plan is complete and consistent across all five sections, then call ${SUBMIT} alone as the final tool call of the turn.
Submitting requests review; it does not approve execution. Ordinary discussion turns may end with plain text without asking a questionnaire or submitting a plan every turn.
When you receive feedback, update the current plan file while previous approvals remain disabled. Keep the complete plan in the file rather than a diff, then submit for review again without asking permission to re-propose first.
Both the plan and execution handoff must state: implementation methods may adjust, but pause and confirm first if scope, acceptance criteria, or key assumptions change.
Mark any item that cannot be verified as unverified; do not lower the completion bar to claim completion.`;
}

export const offPrompt = `[PLAN MODE — OFF]
Previous planning restrictions have ended. Follow current user instructions, project rules, and permissions; earlier plans are for reference only and do not authorize execution by themselves.
Only an explicit execution handoff request authorizes implementing an approved plan.`;

export function revisionRequest(feedback: string): string {
  return `Please revise the current plan without executing the task. Submit the updated plan for review when ready.\n\nRevision notes:\n${feedback}`;
}

export function kickoff(ref: PlanRef, body: string, inContext = false): string {
  return `Plan mode has ended. The user approved the ${inContext ? "frozen version in context" : "frozen version below"}; please execute and verify it.
The ${inContext ? "current context" : "section below"} already contains the full approved plan; execute it directly without re-reading the plan file or recalculating its hash. Do not follow later draft edits.
Recover from the approved snapshot only if compaction or context changes remove the plan body: ${ref.path}
Recovery digest (SHA-256): ${ref.hash}
Read project rules, source files, or reference materials as needed; they are not a second plan.
Follow existing project rules and permissions. You may adjust the implementation method, but pause and confirm first if scope, acceptance criteria, or key assumptions change.
Report expected results, actual results, and evidence for each item. Mark anything you cannot verify as unverified, and do not lower the bar on your own.

${inContext ? "" : body}`;
}
