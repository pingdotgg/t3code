import type { DesktopNotificationKind } from "@t3tools/contracts";

import type { AgentAwarenessPhase } from "./agentAwareness.ts";

const ACTIVE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
]);

const PRE_APPROVAL_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_input",
]);

export function agentNotificationKind(
  previousPhase: AgentAwarenessPhase | null,
  nextPhase: AgentAwarenessPhase | null,
): DesktopNotificationKind | null {
  if (previousPhase === null || nextPhase === null) {
    return null;
  }
  if (nextPhase === "completed" && ACTIVE_PHASES.has(previousPhase)) {
    return "task-completed";
  }
  if (nextPhase === "failed" && ACTIVE_PHASES.has(previousPhase)) {
    return "task-failed";
  }
  if (nextPhase === "waiting_for_approval" && PRE_APPROVAL_PHASES.has(previousPhase)) {
    return "approval-needed";
  }
  return null;
}

const NOTIFICATION_TITLES: Readonly<Record<DesktopNotificationKind, string>> = {
  "task-completed": "Completed",
  "task-failed": "Failed",
  "approval-needed": "Approval Required",
};

const MAX_TITLE_PROJECT_LENGTH = 28;

function shortenProjectName(projectTitle: string): string {
  const trimmed = projectTitle.trim();
  if (trimmed.length <= MAX_TITLE_PROJECT_LENGTH) {
    return trimmed;
  }
  const head = trimmed.slice(0, MAX_TITLE_PROJECT_LENGTH - 12).trimEnd();
  const tail = trimmed.slice(-9).trimStart();
  return `${head}…${tail}`;
}

export function notificationTitle(
  kind: DesktopNotificationKind,
  projectTitle?: string | null,
): string {
  const kindLabel = NOTIFICATION_TITLES[kind];
  const project = projectTitle === null || projectTitle === undefined ? "" : projectTitle.trim();
  return project.length > 0 ? `${kindLabel} - ${shortenProjectName(project)}` : kindLabel;
}

const MAX_BODY_LENGTH = 180;

export function toPlainNotificationText(markdown: string): string {
  let text = markdown;

  text = text.replace(/```[\s\S]*?```/g, " (code) ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " (code) ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, "");
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, "");
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, "");
  text = text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, "");
  return text.replace(/\s+/g, " ").trim();
}

export function truncateNotificationBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_BODY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`;
}

export function notificationBody(input: {
  readonly responseText: string | null;
  readonly threadTitle: string;
  readonly fallbackHeadline: string;
}): string {
  const plain = input.responseText === null ? "" : toPlainNotificationText(input.responseText);
  if (plain.length > 0) {
    return truncateNotificationBody(plain);
  }
  const title = input.threadTitle.trim();
  return truncateNotificationBody(title.length > 0 ? title : input.fallbackHeadline);
}
