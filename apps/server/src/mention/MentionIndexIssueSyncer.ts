import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";

const STALE_AFTER_MS = 5 * 60 * 1_000;
const LIST_LIMIT = 500;

export class MentionIndexIssueSyncer extends Context.Service<
  MentionIndexIssueSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexIssueSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const inFlight = yield* Ref.make(new Set<string>());

  const syncProject = Effect.fn("MentionIndexIssueSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("issue", projectId);
    yield* index.markSyncing(scopeKey);

    const listed = yield* Effect.result(pullRequests.listIssues({ projectId, limit: LIST_LIMIT }));
    if (Result.isFailure(listed)) {
      const detail = listed.failure.message;
      yield* index.markError(scopeKey, detail);
      yield* Effect.logWarning("Mention index issue sync failed", {
        projectId,
        cause: listed.failure,
      });
      return;
    }
    if (listed.success.errors.length > 0 && listed.success.entries.length === 0) {
      const detail = listed.success.errors.map((error) => error.message).join("; ");
      yield* index.markError(scopeKey, detail);
      yield* Effect.logWarning("Mention index issue sync failed", {
        projectId,
        errors: listed.success.errors,
      });
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    const rows: MentionIndexRow[] = listed.success.entries.map((entry) => ({
      providerId: "issue",
      itemKey: `${entry.repository.toLowerCase()}#${entry.number}`,
      label: `#${entry.number}`,
      description: entry.title,
      url: entry.url,
      tokens: foldTokens([
        String(entry.number),
        `#${entry.number}`,
        entry.title,
        entry.repository,
        entry.state,
      ]),
      issue: {
        number: entry.number,
        title: entry.title,
        url: entry.url,
        repository: entry.repository,
        state: entry.state,
        projectId: entry.projectId,
      },
      updatedAt: Date.parse(entry.updatedAt) || now,
    }));

    const syncedAt = yield* Clock.currentTimeMillis;
    const detail =
      listed.success.entries.length === 0 && listed.success.errors.length === 0
        ? "No GitHub issues indexed for this project (host must support issue listing)."
        : listed.success.errors.length > 0
          ? listed.success.errors.map((error) => error.message).join("; ")
          : undefined;
    yield* index.replaceScope(scopeKey, rows, {
      status: rows.length === 0 ? "empty" : "ready",
      syncedAt,
      ...(detail !== undefined ? { detail } : {}),
    });
  });

  const ensureIndexed = Effect.fn("MentionIndexIssueSyncer.ensureIndexed")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("issue", projectId);
    const meta = yield* index.scopeMeta(scopeKey);
    const now = yield* Clock.currentTimeMillis;
    const stale = meta === null || now - meta.syncedAt > STALE_AFTER_MS;
    if (!stale) return;

    const key = String(projectId);
    const claimed = yield* Ref.modify(inFlight, (set) => {
      if (set.has(key)) return [false, set] as const;
      const next = new Set(set);
      next.add(key);
      return [true, next] as const;
    });
    if (!claimed) return;

    yield* syncProject(projectId).pipe(
      Effect.ensuring(
        Ref.update(inFlight, (set) => {
          const next = new Set(set);
          next.delete(key);
          return next;
        }),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  });

  return MentionIndexIssueSyncer.of({
    ensureIndexed,
    syncProject,
  });
});

function foldTokens(parts: ReadonlyArray<string>): string {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export const layer = Layer.effect(MentionIndexIssueSyncer, make);
