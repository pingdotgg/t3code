import type { ThreadExtensionState } from "@t3tools/contracts";

import { proposedPlanTitle } from "../proposedPlan";
import type { Project, Thread } from "../types";

export interface ThreadMarkdownExportInput {
  readonly thread: Thread;
  readonly project?: Pick<Project, "id" | "title" | "workspaceRoot"> | null;
  readonly workspaceRoot?: string | null | undefined;
  readonly extensionState?: ThreadExtensionState | null | undefined;
}

function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSerialize);
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

function metadata(label: string, value: string | null | undefined): string {
  return `- ${label}: ${value && value.trim().length > 0 ? value : "n/a"}`;
}

function messagesSection(thread: Thread): string {
  if (thread.messages.length === 0) return "None.";
  return thread.messages
    .map((message, index) => {
      const messageAttachments = message.attachments ?? [];
      const attachments =
        messageAttachments.length === 0
          ? ["Attachments: none"]
          : [
              "Attachments:",
              ...messageAttachments.map((attachment) =>
                [
                  `- Type: ${attachment.type}`,
                  `  Name: ${attachment.name}`,
                  `  MIME type: ${attachment.mimeType}`,
                  `  Size bytes: ${String(attachment.sizeBytes)}`,
                ].join("\n"),
              ),
            ];
      return [
        `### Message ${index + 1}`,
        metadata("Role", message.role),
        metadata("Message ID", message.id),
        metadata("Timestamp", message.createdAt),
        metadata("Turn ID", message.turnId ?? null),
        ...attachments,
        "Body:",
        "```md",
        message.text,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function plansSection(thread: Thread): string {
  if (thread.proposedPlans.length === 0) return "None.";
  return thread.proposedPlans
    .map((plan, index) =>
      [
        `### Plan ${index + 1}: ${proposedPlanTitle(plan.planMarkdown) ?? "Untitled plan"}`,
        metadata("Plan ID", plan.id),
        metadata("Created", plan.createdAt),
        metadata("Updated", plan.updatedAt),
        metadata("Turn ID", plan.turnId ?? null),
        metadata("Implemented At", plan.implementedAt),
        metadata("Implementation Thread ID", plan.implementationThreadId),
        "Body:",
        "```md",
        plan.planMarkdown,
        "```",
      ].join("\n"),
    )
    .join("\n\n");
}

function jsonSection(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${stablePrettyJson(value)}\n\`\`\``;
}

export function buildThreadMarkdownExport(input: ThreadMarkdownExportInput): string {
  const latestTurn = input.thread.latestTurn;
  const latestTurnSummary = latestTurn
    ? [
        `turn=${latestTurn.turnId}`,
        `state=${latestTurn.state}`,
        `requestedAt=${latestTurn.requestedAt}`,
        `startedAt=${latestTurn.startedAt ?? "n/a"}`,
        `completedAt=${latestTurn.completedAt ?? "n/a"}`,
        `assistantMessageId=${latestTurn.assistantMessageId ?? "n/a"}`,
      ].join("; ")
    : null;

  return [
    `# ${input.thread.title}`,
    "",
    "## Metadata",
    "",
    metadata("Thread ID", input.thread.id),
    metadata("Environment ID", input.thread.environmentId),
    metadata("Project ID", input.project?.id ?? input.thread.projectId),
    metadata("Project name", input.project?.title),
    metadata("Project cwd", input.project?.workspaceRoot),
    metadata("Branch", input.thread.branch),
    metadata("Worktree path", input.thread.worktreePath),
    metadata("Workspace root", input.workspaceRoot ?? input.thread.worktreePath),
    metadata("Provider instance", input.thread.modelSelection.instanceId),
    metadata("Model", input.thread.modelSelection.model),
    metadata(
      "Model options",
      input.thread.modelSelection.options
        ? stablePrettyJson(input.thread.modelSelection.options)
        : null,
    ),
    metadata("Runtime mode", input.thread.runtimeMode),
    metadata(
      "Interaction mode",
      input.extensionState?.interactionModeOverride ?? input.thread.interactionMode,
    ),
    metadata("Session status", input.thread.session?.status),
    metadata("Created At", input.thread.createdAt),
    metadata("Updated At", input.thread.updatedAt),
    metadata("Archived At", input.thread.archivedAt),
    metadata("Latest turn summary", latestTurnSummary),
    "",
    "## Messages",
    "",
    messagesSection(input.thread),
    "",
    "## Proposed Plans",
    "",
    plansSection(input.thread),
    "",
    jsonSection("Checkpoints", input.thread.checkpoints),
    "",
    jsonSection("Activities", input.thread.activities),
    "",
    jsonSection(
      "Turn Queue",
      input.extensionState?.queue ?? { items: [], status: "unavailable", pauseReason: null },
    ),
    "",
  ].join("\n");
}

export function threadMarkdownFilename(title: string, threadId: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 80);
  return `${slug || "thread"}-${threadId.slice(0, 8)}.md`;
}

export function downloadThreadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
