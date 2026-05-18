import { type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface ChatFindRow {
  id: string;
  rowId: string;
  rowIndex: number;
  searchText: string;
}

export interface ChatFindMatch {
  id: string;
  rowId: string;
  rowIndex: number;
  /** Which occurrence of the query within this row (0-based). */
  matchIndexInRow: number;
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectMessageSearchText(message: ChatMessage): string {
  const parts = [message.text ?? ""];

  for (const attachment of message.attachments ?? []) {
    parts.push(attachment.name);
  }

  return normalizeSearchText(parts.join("\n"));
}

function collectWorkEntrySearchText(entry: WorkLogEntry): string {
  const parts = [
    entry.label,
    entry.detail ?? "",
    entry.command ?? "",
    entry.rawCommand ?? "",
    entry.toolTitle ?? "",
    ...(entry.changedFiles ?? []),
  ];

  return normalizeSearchText(parts.join("\n"));
}

function collectProposedPlanSearchText(proposedPlan: ProposedPlan): string {
  return normalizeSearchText(proposedPlan.planMarkdown);
}

function collectTimelineRowSearchText(row: MessagesTimelineRow): string {
  switch (row.kind) {
    case "message":
      return collectMessageSearchText(row.message);

    case "work":
      return normalizeSearchText(
        row.groupedEntries.map((entry) => collectWorkEntrySearchText(entry)).join("\n"),
      );

    case "proposed-plan":
      return collectProposedPlanSearchText(row.proposedPlan);

    case "reasoning":
      return "";

    case "working":
      return "";
  }
}

/** Count occurrences of `needle` in `haystack` (case-insensitive). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export function buildChatFindRows(rows: ReadonlyArray<MessagesTimelineRow>): ChatFindRow[] {
  return rows.flatMap((row, rowIndex) => {
    if (row.kind === "working") return [];
    const searchText = collectTimelineRowSearchText(row);
    if (searchText.length === 0) return [];
    return [{ id: row.id, rowId: row.id, rowIndex, searchText }];
  });
}

export function findChatFindMatches(
  rows: ReadonlyArray<ChatFindRow>,
  query: string,
): ChatFindMatch[] {
  const normalizedQuery = normalizeSearchText(query).toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const matches: ChatFindMatch[] = [];

  for (const row of rows) {
    const lowerText = row.searchText.toLocaleLowerCase();
    const count = countOccurrences(lowerText, normalizedQuery);

    for (let i = 0; i < count; i++) {
      matches.push({
        id: `${row.id}:${normalizedQuery}:${i}`,
        rowId: row.rowId,
        rowIndex: row.rowIndex,
        matchIndexInRow: i,
      });
    }
  }

  return matches;
}
