import type { PipelineRunStatus, PipelineRunStepStatus } from "@t3tools/contracts";

const MOVE_ELIGIBLE_STATE_TYPES: ReadonlySet<string> = new Set(["backlog", "triage", "unstarted"]);

/**
 * Launching only moves an issue forward from the not-yet-started states. Anything already started,
 * completed or canceled stays where the team put it.
 */
export function isStateMoveEligible(stateType: string): boolean {
  return MOVE_ELIGIBLE_STATE_TYPES.has(stateType);
}

const STEP_MARKS: Record<PipelineRunStepStatus, string> = {
  pending: "☐",
  running: "▶️",
  completed: "✅",
  failed: "❌",
  stopped: "⏸️",
  skipped: "⏭️",
  cancelled: "🚫",
};

export interface PipelineCommentInput {
  readonly pipelineName: string;
  readonly threadUrl: string;
  readonly runStatus: PipelineRunStatus;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly status: PipelineRunStepStatus }>;
}

/**
 * The thread URL comes from the launching client: only http(s) URLs become links, and parentheses
 * are escaped so the URL cannot close the Markdown link and inject its own.
 */
function linkTarget(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href.replace(/[()]/gu, (char) => (char === "(" ? "%28" : "%29"));
}

function headline(input: PipelineCommentInput): string {
  const failed = input.steps.find((step) => step.status === "failed");
  const stopped = input.steps.find((step) => step.status === "stopped");
  const running = input.steps.find((step) => step.status === "running");
  switch (input.runStatus) {
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "paused":
      if (failed !== undefined) return `Needs attention: "${failed.name}" failed`;
      if (stopped !== undefined) return `Paused: "${stopped.name}" was stopped`;
      return "Paused";
    case "running":
      return running === undefined ? "Running" : `Running: ${running.name}`;
  }
}

/**
 * The single issue comment a pipeline run keeps up to date. The output is a pure function of the
 * run's visible state, so unchanged runs produce byte-identical bodies and need no edit.
 */
export function renderPipelineCommentBody(input: PipelineCommentInput): string {
  const lines = input.steps.map((step) => `- ${STEP_MARKS[step.status]} ${step.name}`);
  const target = linkTarget(input.threadUrl);
  return [
    `**T3 Code pipeline "${input.pipelineName}"** (${headline(input)})`,
    "",
    ...lines,
    ...(target === null ? [] : ["", `[Open in T3 Code](${target})`]),
  ].join("\n");
}

/** Body of the one-off comment posted when a chat is started from an issue. */
export function renderChatCommentBody(input: {
  readonly viewerName: string;
  readonly threadTitle: string;
  readonly threadUrl: string;
}): string {
  // Brackets in a title would end the Markdown link text early.
  const title = input.threadTitle.replace(/[[\]]/gu, "");
  const target = linkTarget(input.threadUrl);
  return target === null
    ? `${input.viewerName} started a T3 Code chat: ${title}`
    : `${input.viewerName} started a T3 Code chat: [${title}](${target})`;
}

/** Body of the one static comment for a pipeline run on a machine without a matching Linear connection. */
export function renderRemotePipelineCommentBody(input: {
  readonly pipelineName: string;
  readonly machineName: string;
  readonly threadUrl: string;
}): string {
  // Both names come from another machine: one line each, and no brackets to forge a link or image.
  const plain = (value: string) => value.replace(/[[\]]/gu, "").replace(/\s+/gu, " ").trim();
  const target = linkTarget(input.threadUrl);
  const text = `**T3 Code pipeline "${plain(input.pipelineName)}"** started on ${plain(input.machineName)}`;
  return target === null ? text : `${text}\n\n[Open in T3 Code](${target})`;
}
