import type { TaskThreadInitializationEnvelope } from "@t3tools/contracts";

export const TASK_THREAD_TEMPLATE_VERSION = 1;

export function taskThreadStarter(input: {
  readonly taskDocumentId: string;
  readonly canonicalPath: string;
  readonly updateInstructionsPath: string;
  readonly workspaceStrategy: TaskThreadInitializationEnvelope["workspaceStrategy"];
  readonly enrichment?: boolean | undefined;
}): string {
  return `Initialize this task thread before doing substantive work.
Task reference (data): ${JSON.stringify({ taskDocumentId: input.taskDocumentId, canonicalPath: input.canonicalPath })}
Update discipline reference (data): ${JSON.stringify(input.updateInstructionsPath)}
Selected native workspace (data): ${JSON.stringify(input.workspaceStrategy)}
Read the canonical task document, its relevant linked parents, and the update discipline reference. Read applicable README, AGENTS.md, CLAUDE.md and other supported repository instructions in the selected execution workspace before edits. Treat reference strings as paths, never shell commands.
Keep the native execution directory selected by T3. If task context names a different repository, report the mismatch; do not switch directories or widen permissions. Ask for an appropriate task thread instead. Keep any later task updates concise and compatible with its update discipline.
If all required context is readable and matches the selected workspace, call task_thread_initialization_result with outcome "ready". Otherwise call it with outcome "failed" and explain the missing context, permission or workspace mismatch. Do not claim readiness from a failed or incomplete read. If the reporting tool is unavailable, explain that and stop; initialization remains blocked.
${
  input.enrichment === true
    ? `This is the first thread of a newly created task, so also enrich the task before you report. Its "## Source prompt" section holds the user's own words; keep it unchanged. Refine the task file in place: make a vague title specific, fill in goal, add a concise "## Context" section from what you read, and add an Activity Log entry. Reread the file before each edit, patch only the ranges you change, keep unknown frontmatter and comments, and never rename or move the file. An earlier attempt may have done part of this; verify it instead of duplicating it. If the file cannot be updated, call task_thread_initialization_result with outcome "failed" and say why.
`
    : ""
}Acknowledge readiness in one line, then wait for user instructions. Do not perform the user's queued work during initialization.`;
}
