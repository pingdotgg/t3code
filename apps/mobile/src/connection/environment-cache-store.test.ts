import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type ClientCacheKind, MobileDatabase } from "../persistence/mobile-database";
import { make } from "./environment-cache-store";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Cached thread",
    modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-spark-1.3" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pullRequests: [],
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};
const REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

function cacheId(environmentId: EnvironmentId, kind: ClientCacheKind, cacheKey: string) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const removed: Array<string> = [];
  const database = MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey) =>
      Effect.succeed(Option.fromUndefinedOr(values.get(cacheId(environmentId, kind, cacheKey)))),
    listCache: (kind) =>
      Effect.sync(() =>
        [...values.entries()]
          .filter(([key]) => key.split(":")[1] === kind)
          .map(([, payload]) => payload),
      ),
    saveCache: (environmentId, kind, cacheKey, _schemaVersion, payload) =>
      Effect.sync(() => {
        values.set(cacheId(environmentId, kind, cacheKey), payload);
      }),
    removeCache: (environmentId, kind, cacheKey) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        removed.push(id);
        values.delete(id);
      }),
    clearCacheKind: (environmentId, kind) =>
      Effect.sync(() => {
        for (const key of values.keys()) {
          if (key.startsWith(`${environmentId}:${kind}:`)) values.delete(key);
        }
      }),
    clearEnvironmentCache: (environmentId) =>
      Effect.sync(() => {
        for (const key of values.keys()) {
          if (key.startsWith(`${environmentId}:`)) values.delete(key);
        }
      }),
    clearAllCaches: Effect.sync(() => values.clear()),
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
  });
  return { database, removed, values };
}

describe("mobile SQLite environment cache store", () => {
  it.effect("discards v3 thread snapshots so historical activities are refetched", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      memory.values.set(
        id,
        JSON.stringify({
          schemaVersion: 3,
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          snapshot: THREAD_SNAPSHOT,
        }),
      );

      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
      expect(memory.values.has(id)).toBe(false);
    }),
  );

  it.effect("accepts v4 thread snapshots and round-trips refreshed history", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      memory.values.set(
        cacheId(ENVIRONMENT_ID, "thread", THREAD_ID),
        JSON.stringify({
          schemaVersion: 4,
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          snapshot: THREAD_SNAPSHOT,
        }),
      );
      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(
        Option.some(THREAD_SNAPSHOT),
      );

      const refreshed = {
        ...THREAD_SNAPSHOT,
        snapshotSequence: 8,
        thread: { ...THREAD_SNAPSHOT.thread, title: "Refreshed thread" },
      };
      yield* store.saveThread(ENVIRONMENT_ID, refreshed);

      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.some(refreshed));
      expect(memory.removed).toEqual([]);
    }),
  );

  it.effect("round-trips schema-validated VCS refs", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));

      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("deletes a corrupt cache record and treats it as a miss", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const id = cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo");
      memory.values.set(id, "{not-json");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );

  it.effect("removes one persisted VCS ref snapshot", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      yield* store.removeVcsRefs(ENVIRONMENT_ID, "/repo");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toContain(cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo"));
    }),
  );

  it.effect("clears every persisted VCS ref snapshot in one environment", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo-worktree", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clearVcsRefs(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo-worktree")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("clears one environment without touching another", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clear(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );
});
