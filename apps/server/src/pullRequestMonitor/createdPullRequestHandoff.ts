import type { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";

import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";

export interface CreatedPrResult {
  readonly status: string;
  readonly url?: string | null | undefined;
  readonly number?: number | null | undefined;
  readonly title?: string | null | undefined;
  readonly baseBranch?: string | null | undefined;
  readonly headBranch?: string | null | undefined;
}

export interface CreatedPullRequestLink {
  readonly pullRequest: GitPullRequestAssociation;
  readonly source: Extract<ThreadPullRequestLink["source"], "created">;
  readonly repository: string;
}

/**
 * Durable create-result handoff (Design A).
 *
 * The T3 stacked Git action already distinguishes a confirmed `created` PR
 * from `opened_existing`. Only the former may become a `created` thread link:
 * everything else (re-opens, skips, URL-less creations) stays out so the
 * review reactor never treats assistant wording or a re-open as provenance.
 */
export function buildCreatedPullRequestLink(pr: CreatedPrResult): CreatedPullRequestLink | null {
  if (pr.status !== "created") return null;
  if (typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1) {
    return null;
  }
  const url = typeof pr.url === "string" ? pr.url.trim() : "";
  if (url.length === 0) return null;
  const repository = repositoryFromPullRequestUrl(url);
  if (repository === null) return null;
  // `runPrStep` always sets the head branch on a confirmed creation; without
  // it there is nothing durable to link.
  const headBranch =
    typeof pr.headBranch === "string" && pr.headBranch.trim().length > 0
      ? pr.headBranch.trim()
      : null;
  if (headBranch === null) return null;
  const title =
    typeof pr.title === "string" && pr.title.trim().length > 0
      ? pr.title.trim()
      : `Pull request #${pr.number}`;
  const baseBranch =
    typeof pr.baseBranch === "string" && pr.baseBranch.trim().length > 0
      ? pr.baseBranch.trim()
      : "main";
  return {
    source: "created",
    repository,
    pullRequest: {
      number: pr.number,
      url,
      title,
      baseBranch,
      headBranch,
      state: "open",
    },
  };
}
