import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@lathe/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@lathe/client-runtime/state/models";
import { effectiveSnoozed } from "@lathe/client-runtime/state/thread-settled";
import { pendingSubagentRequestsByThread } from "@lathe/client-runtime/state/thread-shell";
import * as DateTime from "effect/DateTime";

export type MenuBarEnvironment = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
} & (
  | {
      readonly status: "live";
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    }
  | { readonly status: "connecting" }
  | { readonly status: "unavailable"; readonly reason: string }
);

export type MenuBarThreadKind =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "done"
  | "failed";

export interface MenuBarThreadItem {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly kind: MenuBarThreadKind;
  readonly since: string | null;
}

export interface MenuBarSummary {
  readonly icon: "idle" | "working" | "attention";
  readonly needsYou: ReadonlyArray<MenuBarThreadItem>;
  readonly running: ReadonlyArray<MenuBarThreadItem>;
  readonly finished: ReadonlyArray<MenuBarThreadItem>;
  readonly unavailable: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly reason: string;
  }>;
}

const ACTIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** Mirrors the sidebar's row status so the menu never disagrees with it. */
function classify(thread: EnvironmentThreadShell): MenuBarThreadKind | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  const status = thread.runtime?.status;
  if (status !== undefined && ACTIVE_RUNTIME.has(status)) {
    return status === "running" && thread.blockedOnThreadWait === true ? "waiting" : "working";
  }
  const completedAt = thread.latestRun?.completedAt;
  const visitedAt = thread.lastVisitedAt;
  if (status === "failed") {
    // Unopened failures count as unseen, unlike completions.
    return visitedAt == null || completedAt == null || completedAt > visitedAt ? "failed" : null;
  }
  return completedAt != null && visitedAt != null && completedAt > visitedAt ? "done" : null;
}

function since(thread: EnvironmentThreadShell, kind: MenuBarThreadKind): string | null {
  switch (kind) {
    case "approval":
    case "input":
    case "request": {
      const request = thread.source.pendingRuntimeRequest;
      return request === null ? thread.updatedAt : DateTime.formatIso(request.createdAt);
    }
    case "working":
    case "waiting":
      return thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? thread.updatedAt;
    case "done":
    case "failed":
      return thread.latestRun?.completedAt ?? thread.updatedAt;
  }
}

const newestFirst = (left: MenuBarThreadItem, right: MenuBarThreadItem) =>
  (right.since ?? "").localeCompare(left.since ?? "");

export function summarizeMenuBar(
  environments: ReadonlyArray<MenuBarEnvironment>,
  now: string,
): MenuBarSummary {
  const needsYou: Array<MenuBarThreadItem> = [];
  const running: Array<MenuBarThreadItem> = [];
  const finished: Array<MenuBarThreadItem> = [];
  const unavailable: Array<MenuBarSummary["unavailable"][number]> = [];

  for (const environment of environments) {
    if (environment.status === "unavailable") {
      const { environmentId, label, reason } = environment;
      unavailable.push({ environmentId, label, reason });
      continue;
    }
    if (environment.status !== "live") continue;
    const projectTitles = new Map(
      environment.projects.map((project) => [project.id, project.title]),
    );
    const subagentRequests = pendingSubagentRequestsByThread(environment.threads);
    for (const raw of environment.threads) {
      if (
        !isListedThreadLineage(raw.lineage) ||
        raw.archivedAt !== null ||
        raw.deletedAt !== null
      ) {
        continue;
      }
      const request = subagentRequests.get(raw.id) ?? null;
      // Clients show a user-only card as an ordinary question.
      const thread = presentThreadShell(
        environment.environmentId,
        raw,
        request === "user_only_input" ? "user_input" : request,
      );
      if (effectiveSnoozed(thread, { now })) continue;
      const kind = classify(thread);
      if (kind === null) continue;
      const item: MenuBarThreadItem = {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        threadId: thread.id,
        title: thread.title,
        projectTitle: projectTitles.get(thread.projectId) ?? null,
        kind,
        since: since(thread, kind),
      };
      if (kind === "working" || kind === "waiting") running.push(item);
      else if (kind === "done" || kind === "failed") finished.push(item);
      else needsYou.push(item);
    }
  }

  return {
    icon: needsYou.length > 0 ? "attention" : running.length > 0 ? "working" : "idle",
    needsYou: needsYou.sort(newestFirst),
    running: running.sort(newestFirst),
    finished: finished.sort(newestFirst),
    unavailable,
  };
}
