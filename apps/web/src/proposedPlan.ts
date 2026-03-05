import type { MessageId } from "@t3tools/contracts";

import type { ChatMessage } from "./types";

export interface ProposedPlanBlock {
  beforeText: string;
  planMarkdown: string;
  afterText: string;
}

export interface ProposedPlanMessageMatch {
  message: ChatMessage;
  plan: ProposedPlanBlock;
}

const PROPOSED_PLAN_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;

export function parseProposedPlanMessage(text: string): ProposedPlanBlock | null {
  const match = PROPOSED_PLAN_REGEX.exec(text);
  if (!match) {
    return null;
  }

  const fullMatch = match[0];
  const content = match[1];
  const start = match.index;
  const end = start + fullMatch.length;
  const planMarkdown = content?.trim();
  if (!planMarkdown) {
    return null;
  }

  return {
    beforeText: text.slice(0, start).trim(),
    planMarkdown,
    afterText: text.slice(end).trim(),
  };
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function findLatestProposedPlanMessage(
  messages: readonly ChatMessage[],
  assistantMessageId: MessageId | string | null | undefined,
): ProposedPlanMessageMatch | null {
  if (assistantMessageId) {
    const matchingMessage = messages.find(
      (message) => message.id === assistantMessageId && message.role === "assistant",
    );
    if (matchingMessage) {
      const parsedPlan = parseProposedPlanMessage(matchingMessage.text);
      if (parsedPlan) {
        return {
          message: matchingMessage,
          plan: parsedPlan,
        };
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const parsedPlan = parseProposedPlanMessage(message.text);
    if (!parsedPlan) {
      continue;
    }
    return {
      message,
      plan: parsedPlan,
    };
  }

  return null;
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}
