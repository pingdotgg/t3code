import { resolvePullRequestPreviewTarget } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  PullRequestChecks,
  PullRequestRef,
  PullRequestSummary,
  RepositoryIdentity,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { type CheckRun, type PrLive, rollupChecks } from "../domain/readiness";
import type { Ticket } from "../domain/ticket";

/** The part of a project that says which repository a bare pull request number belongs to. */
export interface PrProject {
  readonly id: PullRequestRef["projectId"];
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

const BARE_NUMBER = /^#?(\d+)$/;

const refOfLink = (projectId: PrProject["id"], link: ThreadPullRequestLink): PullRequestRef => ({
  projectId,
  host: link.host,
  repository: link.repository,
  number: link.number,
});

/**
 * The pull request a ticket is about. The orchestrator's `pr` wins, a number read against the
 * project's own repository and a link read by T3's own parser. A ticket with no `pr` takes
 * the link its agents' threads carry for the ticket's branch, or the newest one.
 */
export function ticketPrRef(
  ticket: Ticket,
  ownLinks: ReadonlyArray<ThreadPullRequestLink>,
  project: PrProject,
): PullRequestRef | null {
  const usable = ownLinks.filter((link) => link.source !== "stack-dismissed");
  if (ticket.pr != null) {
    const text = String(ticket.pr).trim();
    const bare = BARE_NUMBER.exec(text);
    if (bare !== null) {
      const number = Number(bare[1]);
      const link = usable.find((entry) => entry.number === number);
      if (link !== undefined) return refOfLink(project.id, link);
      const repository = sourceControlClients.repositorySelector(project.repositoryIdentity);
      return repository === null || number < 1
        ? null
        : { projectId: project.id, repository, number };
    }
    const target = resolvePullRequestPreviewTarget({
      environmentId: project.environmentId,
      projects: [project],
      pullRequestsEnabled: true,
      url: text,
    });
    if (target !== null) return target.input;
  }
  const link =
    usable.find((entry) => entry.snapshot?.headBranch === ticket.branch) ?? usable.at(-1);
  return link === undefined ? null : refOfLink(project.id, link);
}

export const sameRef = (
  ref: Pick<PullRequestRef, "repository" | "number">,
  link: Pick<ThreadPullRequestLink, "repository" | "number">,
) => link.repository === ref.repository && link.number === ref.number;

/**
 * Marks each running check with when it was first seen running, in `seen`, which the caller
 * keeps between reads. The host reports no start time, so a check already running when the
 * board opened reads as shorter than it is. A check's link names its run, so a new push, which
 * starts a new run, starts the clock over even when the old run was still going.
 */
export function trackRunning(
  seen: Map<string, number>,
  scope: string,
  checks: PullRequestChecks["checks"],
  now: number,
): ReadonlyArray<CheckRun> {
  const running = new Set<string>();
  const runs = checks.map((check): CheckRun => {
    const key = `${scope}\n${check.name}\n${check.url ?? ""}`;
    const isRunning = check.status === "pending";
    if (isRunning) {
      running.add(key);
      if (!seen.has(key)) seen.set(key, now);
    }
    return {
      name: check.name,
      status: check.status,
      description: check.description,
      url: check.url,
      required: check.required === true,
      placeholder: check.placeholder === true,
      runningSince: isRunning ? (seen.get(key) ?? now) : null,
    };
  });
  for (const key of seen.keys()) {
    if (key.startsWith(`${scope}\n`) && !running.has(key)) seen.delete(key);
  }
  return runs;
}

/**
 * What the board shows of a pull request. The thread link's snapshot is pushed with the shell
 * stream, but the engine keeps it current only while a thread watches the pull request. The
 * summary and the check list are read from the host. Whichever answered last decides state of
 * the checks and mergeability, and the check list gives the checks.
 */
export function buildLive(input: {
  readonly link: ThreadPullRequestLink | undefined;
  readonly summary: PullRequestSummary | null;
  readonly checks: PullRequestChecks | null;
  readonly runs: ReadonlyArray<CheckRun>;
}): PrLive | null {
  const { link, summary, checks, runs } = input;
  const snapshot = link?.snapshot ?? null;
  const states = [snapshot?.state, summary?.state, checks?.state];
  if (states.every((state) => state === undefined)) return null;
  // The engine stamps each host read, so a saved answer the client shows first reads as old.
  const hostAnsweredAt = Math.max(summary?.observedAt ?? 0, checks?.observedAt ?? 0);
  const snapshotAt = snapshot === null ? 0 : Date.parse(snapshot.syncedAt) || 0;
  const hostRolledUp = rollupChecks(runs) ?? summary?.checksState ?? null;
  const pushed = snapshot !== null && snapshotAt >= hostAnsweredAt;
  return {
    // A pull request that merged or closed stays so, whichever source is behind.
    state: states.includes("merged") ? "merged" : states.includes("closed") ? "closed" : "open",
    checksState: pushed
      ? (snapshot.checksState ?? hostRolledUp)
      : (hostRolledUp ?? snapshot?.checksState ?? null),
    mergeability: pushed
      ? (snapshot.mergeability ?? summary?.mergeability ?? "unknown")
      : (summary?.mergeability ?? snapshot?.mergeability ?? "unknown"),
    headSha: summary?.headSha ?? link?.watch?.headSha ?? null,
    checks: runs,
    url: summary?.url ?? link?.url ?? null,
  };
}
