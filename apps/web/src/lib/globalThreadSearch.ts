import { scopeProjectRef, scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { createSearchSnippet, findTextOccurrences } from "./searchText";
import { sortThreads } from "./threadSort";
import type { Project, Thread } from "../types";

export const GLOBAL_THREAD_SEARCH_RESULT_LIMIT = 300;

type GlobalSearchField = "title" | "user" | "assistant" | "plan";

interface GlobalThreadSearchIndexEntry {
  threadRef: ScopedThreadRef;
  threadTitle: string;
  projectName: string;
  threadUpdatedAt: string;
  sources: Array<{
    field: GlobalSearchField;
    sourceCreatedAt: string;
    text: string;
    textLower: string;
  }>;
}

export interface GlobalThreadSearchResult {
  resultId: string;
  threadRef: ScopedThreadRef;
  threadTitle: string;
  projectName: string;
  matchedField: GlobalSearchField;
  displaySnippet: string;
  sourceCreatedAt: string;
  matchCount: number;
}

export interface GlobalThreadSearchResults {
  results: GlobalThreadSearchResult[];
  totalResults: number;
  truncated: boolean;
}

function normalizeThreadText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fieldWeight(field: GlobalSearchField): number {
  switch (field) {
    case "title":
      return 6;
    case "user":
      return 4;
    case "assistant":
      return 3;
    case "plan":
      return 2;
  }
}

export function buildGlobalThreadSearchIndex(input: {
  threads: readonly Thread[];
  projects: readonly Project[];
}): GlobalThreadSearchIndexEntry[] {
  const projectNameByKey = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.name,
    ]),
  );

  return sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    "updated_at",
  ).map((thread) => {
    const sources: GlobalThreadSearchIndexEntry["sources"] = [];
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);

    const title = normalizeThreadText(thread.title);
    if (title.length > 0) {
      sources.push({
        field: "title",
        sourceCreatedAt: thread.updatedAt ?? thread.createdAt,
        text: title,
        textLower: title.toLocaleLowerCase(),
      });
    }

    for (const message of thread.messages) {
      const text = normalizeThreadText(message.text);
      if (text.length === 0) {
        continue;
      }

      if (message.role === "user" || message.role === "assistant") {
        sources.push({
          field: message.role === "user" ? "user" : "assistant",
          sourceCreatedAt: message.createdAt,
          text,
          textLower: text.toLocaleLowerCase(),
        });
      }
    }

    for (const plan of thread.proposedPlans) {
      const text = normalizeThreadText(plan.planMarkdown);
      if (text.length === 0) {
        continue;
      }

      sources.push({
        field: "plan",
        sourceCreatedAt: plan.createdAt,
        text,
        textLower: text.toLocaleLowerCase(),
      });
    }

    return {
      threadRef,
      threadTitle: thread.title,
      projectName:
        projectNameByKey.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? "Unknown project",
      threadUpdatedAt: thread.updatedAt ?? thread.createdAt,
      sources,
    };
  });
}

export function buildGlobalThreadSearchResults(input: {
  index: readonly GlobalThreadSearchIndexEntry[];
  query: string;
  limit?: number;
}): GlobalThreadSearchResults {
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return {
      results: [],
      totalResults: 0,
      truncated: false,
    };
  }

  const rankedResults: Array<
    GlobalThreadSearchResult & { weightedScore: number; threadUpdatedAt: string }
  > = [];

  for (const entry of input.index) {
    let bestResult:
      | (GlobalThreadSearchResult & { weightedScore: number; threadUpdatedAt: string })
      | null = null;

    for (const source of entry.sources) {
      const matches = findTextOccurrences(source.textLower, normalizedQuery);
      if (matches.length === 0) {
        continue;
      }

      const firstMatch = matches[0]!;
      const weightedScore = matches.length * fieldWeight(source.field);
      const candidate: GlobalThreadSearchResult & {
        weightedScore: number;
        threadUpdatedAt: string;
      } = {
        resultId: `${entry.threadRef.environmentId}:${entry.threadRef.threadId}:${source.field}`,
        threadRef: entry.threadRef,
        threadTitle: entry.threadTitle,
        projectName: entry.projectName,
        matchedField: source.field,
        displaySnippet:
          source.field === "title"
            ? source.text
            : createSearchSnippet(source.text, firstMatch.start, firstMatch.end),
        sourceCreatedAt: source.sourceCreatedAt,
        matchCount: matches.length,
        weightedScore,
        threadUpdatedAt: entry.threadUpdatedAt,
      };

      if (
        bestResult === null ||
        candidate.weightedScore > bestResult.weightedScore ||
        (candidate.weightedScore === bestResult.weightedScore &&
          candidate.sourceCreatedAt.localeCompare(bestResult.sourceCreatedAt) > 0)
      ) {
        bestResult = candidate;
      }
    }

    if (bestResult) {
      rankedResults.push(bestResult);
    }
  }

  rankedResults.sort((left, right) => {
    const byScore = right.weightedScore - left.weightedScore;
    if (byScore !== 0) return byScore;

    const bySourceCreatedAt = right.sourceCreatedAt.localeCompare(left.sourceCreatedAt);
    if (bySourceCreatedAt !== 0) return bySourceCreatedAt;

    const byThreadUpdatedAt = right.threadUpdatedAt.localeCompare(left.threadUpdatedAt);
    if (byThreadUpdatedAt !== 0) return byThreadUpdatedAt;

    return right.threadTitle.localeCompare(left.threadTitle);
  });

  const limit = input.limit ?? GLOBAL_THREAD_SEARCH_RESULT_LIMIT;
  return {
    results: rankedResults.slice(0, limit),
    totalResults: rankedResults.length,
    truncated: rankedResults.length > limit,
  };
}
