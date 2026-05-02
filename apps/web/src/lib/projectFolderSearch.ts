import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

import type { Project } from "../types";

export const PROJECT_FOLDER_SEARCH_RESULT_LIMIT = 50;

export interface ProjectFolderSearchResult {
  project: Project;
}

export interface ProjectFolderSearchResults {
  results: ProjectFolderSearchResult[];
  totalResults: number;
  truncated: boolean;
}

interface RankedProjectFolderSearchResult extends ProjectFolderSearchResult {
  index: number;
  score: number;
}

function normalizeQuery(input: string): string {
  return input.trim().toLowerCase();
}

function scoreProject(project: Project, query: string): number | null {
  if (!query) {
    return 0;
  }

  const normalizedName = project.name.toLowerCase();
  const normalizedCwd = project.cwd.toLowerCase();

  if (normalizedName === query) return 0;
  if (normalizedCwd === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedCwd.startsWith(query)) return 3;
  if (normalizedName.includes(query)) return 4;
  if (normalizedCwd.includes(query)) return 5;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const cwdFuzzyScore = scoreSubsequenceMatch(normalizedCwd, query);
  if (cwdFuzzyScore !== null) {
    return 200 + cwdFuzzyScore;
  }

  return null;
}

export function buildProjectFolderSearchResults(input: {
  projects: readonly Project[];
  query: string;
  limit?: number;
}): ProjectFolderSearchResults {
  const normalizedQuery = normalizeQuery(input.query);
  const rankedResults: RankedProjectFolderSearchResult[] = [];

  for (const [index, project] of input.projects.entries()) {
    const score = scoreProject(project, normalizedQuery);
    if (score === null) {
      continue;
    }

    rankedResults.push({
      project,
      index,
      score,
    });
  }

  rankedResults.sort((left, right) => {
    const byScore = left.score - right.score;
    if (byScore !== 0) return byScore;
    return left.index - right.index;
  });

  const limit = input.limit ?? PROJECT_FOLDER_SEARCH_RESULT_LIMIT;
  return {
    results: rankedResults.slice(0, limit).map(({ project }) => ({ project })),
    totalResults: rankedResults.length,
    truncated: rankedResults.length > limit,
  };
}
