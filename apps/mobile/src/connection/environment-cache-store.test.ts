import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  COMPACT_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "@t3tools/client-runtime/platform";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as MobileDatabase from "../persistence/mobile-database";
import { make } from "./environment-cache-store";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const NOW = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const encodeLegacyThreadSnapshot = Schema.encodeEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);
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

function cacheId(
  environmentId: EnvironmentId,
  kind: MobileDatabase.ClientCacheKind,
  cacheKey: string,
) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function threadSnapshotWithItems(): OrchestrationV2ThreadDetailSnapshot {
  const local = {
    id: TurnItemId.make("local-notice"),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 10,
    status: "completed" as const,
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    type: "system_notice" as const,
    message: "A settled local notice.",
  };
  const hidden = { ...local, id: TurnItemId.make("hidden-notice"), ordinal: 11 };
  const inherited = {
    ...local,
    id: TurnItemId.make("inherited-notice"),
    threadId: ThreadId.make("parent-thread"),
  };
  return {
    ...THREAD_SNAPSHOT,
    historyCursor: "older-page",
    hasMoreHistory: true,
    latestLocalTurnOrdinal: 11,
    projection: {
      ...THREAD_SNAPSHOT.projection,
      turnItems: [local, hidden],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: inherited.threadId,
          sourceItemId: inherited.id,
          item: inherited,
        },
        {
          position: 1,
          visibility: "local",
          sourceThreadId: THREAD_ID,
          sourceItemId: local.id,
          item: local,
        },
      ],
    },
  };
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
  it.effect("loads a V5 record and migrates to V6 on the next save without losing items", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const snapshot = threadSnapshotWithItems();
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      const raw = yield* encodeLegacyThreadSnapshot({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        snapshot,
      });
      memory.values.set(id, raw);
      const loaded = Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID));
      expect(loaded).toEqual(snapshot);
      expect(memory.values.get(id)).toBe(raw);
      yield* store.saveThread(ENVIRONMENT_ID, loaded);
      expect(memory.schemaVersions.get(id)).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toEqual(
        snapshot,
      );
      expect(memory.removed).toEqual([]);
    }),
  );

  it.effect("discards thread records written before file changes carried diffOmitted", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      yield* store.saveThread(ENVIRONMENT_ID, threadSnapshotWithItems());
      const current = JSON.parse(memory.values.get(id)!);
      const legacy = JSON.parse(
        yield* encodeLegacyThreadSnapshot({
          schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          snapshot: threadSnapshotWithItems(),
        }),
      );
      // Compact records were 6 and full ones 5 when an older client could strip the field. A
      // resumed thread replays only newer events, so these rows would never be replaced.
      for (const stale of [
        { ...current, schemaVersion: 6 },
        { ...legacy, schemaVersion: 5 },
      ]) {
        memory.values.set(id, JSON.stringify(stale));
        memory.removed.length = 0;
        expect(Option.isNone(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toBe(true);
        expect(memory.removed).toEqual([id]);
      }
    }).pipe(Effect.provide(Logger.layer([]))),
  );

  it.effect("discards corrupt or partial thread records so they can be refetched", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      yield* store.saveThread(ENVIRONMENT_ID, threadSnapshotWithItems());
      const raw = memory.values.get(id)!;
      const partial = JSON.parse(raw);
      delete partial.snapshot.projection.visibleTurnItems;
      const invalidItem = JSON.parse(raw);
      delete invalidItem.snapshot.projection.visibleTurnItems[1].item.message;
      const corruptions = [
        partial,
        invalidItem,
        ...[
          (value: typeof partial) => {
            delete value.snapshot.turnItemCount;
          },
          (value: typeof partial) => {
            delete value.snapshot.turnItemsOmitLocalVisible;
          },
          (value: typeof partial) => {
            value.snapshot.turnItemsOmitLocalVisible = false;
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems.pop();
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems.shift();
          },
          (value: typeof partial) => {
            value.snapshot.projection.turnItems.pop();
          },
          (value: typeof partial) => {
            value.snapshot.turnItemCount = 0;
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems[1].sourceItemId = "wrong-item";
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems[1].visibility = "inherited";
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems[1].item.threadId = "wrong-thread";
          },
          (value: typeof partial) => {
            value.snapshot.projection.thread.id = "wrong-thread";
          },
          (value: typeof partial) => {
            value.snapshot.projection.turnItems.push(
              value.snapshot.projection.visibleTurnItems[1].item,
            );
          },
          (value: typeof partial) => {
            value.snapshot.projection.visibleTurnItems.push(
              value.snapshot.projection.visibleTurnItems[1],
            );
          },
        ].map((corrupt) => {
          const value = JSON.parse(raw);
          corrupt(value);
          return value;
        }),
      ];
      const invalidRecords = ["{broken", ...corruptions.map((value) => JSON.stringify(value))];
      for (const invalid of invalidRecords) {
        memory.values.set(id, invalid);
        expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.none());
        expect(memory.values.has(id)).toBe(false);
      }
      expect(memory.removed).toEqual(invalidRecords.map(() => id));
      yield* store.saveThread(ENVIRONMENT_ID, threadSnapshotWithItems());
      expect(Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toEqual(
        threadSnapshotWithItems(),
      );
    }),
  );

  it.effect("round-trips V5 exactly and restores shared items before returning to a consumer", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const original = threadSnapshotWithItems();
      const local = original.projection.visibleTurnItems[1]!;
      const inherited = original.projection.visibleTurnItems[0]!;
      const synthetic = { ...local.item, id: TurnItemId.make("synthetic-notice"), ordinal: 12 };
      const fork = {
        id: TurnItemId.make("fork-marker"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        type: "fork" as const,
        source: {
          type: "run" as const,
          threadId: ThreadId.make("parent-thread"),
          runId: RunId.make("parent-run"),
        },
        targetThreadId: THREAD_ID,
      };
      const snapshot = {
        ...original,
        projection: {
          ...original.projection,
          turnItems: [local.item, synthetic, original.projection.turnItems[1]!],
          visibleTurnItems: [
            { ...local, position: 0 },
            {
              ...inherited,
              position: 1,
              sourceItemId: local.sourceItemId,
              item: { ...inherited.item, id: local.item.id },
            },
            {
              ...local,
              position: 2,
              visibility: "synthetic" as const,
              sourceItemId: synthetic.id,
              item: synthetic,
            },
            {
              position: 3,
              visibility: "synthetic" as const,
              sourceThreadId: fork.source.threadId,
              sourceItemId: fork.id,
              item: fork,
            },
          ],
        },
      };
      yield* store.saveThread(ENVIRONMENT_ID, snapshot);
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      const encoded = JSON.parse(memory.values.get(id)!);
      expect(encoded.schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(memory.schemaVersions.get(id)).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(encoded.snapshot.turnItemsOmitLocalVisible).toBe(true);
      expect(encoded.snapshot.turnItemCount).toBe(3);
      expect(encoded.snapshot.visibleTurnItemCount).toBe(4);
      expect(encoded.snapshot.projection.turnItems.map((item: { id: string }) => item.id)).toEqual([
        "hidden-notice",
      ]);

      const duplicate = JSON.parse(memory.values.get(id)!);
      duplicate.snapshot.projection.visibleTurnItems.push({
        ...duplicate.snapshot.projection.visibleTurnItems[1],
        position: 4,
      });
      duplicate.snapshot.visibleTurnItemCount += 1;
      memory.values.set(id, JSON.stringify(duplicate));
      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.none());
      expect(memory.values.has(id)).toBe(false);
      expect(memory.removed).toEqual([id]);
      yield* store.saveThread(ENVIRONMENT_ID, snapshot);

      const loaded = Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID));
      expect(loaded).toEqual(snapshot);
      expect(loaded).not.toHaveProperty("turnItemsOmitLocalVisible");
      expect(loaded).not.toHaveProperty("turnItemCount");
      expect(loaded).not.toHaveProperty("visibleTurnItemCount");
      expect(loaded.projection.turnItems[0]).toBe(loaded.projection.visibleTurnItems[0]!.item);
      expect(loaded.projection.turnItems[1]).toBe(loaded.projection.visibleTurnItems[2]!.item);
      expect(snapshot.projection.turnItems).toHaveLength(3);
    }),
  );

  it.effect("keeps a full projection when visible rows cannot reproduce the original items", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const original = threadSnapshotWithItems();
      const local = original.projection.turnItems[0]!;
      for (const turnItems of [
        [{ ...local }, original.projection.turnItems[1]!],
        [{ ...local, message: "Newer than the visible row." }, original.projection.turnItems[1]!],
        original.projection.turnItems.toReversed(),
      ]) {
        const snapshot = { ...original, projection: { ...original.projection, turnItems } };
        yield* store.saveThread(ENVIRONMENT_ID, snapshot);
        const raw = memory.values.get(cacheId(ENVIRONMENT_ID, "thread", THREAD_ID))!;
        const encoded = JSON.parse(raw);
        expect(encoded.schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
        expect(encoded.snapshot.turnItemsOmitLocalVisible).toBe(false);
        expect(encoded.snapshot.turnItemCount).toBe(2);
        expect(encoded.snapshot.projection.turnItems).toHaveLength(2);
        expect(Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toEqual(
          snapshot,
        );
      }
    }),
  );

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
        COMPACT_THREAD_CACHE_SCHEMA_VERSION,
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
      expect([...(yield* shell.loadPullRequests!)]).toEqual([[readable.id, [link]]]);
      expect(messages).toHaveLength(1);
      expect(memory.removed).toEqual([]);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

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
});
