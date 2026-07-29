// @ts-nocheck
import type {
  ChatExportDetailSettings,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationQueuedTurn,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

const FILENAME_UNSAFE_PATTERN = /[^a-zA-Z0-9._-]+/g;
const BACKTICK_RUN_PATTERN = /`+/g;
const DEFAULT_EXPORT_DETAIL: ChatExportDetailSettings = {
  includeMetadata: true,
  includeToolCalls: true,
  includeDiffs: true,
  includePlans: true,
  includeQueuedTurns: true,
};

function stringifyMetadata(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

function formatTable(rows: ReadonlyArray<readonly [string, unknown]>): string {
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([field, value]) => `| ${field} | ${formatValue(value).replaceAll("|", "\\|")} |`),
  ].join("\n");
}

function fenceMarkdown(value: string, language = ""): string {
  const longestBacktickRun = Math.max(
    2,
    ...Array.from(value.matchAll(BACKTICK_RUN_PATTERN), (match) => match[0]?.length ?? 0),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function formatModelSelection(thread: OrchestrationThread): string {
  const options =
    thread.modelSelection.options && thread.modelSelection.options.length > 0
      ? ` options=${JSON.stringify(thread.modelSelection.options)}`
      : "";
  return `${thread.modelSelection.instanceId}/${thread.modelSelection.model}${options}`;
}

export function createThreadMarkdownExportFilename(input: {
  readonly title: string;
  readonly exportedAt: Date;
}): string {
  const timestamp = input.exportedAt
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const slug = input.title
    .trim()
    .toLowerCase()
    .replace(FILENAME_UNSAFE_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "chat"}-${timestamp}.md`;
}

function formatSession(session: OrchestrationSession | null): string {
  if (!session) {
    return "_No active session metadata._";
  }
  return formatTable([
    ["Status", session.status],
    ["Provider", session.providerName],
    ["Provider instance", session.providerInstanceId],
    ["Runtime mode", session.runtimeMode],
    ["Active turn", session.activeTurnId],
    ["Updated", session.updatedAt],
    ["Last error", session.lastError],
    ["Resume cursor", stringifyMetadata(session.resumeCursor)],
  ]);
}

function formatAttachments(message: OrchestrationMessage): string {
  if (!message.attachments || message.attachments.length === 0) {
    return "";
  }
  const rows = message.attachments.map(
    (attachment) =>
      `| ${attachment.id} | ${attachment.name.replaceAll("|", "\\|")} | ${attachment.mimeType} | ${attachment.sizeBytes} |`,
  );
  return [
    "",
    "Attachments:",
    "",
    "| ID | Name | MIME type | Size bytes |",
    "| --- | --- | --- | ---: |",
    ...rows,
  ].join("\n");
}

function formatMessage(message: OrchestrationMessage, index: number): string {
  return [
    `#### ${index + 1}. ${message.role}`,
    "",
    formatTable([
      ["Message ID", message.id],
      ["Turn ID", message.turnId],
      ["Created", message.createdAt],
      ["Updated", message.updatedAt],
      ["Streaming", message.streaming],
    ]),
    formatAttachments(message),
    "",
    fenceMarkdown(message.text || "_No text content._", "markdown"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * A workspace handoff spans two turns because the provider must restart in the
 * new checkout, but the move is one event. Render the marker as a transition
 * and drop the continuation that carries it: its text is fixed T3 boilerplate,
 * so exporting it as a user turn reproduces exactly the message the chat UI
 * hides. Continuations still queued (including failed ones) are untouched here
 * and stay in the queued-turns section for recovery context.
 */
function isHandoffContinuation(message: OrchestrationMessage): boolean {
  return message.origin?.kind === "workspace-handoff" && message.origin.role === "continuation";
}

function isHandoffMarker(message: OrchestrationMessage): boolean {
  return message.origin?.kind === "workspace-handoff" && message.origin.role === "marker";
}

function formatWorkspaceHandoff(message: OrchestrationMessage): string {
  const origin = message.origin;
  return [
    "### Workspace moved",
    "",
    formatTable([
      ["Branch", origin?.kind === "workspace-handoff" ? origin.branch : null],
      ["Worktree path", origin?.kind === "workspace-handoff" ? origin.worktreePath : null],
      ["Message ID", message.id],
      ["Created", message.createdAt],
    ]),
  ].join("\n");
}

function groupMessagesByTurn(messages: ReadonlyArray<OrchestrationMessage>): Array<{
  readonly turnId: TurnId | null;
  readonly messages: OrchestrationMessage[];
}> {
  const groups: Array<{ turnId: TurnId | null; messages: OrchestrationMessage[] }> = [];
  for (const message of messages) {
    const lastGroup = groups.at(-1);
    if (lastGroup && lastGroup.turnId === message.turnId) {
      lastGroup.messages.push(message);
      continue;
    }
    groups.push({ turnId: message.turnId, messages: [message] });
  }
  return groups;
}

function formatCheckpoint(checkpoint: OrchestrationCheckpointSummary): string {
  const fileRows = checkpoint.turnFiles.length > 0 ? checkpoint.turnFiles : checkpoint.files;
  return [
    formatTable([
      ["Status", checkpoint.status],
      ["Completed", checkpoint.completedAt],
      ["Assistant message", checkpoint.assistantMessageId],
      ["Checkpoint ref", stringifyMetadata(checkpoint.checkpointRef)],
      ["Checkpoint turn count", checkpoint.checkpointTurnCount],
      ["Agent touched paths", checkpoint.agentTouchedPaths.join(", ")],
    ]),
    fileRows.length > 0
      ? [
          "",
          "| Path | Kind | + | - |",
          "| --- | --- | ---: | ---: |",
          ...fileRows.map(
            (file) =>
              `| ${file.path.replaceAll("|", "\\|")} | ${file.kind} | ${file.additions} | ${file.deletions} |`,
          ),
        ].join("\n")
      : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function formatPlans(plans: ReadonlyArray<OrchestrationProposedPlan>): string {
  if (plans.length === 0) {
    return "_No proposed plans._";
  }
  return plans
    .map((plan, index) =>
      [
        `### Plan ${index + 1}: ${plan.id}`,
        "",
        formatTable([
          ["Turn ID", plan.turnId],
          ["Created", plan.createdAt],
          ["Updated", plan.updatedAt],
          ["Implemented", plan.implementedAt],
          ["Implementation thread", plan.implementationThreadId],
        ]),
        "",
        fenceMarkdown(plan.planMarkdown, "markdown"),
      ].join("\n"),
    )
    .join("\n\n");
}

function formatQueuedTurns(
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn> | undefined,
): string {
  if (!queuedTurns || queuedTurns.length === 0) {
    return "_No queued turns._";
  }
  return queuedTurns
    .map((turn, index) =>
      [
        `### Queued turn ${index + 1}: ${turn.id}`,
        "",
        formatTable([
          ["Thread ID", turn.threadId],
          ["Created", turn.createdAt],
          ["Updated", turn.updatedAt],
          ["Failed", turn.failedAt],
          ["Failure message", turn.failureMessage],
          ["Runtime mode", turn.runtimeMode],
          ["Interaction mode", turn.interactionMode],
          ["Model selection", stringifyMetadata(turn.modelSelection)],
          // Kept rather than hidden: a failed handoff continuation is the
          // recovery context for a thread stranded in a new worktree.
          ["Origin", stringifyMetadata(turn.origin)],
          ["Source proposed plan", stringifyMetadata(turn.sourceProposedPlan)],
          ["Attachment count", turn.message.attachments.length],
        ]),
        "",
        fenceMarkdown(turn.message.text || "_No text content._", "markdown"),
      ].join("\n"),
    )
    .join("\n\n");
}

function formatActivities(activities: ReadonlyArray<OrchestrationThreadActivity>): string {
  if (activities.length === 0) {
    return "_No activity records._";
  }
  return [
    "| ID | Turn ID | Kind | Tone | Summary | Created |",
    "| --- | --- | --- | --- | --- | --- |",
    ...activities.map(
      (activity) =>
        `| ${activity.id} | ${formatValue(activity.turnId)} | ${activity.kind.replaceAll("|", "\\|")} | ${activity.tone} | ${activity.summary.replaceAll("|", "\\|")} | ${activity.createdAt} |`,
    ),
  ].join("\n");
}

export function formatThreadMarkdownExport(input: {
  readonly thread: OrchestrationThread;
  readonly project: OrchestrationProjectShell | null;
  readonly exportedAt: Date;
  readonly detail?: ChatExportDetailSettings;
}): string {
  const { thread, project, exportedAt } = input;
  const detail = input.detail ?? DEFAULT_EXPORT_DETAIL;
  const checkpointsByTurnId = new Map(
    thread.checkpoints.map((checkpoint) => [checkpoint.turnId, checkpoint]),
  );
  const messageGroups = groupMessagesByTurn(
    thread.messages.filter((message) => !isHandoffContinuation(message)),
  );

  return [
    `# ${thread.title}`,
    "",
    `Exported at ${exportedAt.toISOString()}.`,
    "",
    ...(detail.includeMetadata
      ? [
          "## Thread metadata",
          "",
          formatTable([
            ["Thread ID", thread.id],
            ["Project ID", thread.projectId],
            ["Project title", project?.title],
            ["Project path", project?.workspaceRoot],
            ["Model", formatModelSelection(thread)],
            ["Runtime mode", thread.runtimeMode],
            ["Pending runtime mode", thread.pendingRuntimeMode],
            ["Interaction mode", thread.interactionMode],
            ["Branch", thread.branch],
            ["Worktree path", thread.worktreePath],
            ["Created", thread.createdAt],
            ["Updated", thread.updatedAt],
            ["Archived", thread.archivedAt],
            ["Latest turn", stringifyMetadata(thread.latestTurn)],
          ]),
          "",
          "## Session metadata",
          "",
          formatSession(thread.session),
          "",
        ]
      : []),
    ...(detail.includeQueuedTurns
      ? ["## Queued turns", "", formatQueuedTurns(thread.queuedTurns), ""]
      : []),
    ...(detail.includePlans
      ? ["## Proposed plans", "", formatPlans(thread.proposedPlans), ""]
      : []),
    ...(detail.includeToolCalls
      ? ["## Activity", "", formatActivities(thread.activities), ""]
      : []),
    "## Conversation",
    "",
    messageGroups.length === 0
      ? "_No messages._"
      : (() => {
          let turnNumber = 0;
          return messageGroups
            .map((group) => {
              // A marker carries no turn of its own, so it renders as a
              // transition between turns rather than consuming a turn number.
              if (group.messages.every(isHandoffMarker)) {
                return group.messages.map(formatWorkspaceHandoff).join("\n\n");
              }
              turnNumber += 1;
              const checkpoint = group.turnId ? checkpointsByTurnId.get(group.turnId) : undefined;
              return [
                `### Turn ${turnNumber}${group.turnId ? `: ${group.turnId}` : ": no turn id"}`,
                "",
                ...(detail.includeDiffs
                  ? [
                      checkpoint
                        ? formatCheckpoint(checkpoint)
                        : "_No checkpoint metadata for this turn._",
                      "",
                    ]
                  : []),
                ...group.messages.map((message, messageIndex) =>
                  isHandoffMarker(message)
                    ? formatWorkspaceHandoff(message)
                    : formatMessage(message, messageIndex),
                ),
              ].join("\n");
            })
            .join("\n\n");
        })(),
    "",
  ].join("\n");
}
