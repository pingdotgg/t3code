import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "@t3tools/client-runtime/platform";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type ThreadPullRequestLink,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";

import * as MobileDatabase from "../persistence/mobile-database";
import { make } from "./environment-cache-store";
import { makeStoredShellSnapshotEncoder } from "./shell-cache-encoding";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const NOW = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 3,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
  ],
  threads: [
    {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: NOW,
      activityRunStartedAt: NOW,
      activityRunStatus: "running",
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      unsettledAt: NOW,
      lastVisitedAt: null,
      titleRegeneration: {
        requestId: CommandId.make("title-regeneration-1"),
        startedAt: NOW,
      },
      deletedAt: null,
    },
  ],
  archivedThreads: [],
};
const THREAD_SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 4,
  projection: {
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
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

function cacheId(
  environmentId: EnvironmentId,
  kind: MobileDatabase.ClientCacheKind,
  cacheKey: string,
) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const schemaVersions = new Map<string, number>();
  const removed: Array<string> = [];
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey) =>
      Effect.succeed(Option.fromUndefinedOr(values.get(cacheId(environmentId, kind, cacheKey)))),
    listCache: (kind) =>
      Effect.sync(() =>
        [...values.entries()]
          .filter(([key]) => key.split(":")[1] === kind)
          .map(([, payload]) => payload),
      ),
    saveCache: (environmentId, kind, cacheKey, schemaVersion, payload) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        values.set(id, payload);
        schemaVersions.set(id, schemaVersion);
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
  return { database, removed, schemaVersions, values };
}

describe("mobile SQLite environment cache store", () => {
  it.effect("round-trips V2 shell and thread DateTime fields with the shared cache schema", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );

      yield* store.saveShell(ENVIRONMENT_ID, SHELL_SNAPSHOT);
      yield* store.saveThread(ENVIRONMENT_ID, THREAD_SNAPSHOT);

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      const thread = Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID));

      expect(DateTime.formatIso(shell.threads[0]!.updatedAt)).toBe("2026-07-29T12:00:00.000Z");
      expect(DateTime.formatIso(shell.threads[0]!.latestUserMessageAt!)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(DateTime.formatIso(shell.threads[0]!.titleRegeneration!.startedAt)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      // Working and unsettled threads are exactly what a backgrounded app
      // caches; a decode failure here discards the whole shell on relaunch.
      expect(DateTime.formatIso(shell.threads[0]!.activityRunStartedAt!)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(DateTime.formatIso(shell.threads[0]!.unsettledAt!)).toBe("2026-07-29T12:00:00.000Z");
      expect(DateTime.formatIso(thread.projection.thread.updatedAt)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(memory.schemaVersions.get(cacheId(ENVIRONMENT_ID, "shell", "snapshot"))).toBe(
        ORCHESTRATION_CACHE_SCHEMA_VERSION,
      );
      expect(memory.schemaVersions.get(cacheId(ENVIRONMENT_ID, "thread", THREAD_ID))).toBe(
        ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      );
    }),
  );

  it.live("returns cached threads before their pull request links, which load after", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-07-29T12:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const linked = { ...SHELL_SNAPSHOT.threads[0]!, pullRequests: [link] };
      const unlinked = { ...SHELL_SNAPSHOT.threads[0]!, id: ThreadId.make("thread-2") };
      yield* store.saveShell(ENVIRONMENT_ID, {
        ...SHELL_SNAPSHOT,
        threads: [linked, unlinked],
      });

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      expect(shell.threads.map((thread) => thread.pullRequests)).toEqual([undefined, undefined]);
      const links = yield* shell.loadPullRequests!;
      expect([...links]).toEqual([[THREAD_ID, [link]]]);
    }),
  );

  it.live("keeps cached threads when their pull request links cannot be read", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    return Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 5,
        url: "https://github.com/pingdotgg/t3code/pull/5",
        source: "agent",
        linkedAt: "2026-07-29T12:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const readable = {
        ...SHELL_SNAPSHOT.threads[0]!,
        id: ThreadId.make("thread-2"),
        pullRequests: [link],
      };
      yield* store.saveShell(ENVIRONMENT_ID, {
        ...SHELL_SNAPSHOT,
        threads: [SHELL_SNAPSHOT.threads[0]!, readable],
      });
      const id = cacheId(ENVIRONMENT_ID, "shell", "snapshot");
      const payload = JSON.parse(memory.values.get(id)!);
      payload.snapshot.threads[0].pullRequests = [{ number: -1 }];
      memory.values.set(id, JSON.stringify(payload));

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      expect(shell.threads.map((thread) => thread.id)).toEqual([THREAD_ID, readable.id]);
      // Only the thread with the unreadable link loses its links.
      expect([...(yield* shell.loadPullRequests!)]).toEqual([[readable.id, [link]]]);
      expect(messages).toHaveLength(1);
      expect(memory.removed).toEqual([]);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("round-trips schema-validated VCS refs", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );

      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("deletes a corrupt cache record and treats it as a miss", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const id = cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo");
      memory.values.set(id, "{not-json");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );

  it.effect("removes one persisted VCS ref snapshot", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      yield* store.removeVcsRefs(ENVIRONMENT_ID, "/repo");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toContain(cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo"));
    }),
  );

  it.effect("clears every persisted VCS ref snapshot in one environment", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
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
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clear(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );
});

describe("cooperative shell cache encoding", () => {
  // A fresh encoder per call keeps these cases cold; the cache has its own cases below.
  const encodeStoredShellSnapshot = (stored: typeof StoredOrchestrationShellSnapshot.Type) =>
    makeStoredShellSnapshotEncoder()(stored);
  const encodeOriginal = Schema.encodeEffect(
    Schema.fromJsonString(StoredOrchestrationShellSnapshot),
  );
  const stored = {
    schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
    environmentId: ENVIRONMENT_ID,
    snapshot: {
      ...SHELL_SNAPSHOT,
      projects: SHELL_SNAPSHOT.projects.map((project) => ({
        ...project,
        title: "  Project  ",
        unexpected: "drop this field",
      })),
      threads: Array.from({ length: 64 }, (_, index) => ({
        ...SHELL_SNAPSHOT.threads[0]!,
        id: ThreadId.make(`thread-${index}`),
        branch: "  main  ",
        activityRunStartedAt: index % 2 === 0 ? NOW : null,
        unsettledAt: index % 2 === 0 ? NOW : null,
        modelSelection: {
          instanceId: PROVIDER_INSTANCE_ID,
          model: "  gpt-5.4  ",
          unexpected: "drop this field",
        },
        unexpected: "drop this field",
      })),
      archivedThreads: [{ ...SHELL_SNAPSHOT.threads[0]!, archivedAt: NOW }],
      unexpected: "drop this field",
    },
    unexpected: "drop this field",
  };

  it.effect("preserves exact JSON, transforms, nulls, dates, and unknown-field stripping", () =>
    Effect.gen(function* () {
      const expected = yield* encodeOriginal(stored);
      const actual = yield* encodeStoredShellSnapshot(stored);
      expect(actual).toBe(expected);
      const parsed = JSON.parse(actual);
      expect(parsed).not.toHaveProperty("unexpected");
      expect(parsed.snapshot).not.toHaveProperty("unexpected");
      expect(parsed.snapshot.projects[0]).not.toHaveProperty("unexpected");
      expect(parsed.snapshot.projects[0].title).toBe("Project");
      expect(parsed.snapshot.threads[0]).not.toHaveProperty("unexpected");
      expect(parsed.snapshot.threads[0].branch).toBe("main");
      expect(parsed.snapshot.threads[0].modelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-5.4",
      });
      expect(parsed.snapshot.threads[0].activityRunStartedAt).toBe(DateTime.formatIso(NOW));
      expect(parsed.snapshot.threads[1].activityRunStartedAt).toBeNull();
      expect(parsed.snapshot.archivedThreads[0].archivedAt).toBe(DateTime.formatIso(NOW));
    }),
  );

  it.effect("preserves optional fields and dates across chunk boundaries and archived rows", () =>
    Effect.gen(function* () {
      const base = SHELL_SNAPSHOT.threads[0]!;
      const { titleRegeneration: _, unsettledAt: __, ...withoutOptional } = base;
      const row = (index: number) =>
        index % 3 === 0
          ? { ...withoutOptional, id: ThreadId.make(`row-${index}`) }
          : {
              ...base,
              id: ThreadId.make(`row-${index}`),
              snoozedUntil: DateTime.add(NOW, { minutes: index }),
              pinnedAt: index % 2 === 0 ? null : NOW,
            };
      const mixed = {
        ...stored,
        snapshot: {
          ...stored.snapshot,
          threads: Array.from({ length: 65 }, (_, index) => row(index)),
          archivedThreads: Array.from({ length: 33 }, (_, index) => ({
            ...row(index + 100),
            archivedAt: DateTime.add(NOW, { hours: index }),
          })),
        },
      };
      const actual = yield* encodeStoredShellSnapshot(mixed);
      expect(actual).toBe(yield* encodeOriginal(mixed));
      const parsed = JSON.parse(actual);
      expect(parsed.snapshot.threads).toHaveLength(65);
      expect(parsed.snapshot.threads[63]).not.toHaveProperty("titleRegeneration");
      expect(parsed.snapshot.threads[63]).not.toHaveProperty("unsettledAt");
      expect(parsed.snapshot.threads[64].snoozedUntil).toBe(
        DateTime.formatIso(DateTime.add(NOW, { minutes: 64 })),
      );
      expect(parsed.snapshot.archivedThreads).toHaveLength(33);
      expect(parsed.snapshot.archivedThreads[32].archivedAt).toBe(
        DateTime.formatIso(DateTime.add(NOW, { hours: 32 })),
      );
    }),
  );

  it.effect("yields to a host timer between every 32-row chunk", () =>
    Effect.gen(function* () {
      const setTimer = vi.spyOn(globalThis, "setTimeout");
      try {
        yield* encodeStoredShellSnapshot({
          ...stored,
          snapshot: {
            ...stored.snapshot,
            threads: Array.from({ length: 65 }, () => ({ ...stored.snapshot.threads[0]! })),
            archivedThreads: Array.from({ length: 33 }, () => ({
              ...stored.snapshot.archivedThreads[0]!,
            })),
          },
        });
        // Five row chunks (3 active + 2 archived): four yields between them, one before the envelope.
        expect(setTimer).toHaveBeenCalledTimes(5);
      } finally {
        vi.restoreAllMocks();
      }
    }),
  );

  it.effect("still rejects invalid active and archived rows after an encoding chunk yields", () =>
    Effect.gen(function* () {
      const invalidRow = { ...stored.snapshot.threads[0]!, itemCount: -1 };
      const invalidActive = {
        ...stored,
        snapshot: { ...stored.snapshot, threads: [...stored.snapshot.threads, invalidRow] },
      };
      const invalidArchived = {
        ...stored,
        snapshot: { ...stored.snapshot, archivedThreads: [invalidRow] },
      };
      const invalidEnvelope = { ...stored, snapshot: { ...stored.snapshot, snapshotSequence: -1 } };
      expect(yield* Effect.isFailure(encodeStoredShellSnapshot(invalidActive))).toBe(true);
      expect(yield* Effect.isFailure(encodeStoredShellSnapshot(invalidArchived))).toBe(true);
      expect(yield* Effect.isFailure(encodeOriginal(invalidEnvelope))).toBe(true);
      expect(yield* Effect.isFailure(encodeStoredShellSnapshot(invalidEnvelope))).toBe(true);
    }),
  );

  it.effect("keeps concurrent saves independent", () =>
    Effect.gen(function* () {
      const other = {
        ...stored,
        environmentId: EnvironmentId.make("environment-2"),
        snapshot: {
          ...stored.snapshot,
          threads: stored.snapshot.threads.slice(0, 40).map((thread) => ({
            ...thread,
            title: `Other ${thread.id}`,
          })),
          archivedThreads: [],
        },
      };
      const [first, second] = yield* Effect.all(
        [encodeStoredShellSnapshot(stored), encodeStoredShellSnapshot(other)],
        { concurrency: "unbounded" },
      );
      expect(first).toBe(yield* encodeOriginal(stored));
      expect(second).toBe(yield* encodeOriginal(other));
    }),
  );

  it.effect("cancels the pending host timer when encoding is interrupted", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fakeSetTimeout = globalThis.setTimeout;
      const scheduled = yield* Deferred.make<ReturnType<typeof setTimeout>>();
      vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
        const timer = fakeSetTimeout(...args);
        Deferred.doneUnsafe(scheduled, Effect.succeed(timer));
        return timer;
      });
      const clearTimer = vi.spyOn(globalThis, "clearTimeout");
      const fiber = yield* Effect.forkScoped(
        Effect.suspend(() => encodeStoredShellSnapshot(stored)),
      );
      try {
        const pendingTimer = yield* Deferred.await(scheduled);
        expect(vi.getTimerCount()).toBe(1);
        yield* Fiber.interrupt(fiber);
        expect(clearTimer).toHaveBeenCalledWith(pendingTimer);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        yield* Fiber.interrupt(fiber);
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    }),
  );

  it.effect("reuses encoded rows across saves without changing the payload", () =>
    Effect.gen(function* () {
      const encode = makeStoredShellSnapshotEncoder();
      expect(yield* encode(stored)).toBe(yield* encodeOriginal(stored));

      const setTimer = vi.spyOn(globalThis, "setTimeout");
      try {
        // Same row references, new envelope: no row work, so no host yields.
        const resaved = {
          ...stored,
          snapshot: { ...stored.snapshot, snapshotSequence: 4 },
        };
        expect(yield* encode(resaved)).toBe(yield* encodeOriginal(resaved));
        expect(setTimer).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    }),
  );

  it.effect("encodes replaced, added, and moved-to-archive rows on a warm encoder", () =>
    Effect.gen(function* () {
      const encode = makeStoredShellSnapshotEncoder();
      yield* encode(stored);
      const [first, second, ...rest] = stored.snapshot.threads;
      const next = {
        ...stored,
        snapshot: {
          ...stored.snapshot,
          threads: [
            { ...first!, title: "Renamed", itemCount: 9 },
            ...rest,
            { ...first!, id: ThreadId.make("thread-new"), branch: "  feature  " },
          ],
          archivedThreads: [
            ...stored.snapshot.archivedThreads,
            { ...second!, archivedAt: DateTime.add(NOW, { hours: 1 }) },
          ],
        },
      };
      const actual = yield* encode(next);
      expect(actual).toBe(yield* encodeOriginal(next));
      const parsed = JSON.parse(actual);
      expect(parsed.snapshot.threads[0].title).toBe("Renamed");
      expect(parsed.snapshot.threads.at(-1).branch).toBe("feature");
      expect(parsed.snapshot.archivedThreads).toHaveLength(2);
    }),
  );

  it.effect("does not cache rows from a failed encode", () =>
    Effect.gen(function* () {
      const encode = makeStoredShellSnapshotEncoder();
      const invalidRow = { ...stored.snapshot.threads[0]!, itemCount: -1 };
      const invalid = {
        ...stored,
        snapshot: { ...stored.snapshot, threads: [...stored.snapshot.threads, invalidRow] },
      };
      expect(yield* Effect.isFailure(encode(invalid))).toBe(true);
      expect(yield* Effect.isFailure(encode(invalid))).toBe(true);
      // Valid rows from the failed save still encode correctly afterwards.
      expect(yield* encode(stored)).toBe(yield* encodeOriginal(stored));
    }),
  );
});
