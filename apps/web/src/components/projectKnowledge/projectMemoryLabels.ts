import type { KnowledgeSelection, ProjectFact, ProjectFactId } from "@t3tools/contracts";

// Facts carry UUIDs; the prefix is enough to tell linked facts apart.
export const shortFactId = (id: ProjectFactId) => id.slice(0, 8);

export const factRowKey = (factId: ProjectFactId) => `fact:${factId}`;
export const messageRowKey = (ref: { threadId: string; messageId: string }) =>
  `message:${ref.threadId}:${ref.messageId}`;
export const selectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact" ? factRowKey(selection.factId) : messageRowKey(selection);

const STATUS_BADGE = {
  saved: { label: "Saved", variant: "success" },
  forgotten: { label: "Forgotten", variant: "secondary" },
} as const;

export const factStatusBadge = (fact: ProjectFact) => STATUS_BADGE[fact.status];
