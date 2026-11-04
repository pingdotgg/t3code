import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";

/** Re-sync if the on-disk scope is older than this when the composer asks. */
const STALE_AFTER_MS = 5 * 60 * 1_000;
const LIST_PAGE_LIMIT = 200;
const MAX_PAGES = 5;

export class MentionIndexPrSyncer extends Context.Service<
  MentionIndexPrSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexPrSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const inFlight = yield* Ref.make(new Set<string>());

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
        rows.push({
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
        });
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
    const stale =
      meta === null ||
      meta.status === "empty" ||
      meta.status === "error" ||
      now - meta.syncedAt > STALE_AFTER_MS;
    if (!stale) return;

    const key = String(projectId);
    const running = yield* Ref.get(inFlight);
    if (running.has(key)) return;

    yield* Ref.update(inFlight, (set) => new Set(set).add(key));
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

  return MentionIndexPrSyncer.of({
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

export const layer = Layer.effect(MentionIndexPrSyncer, make);
