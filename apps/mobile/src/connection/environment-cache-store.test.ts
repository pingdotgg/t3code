import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
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
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";

import { type ClientCacheKind, MobileDatabase } from "../persistence/mobile-database";
import { make } from "./environment-cache-store";
import { encodeStoredShellSnapshot } from "./shell-cache-encoding";

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

function cacheId(environmentId: EnvironmentId, kind: ClientCacheKind, cacheKey: string) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const schemaVersions = new Map<string, number>();
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
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));

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
        ORCHESTRATION_CACHE_SCHEMA_VERSION,
      );
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

describe("cooperative shell cache encoding", () => {
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

  it.effect("still rejects invalid rows after an encoding batch yields", () =>
    Effect.gen(function* () {
      const invalid = {
        ...stored,
        snapshot: {
          ...stored.snapshot,
          threads: [...stored.snapshot.threads, { ...stored.snapshot.threads[0]!, itemCount: -1 }],
        },
      };
      expect(yield* Effect.isFailure(encodeStoredShellSnapshot(invalid))).toBe(true);
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
});
