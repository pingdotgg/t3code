import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { buildHighlightSegments, createSearchSnippet, findTextOccurrences } from "./searchText";
import type { Project, Thread } from "../types";
import { sortThreads } from "./threadSort";

export { buildHighlightSegments, findTextOccurrences } from "./searchText";
export const createQuickThreadSearchSnippet = createSearchSnippet;

export const QUICK_THREAD_SEARCH_RECENT_LIMIT = 100;
export const QUICK_THREAD_SEARCH_RESULT_LIMIT = 100;
const TITLE_MATCH_WEIGHT = 3;

interface QuickThreadSearchIndexEntry {
  threadRef: ScopedThreadRef;
  projectName: string;
  threadTitle: string;
  threadTitleLower: string;
  threadRecencyIso: string;
  firstUserMessageText: string;
  firstUserMessageLower: string;
}

export interface QuickThreadSearchResult {
  resultId: string;
  threadRef: ScopedThreadRef;
  threadTitle: string;
  projectName: string;
  matchedField: "title" | "prompt";
  displaySnippet: string;
  sourceCreatedAt: string;
  matchCount: number;
}

export interface QuickThreadSearchResults {
  results: QuickThreadSearchResult[];
  totalResults: number;
  truncated: boolean;
}

function weightedMatchScore(input: {
  titleMatchCount: number;
  firstUserMatchCount: number;
}): number {
  return input.titleMatchCount * TITLE_MATCH_WEIGHT + input.firstUserMatchCount;
}

export function buildQuickThreadSearchIndex(input: {
  threads: readonly Thread[];
  projects: readonly Project[];
  recentLimit?: number;
}): QuickThreadSearchIndexEntry[] {
  const projectNameById = new Map(
    input.projects.map((project) => [project.id, project.name] as const),
  );

  const recentThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    "updated_at",
  ).slice(0, input.recentLimit ?? QUICK_THREAD_SEARCH_RECENT_LIMIT);

  return recentThreads.map((thread) => {
    const firstUserMessage =
      thread.messages.find(
        (message) => message.role === "user" && message.text.trim().length > 0,
      ) ?? null;
    const firstUserMessageText = firstUserMessage?.text.trim() ?? "";

    return {
      threadRef: scopeThreadRef(thread.environmentId, thread.id),
      projectName: projectNameById.get(thread.projectId) ?? "Unknown project",
      threadTitle: thread.title,
      threadTitleLower: thread.title.toLocaleLowerCase(),
      threadRecencyIso: thread.updatedAt ?? thread.createdAt,
      firstUserMessageText,
      firstUserMessageLower: firstUserMessageText.toLocaleLowerCase(),
    };
  });
}

export function buildQuickThreadSearchResults(input: {
  index: readonly QuickThreadSearchIndexEntry[];
  query: string;
  limit?: number;
}): QuickThreadSearchResults {
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return {
      results: [],
      totalResults: 0,
      truncated: false,
    };
  }

  const rankedResults: Array<
    QuickThreadSearchResult & { weightedScore: number; titleMatched: boolean }
  > = [];

  for (const entry of input.index) {
    const titleMatches = findTextOccurrences(entry.threadTitleLower, normalizedQuery);
    const firstUserMatches = findTextOccurrences(entry.firstUserMessageLower, normalizedQuery);
    if (titleMatches.length === 0 && firstUserMatches.length === 0) {
      continue;
    }

    const titleMatched = titleMatches.length > 0;
    const preferredMatch = titleMatches[0] ?? firstUserMatches[0];
    if (!preferredMatch) {
      continue;
    }

    rankedResults.push({
      resultId: `${entry.threadRef.environmentId}:${entry.threadRef.threadId}:${titleMatched ? "title" : "prompt"}`,
      threadRef: entry.threadRef,
      threadTitle: entry.threadTitle,
      projectName: entry.projectName,
      matchedField: titleMatched ? "title" : "prompt",
      displaySnippet: titleMatched
        ? entry.threadTitle
        : createSearchSnippet(entry.firstUserMessageText, preferredMatch.start, preferredMatch.end),
      sourceCreatedAt: entry.threadRecencyIso,
      matchCount: titleMatches.length + firstUserMatches.length,
      weightedScore: weightedMatchScore({
        titleMatchCount: titleMatches.length,
        firstUserMatchCount: firstUserMatches.length,
      }),
      titleMatched,
    });
  }

  rankedResults.sort((left, right) => {
    const byWeightedScore = right.weightedScore - left.weightedScore;
    if (byWeightedScore !== 0) return byWeightedScore;

    const byTitleMatch = Number(right.titleMatched) - Number(left.titleMatched);
    if (byTitleMatch !== 0) return byTitleMatch;

    const byRecency = right.sourceCreatedAt.localeCompare(left.sourceCreatedAt);
    if (byRecency !== 0) return byRecency;

    const rightKey = `${right.threadRef.environmentId}:${right.threadRef.threadId}`;
    const leftKey = `${left.threadRef.environmentId}:${left.threadRef.threadId}`;
    return rightKey.localeCompare(leftKey);
  });

  const limit = input.limit ?? QUICK_THREAD_SEARCH_RESULT_LIMIT;
  return {
    results: rankedResults.slice(0, limit),
    totalResults: rankedResults.length,
    truncated: rankedResults.length > limit,
  };
}
