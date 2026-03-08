import type { OrchestrationProject, OrchestrationThread } from "@t3tools/contracts";

const MAX_RECENT_MESSAGES = 8;
const MAX_RECENT_ACTIVITIES = 6;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_ACTIVITY_CHARS = 240;
const MAX_PLAN_CHARS = 4_000;

function truncateBlock(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\r\n/g, "\n");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function formatAttachmentSummary(
  attachments: OrchestrationThread["messages"][number]["attachments"] | undefined,
): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  const labels = attachments.map((attachment) => {
    if (attachment.type === "image") {
      return `image:${attachment.name}`;
    }
    return attachment.type;
  });
  return `Attachments: ${labels.join(", ")}`;
}

function formatMessageBody(message: OrchestrationThread["messages"][number]): string {
  const parts: string[] = [];
  const text = message.text.trim();
  if (text.length > 0) {
    parts.push(truncateBlock(text, MAX_MESSAGE_CHARS));
  }
  const attachmentSummary = formatAttachmentSummary(message.attachments);
  if (attachmentSummary) {
    parts.push(attachmentSummary);
  }
  if (parts.length === 0) {
    parts.push("(empty message)");
  }
  return parts.join("\n");
}

function formatLatestPlan(thread: OrchestrationThread): string | null {
  const latestPlan = [...thread.proposedPlans].toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  if (!latestPlan) {
    return null;
  }
  return truncateBlock(latestPlan.planMarkdown, MAX_PLAN_CHARS);
}

function formatRecentActivities(thread: OrchestrationThread): string[] {
  return [...thread.activities]
    .filter((activity) => activity.tone !== "info" || activity.summary.toLowerCase().includes("error"))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_RECENT_ACTIVITIES)
    .toReversed()
    .map((activity) => {
      const label = activity.tone === "error" ? "Error" : activity.tone === "approval" ? "Approval" : "Activity";
      return `- ${label}: ${truncateBlock(activity.summary, MAX_ACTIVITY_CHARS)}`;
    });
}

export function buildThreadHandoffText(input: {
  readonly project: OrchestrationProject;
  readonly thread: OrchestrationThread;
}): string {
  const { project, thread } = input;
  const recentMessages = thread.messages.slice(-MAX_RECENT_MESSAGES);
  const latestUserMessage = [...thread.messages].toReversed().find((message) => message.role === "user");
  const latestPlan = formatLatestPlan(thread);
  const recentActivities = formatRecentActivities(thread);
  const latestTurnLabel = thread.latestTurn
    ? `${thread.latestTurn.state} (${thread.latestTurn.turnId})`
    : "not started";
  const workspaceLabel = thread.worktreePath ?? project.workspaceRoot;
  const continuationHints = [
    "- Verify the current workspace state before making changes.",
    thread.worktreePath
      ? `- Continue in the existing worktree at ${thread.worktreePath}.`
      : `- Continue in the project workspace at ${project.workspaceRoot}.`,
    thread.branch ? `- Preserve the current branch context: ${thread.branch}.` : null,
  ].filter((line): line is string => line !== null);

  const sections: string[] = [
    "You are taking over an existing coding session. Use this compact handoff instead of the full transcript.",
    "",
    "## Workspace",
    `- Project: ${project.title}`,
    `- Workspace root: ${project.workspaceRoot}`,
    `- Active path: ${workspaceLabel}`,
    `- Thread title: ${thread.title}`,
    `- Source thread id: ${thread.id}`,
    `- Model: ${thread.model}`,
    `- Runtime mode: ${thread.runtimeMode}`,
    `- Interaction mode: ${thread.interactionMode}`,
    `- Latest turn: ${latestTurnLabel}`,
  ];

  if (thread.branch) {
    sections.push(`- Branch: ${thread.branch}`);
  }
  if (thread.session?.providerName) {
    sections.push(`- Provider: ${thread.session.providerName}`);
  }
  if (thread.session?.lastError) {
    sections.push(`- Last session error: ${thread.session.lastError}`);
  }

  sections.push(
    "",
    "## Current objective",
    latestUserMessage ? formatMessageBody(latestUserMessage) : "No user message has been recorded yet.",
  );

  if (latestPlan) {
    sections.push("", "## Latest proposed plan", latestPlan);
  }

  sections.push("", "## Recent conversation");
  for (const message of recentMessages) {
    sections.push(
      `### ${message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User"} (${message.createdAt})`,
      formatMessageBody(message),
      "",
    );
  }
  if (recentMessages.length === 0) {
    sections.push("No conversation messages are available.", "");
  }

  if (recentActivities.length > 0) {
    sections.push("## Recent runtime highlights", ...recentActivities, "");
  }

  sections.push("## Continue from here", ...continuationHints);

  return sections.join("\n").trim();
}
