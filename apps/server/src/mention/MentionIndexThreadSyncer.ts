import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";

const STALE_AFTER_MS = 5 * 60 * 1_000;

export class MentionIndexThreadSyncer extends Context.Service<
  MentionIndexThreadSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexThreadSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const inFlight = yield* Ref.make(new Set<string>());

  const syncProject = Effect.fn("MentionIndexThreadSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("thread", projectId);
    yield* index.markSyncing(scopeKey);

    const listed = yield* Effect.result(
      threads.listProjectThreads({ projectId, includeSubagents: false }),
    );
    if (Result.isFailure(listed)) {
      const detail = listed.failure.message;
      yield* index.markError(scopeKey, detail);
      yield* Effect.logWarning("Mention index thread sync failed", {
        projectId,
        cause: listed.failure,
      });
      return;
    }

    const environmentId = yield* identity.getEnvironmentId;
    const now = yield* Clock.currentTimeMillis;
    const rows: MentionIndexRow[] = [];
    for (const shell of listed.success) {
      if (shell.archivedAt !== null) continue;
      const title = shell.title.trim() || "Untitled thread";
      const threadId = shell.id;
      rows.push({
        providerId: "thread",
        itemKey: `${environmentId}:${threadId}`,
        label: title.slice(0, 200),
        description: title.slice(0, 500),
        url: `t3-thread://${environmentId}/${threadId}`,
        tokens: foldTokens([title]),
        thread: {
          environmentId,
          threadId,
          title: title.slice(0, 200),
          projectId,
        },
        updatedAt: DateTime.toEpochMillis(shell.updatedAt) || now,
      });
    }

    const syncedAt = yield* Clock.currentTimeMillis;
    yield* index.replaceScope(scopeKey, rows, {
      status: rows.length === 0 ? "empty" : "ready",
      syncedAt,
    });
  });

  const ensureIndexed = Effect.fn("MentionIndexThreadSyncer.ensureIndexed")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("thread", projectId);
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

  return MentionIndexThreadSyncer.of({
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

export const layer = Layer.effect(MentionIndexThreadSyncer, make);
