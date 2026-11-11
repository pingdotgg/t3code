import { describe, expect, it } from "@effect/vitest";
import type {
  ApplicationStoredEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  activeShellRowsForSubscriber,
  bufferShellLiveStream,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  omitIdleSubagentShells,
  omitOlderSettledShells,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemsFromInitialSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
} from "./ShellStream.ts";

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

describe("subagent shell events", () => {
  const stored = (threadId: string, type: string) =>
    ({ event: { threadId, type } }) as ApplicationStoredEvent;

  it("keeps regular threads and subagent state changes while omitting subagent transcript updates", () => {
    const subagents = new Set(["child"]);
    expect(
      shouldPublishShellApplicationEvent(stored("parent", "turn-item.updated"), subagents),
    ).toBe(true);
    expect(
      shouldPublishShellApplicationEvent(stored("child", "turn-item.updated"), subagents),
    ).toBe(false);
    expect(shouldPublishShellApplicationEvent(stored("child", "node.updated"), subagents)).toBe(
      false,
    );
    expect(
      shouldPublishShellApplicationEvent(stored("child", "runtime-request.updated"), subagents),
    ).toBe(true);
    expect(shouldPublishShellApplicationEvent(stored("child", "run.updated"), subagents)).toBe(
      true,
    );
  });

  it("tracks subagents created after the subscription starts", () => {
    const subagents = new Set<string>();
    const created = {
      event: {
        threadId: "new-child",
        type: "thread.created",
        payload: { lineage: { relationshipToParent: "subagent" } },
      },
    } as ApplicationStoredEvent;
    expect(shouldPublishShellApplicationEvent(created, subagents)).toBe(true);
    expect(
      shouldPublishShellApplicationEvent(stored("new-child", "message.updated"), subagents),
    ).toBe(false);
    expect(
      shouldPublishShellApplicationEvent(stored("new-child", "thread.deleted"), subagents),
    ).toBe(true);
    expect(subagents.has("new-child")).toBe(true);
  });
});

it.effect("coalesces a slow shell subscriber by identity and location in sequence order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<
        Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>,
        Cause.Done
      >();
      const drained = yield* Deferred.make<void>();
      const shell = shellFixture({ id: ThreadId.make("same"), title: "Before" });
      const project = {
        id: ProjectId.make("same"),
        title: "Before",
        workspaceRoot: "/workspace/same",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      };
      const initial = {
        kind: "thread.updated" as const,
        sequence: 1,
        location: "active" as const,
        thread: shell,
      };
      const updates = [
        { kind: "project.updated", sequence: 2, project },
        { ...initial, sequence: 3 },
        { ...initial, sequence: 4, location: "archive" },
        { ...initial, sequence: 5, thread: { ...shell, id: ThreadId.make("other") } },
        {
          kind: "project.updated",
          sequence: 6,
          project: { ...project, id: ProjectId.make("other") },
        },
        { kind: "project.removed", sequence: 7, projectId: project.id },
        { kind: "thread.removed", sequence: 8, location: "active", threadId: shell.id },
        { kind: "project.updated", sequence: 9, project: { ...project, title: "Recreated" } },
        { ...initial, sequence: 10, thread: { ...shell, title: "Recreated" } },
        { kind: "thread.removed", sequence: 11, location: "archive", threadId: shell.id },
      ] satisfies Array<Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>>;
      const pull = yield* Stream.toPull(
        bufferShellLiveStream(
          Stream.fromQueue(input).pipe(Stream.ensuring(Deferred.succeed(drained, undefined))),
          { maxItems: 6, maxSerializedBytes: 1_500 },
        ),
      );
      yield* Queue.offer(input, initial);
      expect(yield* pull).toEqual([initial]);
      yield* Queue.offerAll(input, updates);
      yield* Queue.end(input);
      // Finish producing the burst while the first batch is still awaiting its ACK.
      yield* Deferred.await(drained);
      expect(yield* pull).toEqual([updates[3], updates[4], updates[7], updates[8], updates[9]]);
    }),
  ),
);

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

describe("omitIdleSubagentShells", () => {
  const row = (
    id: string,
    parent: string | null,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shellFixture({
      id: ThreadId.make(id),
      lineage: {
        parentThreadId: parent === null ? null : ThreadId.make(parent),
        relationshipToParent: parent === null ? null : "subagent",
        rootThreadId: ThreadId.make("root"),
      },
      status: "completed",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      ...overrides,
    });

  it("drops idle leaf children but keeps live ones and the middle of nested chains", () => {
    const threads = [
      row("root", null),
      row("idle", "root"),
      row("running", "root", { activityRunStatus: "running" }),
      row("queued", "root", { status: "queued" }),
      row("asking", "root", {
        pendingRuntimeRequest: {
          id: "request" as never,
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(0),
        },
      }),
      row("background", "root", {
        pendingBackgroundTasks: [{ kind: "subagent" } as never],
      }),
      // Idle, but a woken grandchild walks through it to reach the root's badge.
      row("middle", "root"),
      row("grandchild", "middle"),
    ];
    expect(omitIdleSubagentShells(threads).map((thread) => thread.id)).toEqual([
      "root",
      "running",
      "queued",
      "asking",
      "background",
      "middle",
    ]);
  });

  it("still filters the transcript events of omitted children for a subscriber that opts in", () => {
    const threads = [row("root", null), row("idle", "root")];
    const omitted = activeShellRowsForSubscriber(threads, true);
    expect(omitted.threads.map((thread) => thread.id)).toEqual(["root"]);
    expect(
      shouldPublishShellApplicationEvent(
        { event: { threadId: "idle", type: "turn-item.updated" } } as ApplicationStoredEvent,
        omitted.subagentThreadIds,
      ),
    ).toBe(false);
  });
});

describe("omitOlderSettledShells", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = DateTime.makeUnsafe(100 * DAY);
  const row = (
    id: string,
    settledDaysAgo: number | null,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shellFixture({
      id: ThreadId.make(id),
      projectId: ProjectId.make(id.startsWith("b-") ? "project-b" : "project-a"),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
      status: "completed",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      settledOverride: settledDaysAgo === null ? null : "settled",
      settledAt:
        settledDaysAgo === null ? null : DateTime.makeUnsafe(100 * DAY - settledDaysAgo * DAY),
      ...overrides,
    });
  const newest = Array.from({ length: 25 }, (_, index) => row(`new-${index}`, index / 10));
  const omit = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    omitOlderSettledShells({ threads, snapshotSequence: 7, now });

  it("keeps the 25 newest settled threads and counts the rest per project", () => {
    const sideChat = row("side-chat", 0, {
      lineage: {
        parentThreadId: ThreadId.make("new-0"),
        relationshipToParent: "fork",
        rootThreadId: ThreadId.make("new-0"),
        sideChat: true,
      },
    });
    const result = omit([
      ...newest,
      sideChat,
      row("old", 30),
      row("b-old", 40),
      row("unsettled", null),
    ]);
    expect(result.threads.map((thread) => thread.id)).toEqual([
      ...newest.map((thread) => thread.id),
      "side-chat",
      "unsettled",
    ]);
    expect(result.olderSettled).toEqual({
      before: DateTime.formatIso(DateTime.makeUnsafe(100 * DAY - 2.4 * DAY)),
      asOfSequence: 7,
      counts: [
        { projectId: "project-a", count: 1 },
        { projectId: "project-b", count: 1 },
      ],
    });
  });

  it("keeps threads tied with the 25th newest", () => {
    const result = omit([...newest, row("tie", 2.4), row("older", 2.5)]);
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual(["tie"]);
  });

  it("omits nothing with fewer than 25 settled threads, however old", () => {
    const old = Array.from({ length: 5 }, (_, index) => row(`old-${index}`, 300 + index));
    const result = omit(old);
    expect(result.threads).toEqual(old);
    expect(result.olderSettled.counts).toEqual([]);
  });

  it("keeps older rows that are snoozed, live, or above a kept subagent or side chat, and still counts them", () => {
    const threads = [
      ...newest,
      row("snoozed", 30, { snoozedUntil: DateTime.makeUnsafe(101 * DAY) }),
      row("woke", 30, { snoozedUntil: DateTime.makeUnsafe(99 * DAY) }),
      row("running", 30, { activityRunStatus: "running" }),
      row("parent", 30),
      shellFixture({
        id: ThreadId.make("child"),
        projectId: ProjectId.make("project-a"),
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
        settledOverride: null,
        settledAt: null,
      }),
      row("side-chat-parent", 30),
      row("side-chat", null, {
        lineage: {
          parentThreadId: ThreadId.make("side-chat-parent"),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make("side-chat-parent"),
          sideChat: true,
        },
      }),
    ];
    const result = omit(threads);
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual([
      "snoozed",
      "running",
      "parent",
      "child",
      "side-chat-parent",
      "side-chat",
    ]);
    expect(result.olderSettled.counts).toEqual([{ projectId: "project-a", count: 5 }]);
  });
});

describe("shellStreamItemsFromInitialSnapshot", () => {
  it("keeps thread rows out of the metadata-only enrichment frame", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      projects: [
        { id: "project-a", workspaceRoot: "/workspace/a" },
        { id: "project-b", workspaceRoot: "/workspace/b" },
      ],
      threads: [shellFixture({})],
      archivedThreads: [shellFixture({ id: ThreadId.make("thread-archived"), archivedAt: null })],
    } as unknown as OrchestrationV2ShellSnapshot;

    const items = shellStreamItemsFromInitialSnapshot({
      snapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });

    expect(items[0]).toEqual({ kind: "snapshot", snapshot });
    expect(items[1]).toMatchObject({
      kind: "snapshot",
      snapshot: {
        projects: [{ id: "project-a", workspaceRoot: "/workspace/a" }],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });
    expect(JSON.stringify(items[1]).length).toBeLessThan(JSON.stringify(items[0]).length);
  });
});

describe("composeShellStreamWithEnrichment", () => {
  it.effect("preserves pending repository resolutions while an enrichment ACK is withheld", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Match ProjectEnrichmentService's sliding notifications and the WS batching path.
        const changes = yield* Effect.acquireRelease(
          PubSub.sliding<{ readonly workspaceRoot: string }>(256),
          PubSub.shutdown,
        );
        const subscription = yield* PubSub.subscribe(changes);
        const pull = yield* Stream.toPull(
          composeShellStreamWithEnrichment({
            initial: Stream.empty,
            tail: Stream.empty,
            enrichment: Stream.fromSubscription(subscription).pipe(
              Stream.groupedWithin(64, Duration.millis(25)),
              Stream.map((changes) =>
                shellStreamItemFromEnrichmentRefresh({
                  snapshot: emptyShellSnapshot,
                  changes,
                }),
              ),
            ),
          }),
        );

        const firstRoots = Array.from({ length: 64 }, (_, index) => `/workspace/first-${index}`);
        yield* PubSub.publishAll(
          changes,
          firstRoots.map((workspaceRoot) => ({ workspaceRoot })),
        );
        expect(yield* pull).toMatchObject([{ resolvedRepositoryIdentityRoots: firstRoots }]);

        // The next completion can be batched before the client acknowledges the first.
        yield* PubSub.publish(changes, { workspaceRoot: "/workspace/pending" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(25));
        const laterRoots = Array.from({ length: 256 }, (_, index) => `/workspace/later-${index}`);
        yield* PubSub.publishAll(
          changes,
          laterRoots.map((workspaceRoot) => ({ workspaceRoot })),
        );

        const resumed = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.takeUntil(
            (item) =>
              item.resolvedRepositoryIdentityRoots?.includes("/workspace/later-255") ?? false,
          ),
          Stream.runCollect,
        );
        expect(resumed.flatMap((item) => item.resolvedRepositoryIdentityRoots ?? [])).toEqual([
          "/workspace/pending",
          ...laterRoots,
        ]);
      }),
    ),
  );

  it.effect("keeps a merged shell batch charged while the client withholds its ACK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const update = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const initial = {
          kind: "thread.removed" as const,
          sequence: 1,
          location: "active" as const,
          threadId: ThreadId.make("thread-a"),
        };
        const pull = yield* Stream.toPull(
          composeShellStreamWithEnrichment({
            initial: Stream.empty,
            tail: bufferShellLiveStream(
              Stream.concat(
                Stream.succeed(initial),
                Stream.fromEffect(Deferred.await(update)).pipe(
                  Stream.map(() => ({ ...initial, sequence: 2 })),
                ),
              ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
              { maxItems: 1 },
            ),
            enrichment: Stream.empty,
          }),
        );
        expect(yield* pull).toEqual([initial]);
        // Let the merge producer run while the client still withholds its ACK.
        yield* Effect.yieldNow;
        yield* Deferred.succeed(update, undefined);
        yield* Deferred.await(closed);
        const result = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.runDrain,
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("LiveStreamBufferError");
      }),
    ),
  );

  it.effect(
    "emits every initial item before enrichment even when enrichment is already ready",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 5,
        } as OrchestrationV2ShellSnapshot;
        const enrichmentSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 10,
        } as OrchestrationV2ShellSnapshot;

        const initialItems = shellStreamItemsFromInitialSnapshot({
          snapshot: initialSnapshot,
          resolvedRepositoryIdentityRoots: ["/workspace/a"],
        });
        const enrichment = Stream.make(
          shellStreamItemFromEnrichmentRefresh({
            snapshot: enrichmentSnapshot,
            changes: [{ workspaceRoot: "/workspace/b" }],
          }),
        );
        const tail = Stream.make(
          { kind: "synchronized" as const },
          {
            kind: "project.removed" as const,
            sequence: 6,
            projectId: "project-a",
          },
        );

        const items = Array.from(
          yield* composeShellStreamWithEnrichment({
            initial: Stream.fromIterable(initialItems),
            tail,
            enrichment,
          }).pipe(Stream.runCollect),
        );

        expect(items.slice(0, initialItems.length)).toEqual(initialItems);

        const enrichmentIndex = items.findIndex(
          (item) =>
            item.kind === "snapshot" &&
            "resolvedRepositoryIdentityRoots" in item &&
            item.resolvedRepositoryIdentityRoots?.includes("/workspace/b"),
        );
        expect(enrichmentIndex).toBeGreaterThanOrEqual(initialItems.length);

        for (let index = 0; index < initialItems.length; index++) {
          expect(items[index]).toEqual(initialItems[index]);
        }
      }),
  );
});

describe("dedupeShellEnrichment", () => {
  const project = {
    id: ProjectId.make("project-a"),
    title: "A project",
    workspaceRoot: "/workspace/a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  const initial = {
    kind: "snapshot" as const,
    snapshot: { ...emptyShellSnapshot, projects: [project] },
  };
  const marked = { ...initial, resolvedRepositoryIdentityRoots: [project.workspaceRoot] };

  it.effect(
    "keeps initial/resume resolution and real changes but drops sequence-only repeats",
    () =>
      Effect.gen(function* () {
        const repeated = {
          ...marked,
          snapshot: { ...marked.snapshot, snapshotSequence: 10, projects: [{ ...project }] },
        };
        const progressed = {
          ...repeated,
          resolvedRepositoryIdentityRoots: [project.workspaceRoot, "/workspace/b"],
        };
        const changed = {
          ...progressed,
          snapshot: { ...progressed.snapshot, projects: [{ ...project, title: "Renamed" }] },
        };
        const items = yield* Stream.make(
          initial,
          marked,
          repeated,
          progressed,
          changed,
          changed,
        ).pipe(dedupeShellEnrichment, Stream.runCollect);
        expect(items).toEqual([initial, marked, progressed, changed]);
        const resumed = Stream.make(marked, repeated).pipe(dedupeShellEnrichment);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
      }),
  );

  it.effect("keeps authoritative snapshots and invalidates metadata after project deltas", () =>
    Effect.gen(function* () {
      const removed = { kind: "project.removed" as const, projectId: project.id, sequence: 2 };
      const updated = { kind: "project.updated" as const, project, sequence: 3 };
      const withThreads = {
        ...marked,
        snapshot: { ...marked.snapshot, threads: [shellFixture({})] },
      };
      const values = [
        initial,
        initial,
        marked,
        removed,
        marked,
        updated,
        marked,
        withThreads,
        withThreads,
      ];
      expect(
        yield* Stream.fromIterable(values).pipe(dedupeShellEnrichment, Stream.runCollect),
      ).toEqual(values);
    }),
  );

  it.effect(
    "deduplicates across thread deltas without dropping those deltas or identity clears",
    () =>
      Effect.gen(function* () {
        const delta = {
          kind: "thread.removed" as const,
          threadId: ThreadId.make("thread-a"),
          location: "active" as const,
          sequence: 2,
        };
        const resolved = {
          ...marked,
          snapshot: {
            ...marked.snapshot,
            projects: [
              {
                ...project,
                repositoryIdentity: {
                  canonicalKey: "github.com/test/repo",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "https://github.com/test/repo.git",
                  },
                },
              },
            ],
          },
        };
        expect(
          yield* Stream.make(marked, delta, marked, resolved, marked).pipe(
            dedupeShellEnrichment,
            Stream.runCollect,
          ),
        ).toEqual([marked, delta, resolved, marked]);
      }),
  );
});

describe("skipUnchangedThreadShells", () => {
  const at = (ms: number) => DateTime.makeUnsafe(Date.parse("2026-10-01T00:00:00.000Z") + ms);
  const shell = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    branch: null,
    status: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestUserMessageAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
  type Step =
    | { readonly advanceMs: number }
    | Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" | "synchronized" }>;
  const updated = (sequence: number, thread: OrchestrationV2ThreadShell): Step => ({
    kind: "thread.updated",
    sequence,
    location: "active",
    thread,
  });
  const run = (steps: ReadonlyArray<Step>) =>
    Stream.fromIterable(steps).pipe(
      Stream.mapEffect((step) =>
        "advanceMs" in step
          ? TestClock.adjust(Duration.millis(step.advanceMs)).pipe(Effect.as(null))
          : Effect.succeed(step),
      ),
      Stream.filter((item) => item !== null),
      skipUnchangedThreadShells,
      Stream.runCollect,
      Effect.map((items) => Array.from(items, (item) => ("sequence" in item ? item.sequence : -1))),
    );

  it.effect("sends the next update after a removal", () =>
    Effect.gen(function* () {
      const sent = yield* run([
        updated(1, shell("a")),
        { kind: "thread.removed", sequence: 2, location: "active", threadId: ThreadId.make("a") },
        updated(3, shell("a")),
      ]);
      expect(sent).toEqual([1, 2, 3]);
    }),
  );
});
