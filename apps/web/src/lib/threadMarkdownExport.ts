import type { DraftId } from "~/composerDraftStore";
import { proposedPlanTitle } from "~/proposedPlan";
import type { Project, Thread } from "~/types";

type RouteKind = "server" | "draft";

interface ThreadMarkdownExportInput {
  routeKind: RouteKind;
  thread: Thread;
  environmentId?: string | null | undefined;
  draftId?: DraftId | null | undefined;
  project?: Pick<Project, "id" | "name" | "cwd"> | null | undefined;
  workspaceRoot?: string | null | undefined;
}

function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSerialize);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, stableSerialize(nested)]));
  }
  return value;
}

function stablePrettyJson(value: unknown): string {
  return JSON.stringify(stableSerialize(value), null, 2);
}

function formatMetadataLine(label: string, value: string | null | undefined): string {
  return `- ${label}: ${value && value.trim().length > 0 ? value : "n/a"}`;
}

function formatAttachmentSection(message: Thread["messages"][number]): string[] {
  if (!message.attachments || message.attachments.length === 0) {
    return ["Attachments: none"];
  }

  return [
    "Attachments:",
    ...message.attachments.map((attachment) =>
      [
        `- Type: ${attachment.type}`,
        `  Name: ${attachment.name}`,
        `  MIME type: ${attachment.mimeType}`,
        `  Size bytes: ${String(attachment.sizeBytes)}`,
        `  Preview URL: ${attachment.previewUrl ?? "n/a"}`,
      ].join("\n"),
    ),
  ];
}

function formatLatestTurnSummary(thread: Thread): string | null {
  const latestTurn = thread.latestTurn;
  if (!latestTurn) {
    return null;
  }

  return [
    `turn=${latestTurn.turnId}`,
    `state=${latestTurn.state}`,
    `requestedAt=${latestTurn.requestedAt}`,
    `startedAt=${latestTurn.startedAt ?? "n/a"}`,
    `completedAt=${latestTurn.completedAt ?? "n/a"}`,
    `assistantMessageId=${latestTurn.assistantMessageId ?? "n/a"}`,
    latestTurn.sourceProposedPlan
      ? `sourcePlan=${latestTurn.sourceProposedPlan.threadId}/${latestTurn.sourceProposedPlan.planId}`
      : "sourcePlan=n/a",
  ].join("; ");
}

function formatMessagesSection(thread: Thread): string {
  if (thread.messages.length === 0) {
    return "None.\n";
  }

  return `${thread.messages
    .map((message, index) =>
      [
        `### Message ${index + 1}`,
        formatMetadataLine("Role", message.role),
        formatMetadataLine("Message ID", message.id),
        formatMetadataLine("Timestamp", message.createdAt),
        formatMetadataLine("Turn ID", message.turnId ?? null),
        ...formatAttachmentSection(message),
        "Body:",
        "```md",
        message.text,
        "```",
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

function formatPlansSection(thread: Thread): string {
  if (thread.proposedPlans.length === 0) {
    return "None.\n";
  }

  return `${thread.proposedPlans
    .map((plan, index) =>
      [
        `### Plan ${index + 1}: ${proposedPlanTitle(plan.planMarkdown) ?? "Untitled plan"}`,
        formatMetadataLine("Plan ID", plan.id),
        formatMetadataLine("Created", plan.createdAt),
        formatMetadataLine("Updated", plan.updatedAt),
        formatMetadataLine("Turn ID", plan.turnId ?? null),
        formatMetadataLine("Implemented At", plan.implementedAt),
        formatMetadataLine("Implementation Thread ID", plan.implementationThreadId),
        "Body:",
        "```md",
        plan.planMarkdown,
        "```",
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

function formatJsonSection(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${stablePrettyJson(value)}\n\`\`\`\n`;
}

export function buildThreadMarkdownExport(input: ThreadMarkdownExportInput): string {
  const metadataLines = [
    formatMetadataLine("Route kind", input.routeKind),
    formatMetadataLine("Thread title", input.thread.title),
    ...(input.routeKind === "server"
      ? [formatMetadataLine("Thread ID", input.thread.id)]
      : [formatMetadataLine("Draft ID", input.draftId ?? null)]),
    ...(input.routeKind === "server"
      ? [formatMetadataLine("Environment ID", input.environmentId ?? input.thread.environmentId)]
      : []),
    formatMetadataLine("Project ID", input.project?.id ?? input.thread.projectId),
    formatMetadataLine("Project name", input.project?.name),
    formatMetadataLine("Project cwd", input.project?.cwd),
    formatMetadataLine("Branch", input.thread.branch),
    formatMetadataLine("Worktree path", input.thread.worktreePath),
    formatMetadataLine("Workspace root", input.workspaceRoot ?? input.thread.worktreePath),
    formatMetadataLine("Model provider", input.thread.modelSelection.provider),
    formatMetadataLine("Model", input.thread.modelSelection.model),
    formatMetadataLine(
      "Model options",
      input.thread.modelSelection.options
        ? stablePrettyJson(input.thread.modelSelection.options)
        : null,
    ),
    formatMetadataLine("Runtime mode", input.thread.runtimeMode),
    formatMetadataLine("Interaction mode", input.thread.interactionMode),
    formatMetadataLine("Session status", input.thread.session?.status ?? null),
    formatMetadataLine("Orchestration status", input.thread.session?.orchestrationStatus ?? null),
    formatMetadataLine("Created At", input.thread.createdAt),
    formatMetadataLine("Updated At", input.thread.updatedAt ?? null),
    formatMetadataLine("Archived At", input.thread.archivedAt),
    formatMetadataLine("Latest turn summary", formatLatestTurnSummary(input.thread)),
  ];

  return [
    `# ${input.thread.title}`,
    "",
    "## Metadata",
    "",
    ...metadataLines,
    "",
    "## Messages",
    "",
    formatMessagesSection(input.thread).trimEnd(),
    "",
    "## Proposed Plans",
    "",
    formatPlansSection(input.thread).trimEnd(),
    "",
    formatJsonSection("Checkpoints", input.thread.turnDiffSummaries).trimEnd(),
    "",
    formatJsonSection("Activities", input.thread.activities).trimEnd(),
    "",
    formatJsonSection("Turn Queue", input.thread.turnQueue).trimEnd(),
    "",
  ].join("\n");
}
