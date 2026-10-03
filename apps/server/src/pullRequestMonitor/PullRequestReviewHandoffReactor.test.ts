import {
  type OrchestrationEvent,
  ProjectId,
  type PullRequestMonitorSubmitFindingsInput,
  type ReviewResult,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  handoffFromReviewResult,
  handoffToSubmitInput,
  layer,
  REVIEW_HANDOFF_PROJECTOR,
  reviewFindingKey,
} from "./PullRequestReviewHandoffReactor.ts";

const snapshot = {
  scope: {
    kind: "pull-request" as const,
    number: 12,
    title: "Add monitor",
    url: "https://github.com/acme/app/pull/12",
    baseBranch: "main",
    headBranch: "feat",
    headSha: "head-sha-1",
  },
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\n",
  diffHash: "diffhash-1",
};

const finding = (
  overrides: Partial<{
    id: string;
    priority: string;
    title: string;
    body: string;
    path: string;
    side: "new" | "old";
    startLine: number;
    endLine: number;
  }> = {},
) => ({
  id: overrides.id ?? "finding-1",
  priority: (overrides.priority ?? "high") as "critical" | "high" | "medium" | "low",
  title: overrides.title ?? "Null deref",
  body: overrides.body ?? "This can be null.",
  confidence: 0.9,
  location: {
    path: overrides.path ?? "src/a.ts",
    side: overrides.side ?? ("new" as const),
    startLine: overrides.startLine ?? 2,
    endLine: overrides.endLine ?? overrides.startLine ?? 2,
  },
});

const parsed = (findings = [finding()], snapshotOverride = {}) => ({
  status: "parsed" as const,
  snapshot: { ...snapshot, ...snapshotOverride },
  findings,
  verdict: "request-changes" as const,
  summary: "Two issues found.",
});

describe("handoffFromReviewResult", () => {
  const projectId = ProjectId.make("proj_1");

  it("converts a parsed PR review into a handoff", () => {
    const handoff = handoffFromReviewResult({
      reviewThreadId: ThreadId.make("thr_review"),
      projectId,
      result: parsed(),
    });
    expect(handoff).toMatchObject({
      reviewThreadId: "thr_review",
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
      headSha: "head-sha-1",
      summary: "Two issues found.",
    });
    expect(handoff?.findings).toHaveLength(1);
  });

  it("ignores invalid output, zero-finding reviews, and non-PR scopes", () => {
    const input = { reviewThreadId: ThreadId.make("thr"), projectId };
    expect(
      handoffFromReviewResult({
        ...input,
        result: { status: "invalid-output", snapshot, issues: ["bad"] } as ReviewResult,
      }),
    ).toBeNull();
    expect(handoffFromReviewResult({ ...input, result: parsed([]) })).toBeNull();
    expect(
      handoffFromReviewResult({
        ...input,
        result: parsed([finding()], {
          scope: { kind: "uncommitted", branch: "main", untrackedFiles: [] },
        }),
      }),
    ).toBeNull();
  });

  it("ignores a PR url whose repository cannot be derived", () => {
    expect(
      handoffFromReviewResult({
        reviewThreadId: ThreadId.make("thr"),
        projectId,
        result: parsed([finding()], {
          scope: { ...snapshot.scope, url: "not-a-url" },
        }),
      }),
    ).toBeNull();
  });

  it("ignores legacy PR snapshots without the reviewed head revision", () => {
    const { headSha: _headSha, ...legacyScope } = snapshot.scope;
    expect(
      handoffFromReviewResult({
        reviewThreadId: ThreadId.make("thr"),
        projectId,
        result: parsed([finding()], { scope: legacyScope }),
      }),
    ).toBeNull();
  });
});

describe("handoffToSubmitInput", () => {
  const review = handoffFromReviewResult({
    reviewThreadId: ThreadId.make("thr_review"),
    projectId: ProjectId.make("proj_1"),
    result: parsed([
      finding({ priority: "critical" }),
      finding({ id: "finding-2", priority: "medium", title: "Naming", startLine: 3 }),
      finding({ id: "finding-3", priority: "low", title: "Typo", startLine: 4 }),
    ]),
  })!;

  it("preserves reference, locations, and maps priorities to severities", () => {
    const input = handoffToSubmitInput(review);
    const findings = input.findings ?? [];
    expect(input.reference).toEqual({
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
    });
    expect(input.reviewThreadId).toBe("thr_review");
    expect(input.reviewedHeadSha).toBe("head-sha-1");
    expect(findings.map((entry) => entry.severity)).toEqual(["blocker", "minor", "nit"]);
    expect(findings[0]).toMatchObject({ path: "src/a.ts", line: 2 });
  });

  it("derives content-stable keys that survive positional reordering", () => {
    const first = (handoffToSubmitInput(review).findings ?? []).map((entry) => entry.key);
    // Same content in a different order must keep each finding's key stable.
    const reordered = (
      handoffToSubmitInput({ ...review, findings: [...review.findings].toReversed() }).findings ??
      []
    ).map((entry) => entry.key);
    expect([...reordered].sort()).toEqual([...first].sort());
  });

  it("bounds summaries but preserves the authoritative description and location", () => {
    const long = "x".repeat(3_000);
    const input = handoffToSubmitInput({
      ...review,
      summary: long,
      findings: [
        {
          id: "f",
          priority: "high",
          title: long,
          body: long,
          location: { path: long, side: "new", startLine: 1, endLine: 1 },
        },
      ],
    });
    const [finding] = input.findings ?? [];
    expect(input.summary!.length).toBeLessThanOrEqual(2_000);
    expect(finding!.title.length).toBeLessThanOrEqual(200);
    expect(finding!.detail).toBe(long);
    expect(finding!.provenance).toEqual({
      findingId: "f",
      reviewedHeadSha: review.headSha,
      diffHash: review.diffHash,
      path: long,
      side: "new",
      startLine: 1,
      endLine: 1,
    });
    expect(finding!.path!.length).toBeLessThanOrEqual(500);
  });

  it("keys differ when any stable content differs", () => {
    const keyOf = (overrides: Partial<Parameters<typeof reviewFindingKey>[0]> = {}) =>
      reviewFindingKey({
        diffHash: "h",
        path: "a.ts",
        side: "new",
        startLine: 2,
        endLine: 2,
        title: "t",
        body: "b",
        priority: "high",
        ...overrides,
      });
    const base = keyOf();
    expect(base).not.toBe(keyOf({ title: "other" }));
    expect(base).not.toBe(keyOf({ body: "other body" }));
    expect(base).not.toBe(keyOf({ priority: "low" }));
    expect(base).not.toBe(keyOf({ path: "b.ts" }));
    expect(base).not.toBe(keyOf({ side: "old" }));
    expect(base).not.toBe(keyOf({ startLine: 3 }));
    expect(base).not.toBe(keyOf({ endLine: 3 }));
    expect(base).not.toBe(keyOf({ diffHash: "h2" }));
    expect(keyOf()).toBe(keyOf());
  });

  it("uses unambiguous structural key encoding", () => {
    const base = {
      diffHash: "h",
      path: "a.ts",
      side: "new" as const,
      startLine: 2,
      endLine: 2,
      priority: "high",
    };
    expect(reviewFindingKey({ ...base, title: "A\nB", body: "C" })).not.toBe(
      reviewFindingKey({ ...base, title: "A", body: "B\nC" }),
    );
  });

  it("findings sharing title and location but differing in body keep distinct keys", () => {
    const collidingReview = {
      ...review,
      findings: [
        ...review.findings,
        { ...review.findings[0]!, id: "finding-dup", body: "Different detail." },
      ],
    };
    const keys = (handoffToSubmitInput(collidingReview).findings ?? []).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const makeEvent = (sequence: number, result: unknown): OrchestrationEvent =>
  ({
    sequence,
    eventId: `evt_${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thr_review",
    type: "thread.review-result-set",
    payload: { threadId: "thr_review", result },
    occurredAt: new Date().toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  }) as unknown as OrchestrationEvent;

const makeNonReviewEvent = (sequence: number): OrchestrationEvent =>
  ({
    ...makeEvent(sequence, parsed()),
    type: "thread.message-sent",
    payload: { threadId: "thr_review", messageId: "msg_1" },
  }) as unknown as OrchestrationEvent;

const waitFor = (predicate: () => boolean, attempts = 750) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) return true;
      yield* Effect.sleep("20 millis");
    }
    return false;
  });

interface Harness {
  readonly calls: readonly PullRequestMonitorSubmitFindingsInput[];
  readonly cursorRows: ReadonlyMap<string, number>;
}

const makeHarness = (options: {
  readonly events: readonly OrchestrationEvent[];
  readonly liveEvents?: readonly OrchestrationEvent[];
  readonly blockReplayUntil?: Deferred.Deferred<void>;
  readonly failReplay?: Error;
  readonly pubsub?: PubSub.PubSub<OrchestrationEvent>;
  readonly publishOnReplayStart?: readonly OrchestrationEvent[];
  readonly autoMonitor?: boolean;
  readonly monitorEnabled?: boolean | null;
  readonly initialCursor?: number;
  readonly getSettings?: () => Effect.Effect<{ autoMonitorPullRequestsOnCreate: boolean }, Error>;
  readonly submitFindings?: (
    input: PullRequestMonitorSubmitFindingsInput,
  ) => Effect.Effect<void, Error>;
}): Harness & { readonly layer: Layer.Layer<never> } => {
  const calls: PullRequestMonitorSubmitFindingsInput[] = [];
  const cursorRows = new Map<string, number>();
  if (options.initialCursor !== undefined) {
    cursorRows.set(REVIEW_HANDOFF_PROJECTOR, options.initialCursor);
  }
  let submit: (input: PullRequestMonitorSubmitFindingsInput) => Effect.Effect<void, Error> = () =>
    Effect.void;
  if (options.submitFindings) {
    const scripted = options.submitFindings;
    submit = scripted;
  }
  const replay =
    options.failReplay !== undefined
      ? Stream.fail(options.failReplay)
      : options.blockReplayUntil !== undefined
        ? Stream.concat(
            Stream.fromIterable(options.events),
            // Drain drops the resolved element so only real events reach process().
            Stream.fromEffect(Deferred.await(options.blockReplayUntil)).pipe(Stream.drain),
          )
        : options.pubsub !== undefined && options.publishOnReplayStart !== undefined
          ? Stream.concat(
              // Publish from inside the replay stream: only a subscription attached
              // before readEvents started can possibly capture these events.
              Stream.fromIterable(options.publishOnReplayStart).pipe(
                Stream.mapEffect((event) => PubSub.publish(options.pubsub!, event)),
                Stream.drain,
              ),
              Stream.fromIterable(options.events),
            )
          : Stream.fromIterable(options.events);
  // Real PubSub mode: acquireDomainEventSubscription performs the synchronous
  // handshake the reactor relies on. Cold mode: a scripted subscription replays
  // liveEvents on take and then blocks, mimicking a quiet hot stream.
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.succeed({ threads: [{ id: "thr_review", projectId: "proj_1" }], projects: [] }),
    readEvents: () => replay,
    streamDomainEvents:
      options.pubsub !== undefined
        ? Stream.fromPubSub(options.pubsub)
        : Stream.fromIterable(options.liveEvents ?? []),
    acquireDomainEventSubscription:
      options.pubsub !== undefined
        ? PubSub.subscribe(options.pubsub)
        : Effect.gen(function* () {
            // Cold mode: a dedicated quiet PubSub whose scripted liveEvents are
            // published only after the subscription is registered.
            const source = yield* PubSub.unbounded<OrchestrationEvent>();
            const subscription = yield* PubSub.subscribe(source);
            yield* Effect.forEach(options.liveEvents ?? [], (event) =>
              PubSub.publish(source, event),
            );
            return subscription;
          }),
  } as unknown as OrchestrationEngineService["Service"]);
  const monitorLayer = Layer.succeed(PullRequestMonitorService, {
    status: () =>
      Effect.succeed({
        monitor:
          options.monitorEnabled === undefined || options.monitorEnabled === null
            ? null
            : ({
                enabled: options.monitorEnabled,
                status: options.monitorEnabled ? "monitoring" : "stopped",
              } as never),
        ownerCandidates: [],
        latestSnapshot: null,
        recentEvents: [],
        openFeedback: [],
        recentDeliveries: [],
        recentReports: [],
      }),
    submitFindings: (input: PullRequestMonitorSubmitFindingsInput) =>
      submit(input).pipe(
        Effect.tap(() => Effect.sync(() => calls.push(input))),
        Effect.as({} as never),
      ),
  } as unknown as PullRequestMonitorService["Service"]);
  const settingsLayer =
    options.getSettings !== undefined
      ? (Layer.succeed(
          ServerSettingsService,
          // Getter so each read can observe a fresh scripted attempt.
          {
            get getSettings() {
              return options.getSettings!();
            },
          } as unknown as ServerSettingsService["Service"],
        ) as never)
      : ServerSettingsService.layerTest({
          autoMonitorPullRequestsOnCreate: options.autoMonitor ?? true,
        });
  const stateLayer = Layer.succeed(ProjectionStateRepository, {
    getByProjector: ({ projector }: { projector: string }) =>
      Effect.succeed(
        cursorRows.has(projector)
          ? Option.some({
              projector,
              lastAppliedSequence: cursorRows.get(projector)!,
              updatedAt: new Date().toISOString(),
            })
          : Option.none(),
      ),
    upsert: (row: { projector: string; lastAppliedSequence: number }) =>
      Effect.sync(() => {
        cursorRows.set(row.projector, row.lastAppliedSequence);
      }),
  } as unknown as ProjectionStateRepository["Service"]);
  return {
    get calls() {
      return calls;
    },
    get cursorRows() {
      return cursorRows;
    },
    layer: layer.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(monitorLayer),
      Layer.provideMerge(settingsLayer as Layer.Layer<never>),
      Layer.provideMerge(stateLayer),
    ) as unknown as Layer.Layer<never>,
  };
};

const runWithLayer = <A, E>(effect: Effect.Effect<A, E, never>, testLayer: Layer.Layer<never>) =>
  Effect.runPromiseExit(Effect.provide(effect, testLayer));

describe("PullRequestReviewHandoffReactor layer", () => {
  it("submits parsed PR findings and advances the durable cursor", async () => {
    const harness = makeHarness({ events: [makeEvent(7, parsed())] });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        expect(harness.calls[0]).toMatchObject({
          reference: { projectId: "proj_1", repository: "acme/app", number: 12 },
          reviewThreadId: "thr_review",
        });
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect((result as { value?: number }).value).toBe(7);
  }, 20_000);

  it("persists findings with monitoring disabled when automatic association monitoring is off", async () => {
    const harness = makeHarness({ events: [makeEvent(3, parsed())], autoMonitor: false });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(harness.calls[0]).toMatchObject({ startMonitoring: false });
    expect((result as { value?: number }).value).toBe(3);
  }, 20_000);

  it("does not resume a stopped monitor as a side effect of delivering review findings", async () => {
    const harness = makeHarness({
      events: [makeEvent(4, parsed())],
      autoMonitor: true,
      monitorEnabled: false,
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(harness.calls[0]).toMatchObject({ startMonitoring: false });
  }, 20_000);

  it("starts monitoring when the setting allows it and no monitor exists", async () => {
    const harness = makeHarness({ events: [makeEvent(4, parsed())], autoMonitor: true });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(harness.calls[0]).toMatchObject({ startMonitoring: true });
  }, 20_000);

  it("does nothing when the review event does not qualify", async () => {
    for (const options of [
      { events: [makeEvent(3, { status: "invalid-output", snapshot, issues: ["bad"] })] },
      { events: [makeEvent(3, parsed([]))] },
      { events: [makeNonReviewEvent(3)] },
    ]) {
      const harness = makeHarness(options);
      const result = await runWithLayer(
        Effect.gen(function* () {
          yield* Effect.sleep("300 millis");
          return harness.calls.length;
        }),
        harness.layer,
      );
      expect(result._tag).toBe("Success");
      expect((result as { value?: number }).value).toBe(0);
    }
  }, 20_000);

  it("retries a transient failure until the idempotent submit succeeds", async () => {
    let attempts = 0;
    const harness = makeHarness({
      events: [makeEvent(5, parsed())],
      submitFindings: () => (++attempts === 1 ? Effect.fail(new Error("transient")) : Effect.void),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length >= 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((result as { value?: number }).value).toBe(5);
  }, 30_000);

  it("leaves the cursor behind a persistently failing event so restart retries it", async () => {
    let attempts = 0;
    const harness = makeHarness({
      events: [makeEvent(9, parsed())],
      submitFindings: () =>
        Effect.gen(function* () {
          attempts += 1;
          return yield* Effect.fail(new Error("permanent"));
        }),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        yield* Effect.sleep("3 seconds");
        return { cursor: harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR), attempts };
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(attempts).toBeGreaterThan(0);
    const value = (result as { value?: { cursor?: number } }).value;
    expect(value?.cursor).toBeUndefined();
  }, 20_000);

  it("resumes from a persisted cursor instead of replaying already-handled events", async () => {
    const harness = makeHarness({
      events: [makeEvent(4, parsed()), makeEvent(7, parsed())],
      initialCursor: 4,
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect((result as { value?: number }).value).toBe(7);
  }, 20_000);

  it("buffers live events until backlog replay completes", async () => {
    const release = await Effect.runPromise(Deferred.make<void>());
    const backlog = parsed([finding({ id: "f-backlog", title: "Backlog" })]);
    const live = parsed([finding({ id: "f-live", title: "Live" })]);
    const harness = makeHarness({
      events: [makeEvent(5, backlog)],
      liveEvents: [makeEvent(9, live)],
      blockReplayUntil: release,
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        yield* Effect.sleep("300 millis");
        // While replay is blocked, only the backlog event may have been handled; a live
        // event handled now would strand the backlog behind sequence 9.
        const duringCatchUp = [...harness.calls];
        yield* Deferred.succeed(release, undefined);
        const delivered = yield* waitFor(() => harness.calls.length === 2);
        expect(delivered).toBe(true);
        return { duringCatchUp, cursor: harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR) };
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    const value = (
      result as {
        value?: {
          duringCatchUp: readonly PullRequestMonitorSubmitFindingsInput[];
          cursor?: number;
        };
      }
    ).value;
    expect(value?.duringCatchUp.map((entry) => entry.findings?.[0]?.title)).toEqual(["Backlog"]);
    expect(value?.cursor).toBe(9);
  }, 20_000);

  it("keeps persistence frozen behind a failed event even when later events succeed", async () => {
    const failing = parsed([finding({ id: "f-a", title: "Failing" })]);
    const succeeding = parsed([finding({ id: "f-b", title: "Succeeding" })]);
    const harness = makeHarness({
      events: [makeEvent(4, failing), makeEvent(7, succeeding)],
      submitFindings: (input) =>
        (input.findings ?? []).some((entry) => entry.title === "Failing")
          ? Effect.fail(new Error("permanent"))
          : Effect.void,
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        // Event 4 exhausts its retries (~30s of backoff); event 7 must still submit.
        const delivered = yield* waitFor(() => harness.calls.length === 1, 3_000);
        expect(delivered).toBe(true);
        expect(harness.calls[0]?.findings?.[0]?.title).toBe("Succeeding");
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    // Nothing may persist past the gap at 4: a restart replays from before it.
    expect((result as { value?: number }).value).toBeUndefined();
  }, 120_000);

  it("captures live events published while replay starts (attach before snapshot)", async () => {
    const pubsub = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
    const live = parsed([finding({ id: "f-live", title: "Live" })]);
    const harness = makeHarness({
      events: [makeEvent(5, parsed())],
      pubsub,
      publishOnReplayStart: [makeEvent(9, live)],
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 2);
        expect(delivered).toBe(true);
        return { cursor: harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR) };
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    // The event published as the replay snapshot was being read must be captured by the
    // live subscription (acquired before readEvents) and processed exactly once.
    const value = (result as { value?: { cursor?: number } }).value;
    expect(value?.cursor).toBe(9);
  }, 20_000);

  it("pauses live handling while backlog replay keeps failing", async () => {
    const harness = makeHarness({
      events: [],
      liveEvents: [makeEvent(9, parsed())],
      failReplay: new Error("store unavailable"),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        yield* Effect.sleep("3 seconds");
        return {
          calls: harness.calls.length,
          cursor: harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR),
        };
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    const value = (result as { value?: { calls: number; cursor?: number } }).value;
    // A failed backlog must never release live handling past it.
    expect(value?.calls).toBe(0);
    expect(value?.cursor).toBeUndefined();
  }, 30_000);

  it("retries a transient settings read failure instead of dropping the findings", async () => {
    let settingsAttempts = 0;
    const harness = makeHarness({
      events: [makeEvent(5, parsed())],
      getSettings: () =>
        ++settingsAttempts === 1
          ? Effect.fail(new Error("transient settings outage"))
          : Effect.succeed({ autoMonitorPullRequestsOnCreate: true }),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1, 3_000);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(settingsAttempts).toBeGreaterThanOrEqual(2);
    expect((result as { value?: number }).value).toBe(5);
  }, 60_000);
});
