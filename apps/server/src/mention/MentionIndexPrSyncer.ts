import type { ProjectId, PullRequestDetail, PullRequestListEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";
import type { ExactPullRequestRef } from "./mentionIndexExact.ts";

/** Re-sync if the on-disk scope is older than this when the composer asks. */
const STALE_AFTER_MS = 5 * 60 * 1_000;
const LIST_PAGE_LIMIT = 200;
const MAX_PAGES = 5;

export class MentionIndexPrSyncer extends Context.Service<
  MentionIndexPrSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
    /** Always fetch one PR by number and write it through into the index. */
    readonly ensureExact: (projectId: ProjectId, ref: ExactPullRequestRef) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexPrSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const inFlight = yield* Ref.make(new Set<string>());
  const exactInFlight = yield* Ref.make(new Set<string>());

  const syncProject = Effect.fn("MentionIndexPrSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    yield* index.markSyncing(scopeKey);

    const rows: MentionIndexRow[] = [];
    let cursors: Record<string, string> | undefined;

    const listPage = (pageCursors: Record<string, string> | undefined) =>
      pullRequests.list({
        state: "all",
        projectId,
        limit: LIST_PAGE_LIMIT,
        ...(pageCursors !== undefined ? { cursors: pageCursors } : {}),
      });

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = yield* Effect.result(listPage(cursors));
      if (Result.isFailure(listed)) {
        const detail = listed.failure.message;
        yield* index.markError(scopeKey, detail);
        yield* Effect.logWarning("Mention index PR sync failed", {
          projectId,
          cause: listed.failure,
        });
        return;
      }
      const result = listed.success;
      if (result.errors.length > 0) {
        const detail = result.errors.map((error) => error.message).join("; ");
        yield* index.markError(scopeKey, detail);
        yield* Effect.logWarning("Mention index PR sync incomplete", {
          projectId,
          errors: result.errors,
        });
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      for (const entry of result.entries) {
        rows.push(rowFromListEntry(entry, now));
      }
      const next = result.nextCursors;
      const hasNext = Object.keys(next).length > 0 && result.truncated;
      if (!hasNext) break;
      cursors = next;
    }

    const syncedAt = yield* Clock.currentTimeMillis;
    yield* index.replaceScope(scopeKey, rows, {
      status: rows.length === 0 ? "empty" : "ready",
      syncedAt,
    });
  });

  const ensureIndexed = Effect.fn("MentionIndexPrSyncer.ensureIndexed")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
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

  const resolveRepository = Effect.fn("MentionIndexPrSyncer.resolveRepository")(function* (
    projectId: ProjectId,
    preferred?: string,
  ) {
    if (preferred !== undefined && preferred.trim().length > 0) {
      return preferred.trim();
    }

    const scoped = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "",
      limit: 1,
    });
    const fromIndex = scoped.hits[0]?.pullRequest?.repository;
    if (fromIndex !== undefined && fromIndex.trim().length > 0) return fromIndex;

    const listed = yield* Effect.result(pullRequests.list({ projectId, state: "all", limit: 1 }));
    if (Result.isSuccess(listed)) {
      const fromList = listed.success.entries[0]?.repository;
      if (fromList !== undefined && fromList.trim().length > 0) return fromList;
    }
    return null;
  });

  const ensureExact = Effect.fn("MentionIndexPrSyncer.ensureExact")(function* (
    projectId: ProjectId,
    ref: ExactPullRequestRef,
  ) {
    const flightKey = `${projectId}:${ref.number}`;
    const claimed = yield* Ref.modify(exactInFlight, (set) => {
      if (set.has(flightKey)) return [false, set] as const;
      const next = new Set(set);
      next.add(flightKey);
      return [true, next] as const;
    });
    if (!claimed) return;

    yield* Effect.gen(function* () {
      const repository = yield* resolveRepository(projectId, ref.repository);
      if (repository === null) return;

      const detailed = yield* Effect.result(
        pullRequests.detail({
          projectId,
          repository,
          number: ref.number,
        }),
      );
      if (Result.isFailure(detailed)) {
        yield* Effect.logWarning("Mention index exact PR fetch failed", {
          projectId,
          number: ref.number,
          cause: detailed.failure,
        });
        return;
      }

      const now = yield* Clock.currentTimeMillis;
      yield* index.upsertRows(mentionIndexScopeKey("pull-request", projectId), [
        rowFromDetail(detailed.success, now),
      ]);
    }).pipe(
      Effect.ensuring(
        Ref.update(exactInFlight, (set) => {
          const next = new Set(set);
          next.delete(flightKey);
          return next;
        }),
      ),
    );
  });

  return MentionIndexPrSyncer.of({
    ensureIndexed,
    syncProject,
    ensureExact,
  });
});

function foldTokens(parts: ReadonlyArray<string>): string {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function rowFromListEntry(entry: PullRequestListEntry, now: number): MentionIndexRow {
  return {
    providerId: "pull-request",
    itemKey: `${entry.repository.toLowerCase()}#${entry.number}`,
    label: `#${entry.number}`,
    description: entry.title,
    url: entry.url,
    tokens: foldTokens([
      String(entry.number),
      `#${entry.number}`,
      entry.title,
      entry.repository,
      entry.headBranch,
      entry.baseBranch,
      entry.state,
      entry.isDraft ? "draft" : "",
      entry.author?.login ?? "",
    ]),
    pullRequest: {
      number: entry.number,
      title: entry.title,
      url: entry.url,
      headBranch: entry.headBranch,
      baseBranch: entry.baseBranch,
      state: entry.state,
      isDraft: entry.isDraft,
      projectId: entry.projectId,
      repository: entry.repository,
    },
    updatedAt: Date.parse(entry.updatedAt) || now,
  };
}

function rowFromDetail(detail: PullRequestDetail, now: number): MentionIndexRow {
  return {
    providerId: "pull-request",
    itemKey: `${detail.repository.toLowerCase()}#${detail.number}`,
    label: `#${detail.number}`,
    description: detail.title,
    url: detail.url,
    tokens: foldTokens([
      String(detail.number),
      `#${detail.number}`,
      detail.title,
      detail.repository,
      detail.headBranch,
      detail.baseBranch,
      detail.state,
      detail.isDraft ? "draft" : "",
      detail.author?.login ?? "",
    ]),
    pullRequest: {
      number: detail.number,
      title: detail.title,
      url: detail.url,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      state: detail.state,
      isDraft: detail.isDraft,
      projectId: detail.projectId,
      repository: detail.repository,
    },
    updatedAt: Date.parse(detail.updatedAt) || now,
  };
}

export const layer = Layer.effect(MentionIndexPrSyncer, make);
