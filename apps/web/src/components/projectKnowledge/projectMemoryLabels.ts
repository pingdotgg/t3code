import type { KnowledgeSelection, ProjectFact, ProjectFactId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

// Facts carry UUIDs; the prefix is enough to tell linked facts apart.
export const shortFactId = (id: ProjectFactId) => id.slice(0, 8);

export const factRowKey = (factId: ProjectFactId) => `fact:${factId}`;
export const messageRowKey = (ref: { threadId: string; messageId: string }) =>
  `message:${ref.threadId}:${ref.messageId}`;
export const selectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact" ? factRowKey(selection.factId) : messageRowKey(selection);

const STATUS_BADGE = {
  saved: { label: msg("Saved", { $context: "project fact status" }), variant: "success" },
  forgotten: { label: msg("Forgotten", { $context: "project fact status" }), variant: "secondary" },
} as const;

export const factStatusBadge = (fact: ProjectFact, resolve: MessageResolver = m) => {
  const badge = STATUS_BADGE[fact.status];
  return { ...badge, label: resolve(badge.label) };
};
