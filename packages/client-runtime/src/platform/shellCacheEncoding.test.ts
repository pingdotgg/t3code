import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "./orchestrationCache.ts";
import { makeStoredShellSnapshotEncoder } from "./shellCacheEncoding.ts";

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
