import { type OrchestrationThreadActivity, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import * as HydeAgentWorkState from "./HydeAgentWorkState.ts";

type CheckpointContextLookup =
  ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadCheckpointContext"];
type LatestActivityLookup = NonNullable<
  ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getLatestThreadActivityByKind"]
>;
type Dispatch = OrchestrationEngine.OrchestrationEngineShape["dispatch"];

class UnexpectedWorkStateTestError extends Schema.TaggedError<UnexpectedWorkStateTestError>()(
  "UnexpectedWorkStateTestError",
  {},
) {}

const threadId = ThreadId.make("hyde-work-state-test-thread");
const projectId = ProjectId.make("hyde-work-state-test-project");

const baseState: HydeAgentWorkState.HydeAgentWorkState = {
  taskIdentity: "work-state-test",
  objective: "verify durable work state",
  stage: "verification",
  decisions: [{ id: "decision-1", summary: "Use the canonical owner" }],
  workItems: [{ id: "work-item-1", summary: "Run focused tests", status: "ready" }],
  workingPaths: ["apps/server/src/roy/autonomy/HydeAgentWorkState.ts"],
  verification: [{ command: "focused test", status: "passed", exitCode: 0 }],
  invariants: ["No provider message is sent"],
  nextAction: "Run the next focused gate",
};

const makeCheckpointContext = (): ProjectionSnapshotQuery.ProjectionThreadCheckpointContext => ({
  threadId,
  projectId,
  workspaceRoot: "/tmp/hyde-work-state-test",
  worktreePath: null,
  checkpoints: [],
});

const makeSnapshots = (
  input: {
    readonly getThreadCheckpointContext?: CheckpointContextLookup;
    readonly latestActivity?: LatestActivityLookup;
  } = {},
): ProjectionSnapshotQuery.ProjectionSnapshotQueryShape =>
  ({
    getThreadCheckpointContext:
      input.getThreadCheckpointContext ??
      (() => Effect.succeed(Option.some(makeCheckpointContext()))),
    getLatestThreadActivityByKind: input.latestActivity ?? (() => Effect.succeed(Option.none())),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

const makeEngine = (
  dispatch: Dispatch = () => Effect.succeed({ sequence: 1 }),
): OrchestrationEngine.OrchestrationEngineShape =>
  ({ dispatch }) as unknown as OrchestrationEngine.OrchestrationEngineShape;

const failingContextLookup =
  (
    error: HydeAgentWorkState.HydeAgentWorkStateUnavailableError | UnexpectedWorkStateTestError,
  ): CheckpointContextLookup =>
  () =>
    Effect.fail(error as unknown as ProjectionRepositoryError);

const isUnavailable = Schema.is(HydeAgentWorkState.HydeAgentWorkStateUnavailableError);
const isRevisionConflict = Schema.is(HydeAgentWorkState.HydeAgentWorkStateRevisionConflictError);
const decodeHydeAgentWorkStateError = Schema.decodeUnknownSync(
  HydeAgentWorkState.HydeAgentWorkStateError,
);

const checkpointInput = (expectedRevision: number) => ({
  expectedRevision,
  state: baseState,
});

describe("HydeAgentWorkState", () => {
  it.effect("loads and decodes the tagged error union", () =>
    Effect.sync(() => {
      const unavailable = new HydeAgentWorkState.HydeAgentWorkStateUnavailableError({
        reason: "capability_unavailable",
      });
      const conflict = new HydeAgentWorkState.HydeAgentWorkStateRevisionConflictError({
        expectedRevision: 1,
        currentRevision: 2,
        currentStateHash: null,
      });
      const decode = decodeHydeAgentWorkStateError;

      const decodedUnavailable = decode(unavailable);
      const decodedConflict = decode(conflict);

      assert.isTrue(isUnavailable(decodedUnavailable));
      if (isUnavailable(decodedUnavailable)) {
        assert.equal(decodedUnavailable.reason, "capability_unavailable");
      }
      assert.isTrue(isRevisionConflict(decodedConflict));
      if (isRevisionConflict(decodedConflict)) {
        assert.equal(decodedConflict.expectedRevision, 1);
      }
    }),
  );

  it.effect("normalizes deterministically and excludes unknown secret fields", () =>
    Effect.sync(() => {
      const first = HydeAgentWorkState.normalizeWorkState({
        ...baseState,
        token: "secret-token",
      });
      const second = HydeAgentWorkState.normalizeWorkState({
        nextAction: baseState.nextAction,
        invariants: baseState.invariants,
        verification: baseState.verification,
        workingPaths: baseState.workingPaths,
        workItems: baseState.workItems,
        decisions: baseState.decisions,
        stage: baseState.stage,
        objective: baseState.objective,
        taskIdentity: baseState.taskIdentity,
      });

      assert.equal(
        HydeAgentWorkState.hashWorkState(first),
        HydeAgentWorkState.hashWorkState(second),
      );
      assert.isFalse(HydeAgentWorkState.canonicalStateJson(first).includes("secret-token"));
    }),
  );

  it.effect("preserves an existing unavailable read error", () =>
    Effect.gen(function* () {
      const expected = new HydeAgentWorkState.HydeAgentWorkStateUnavailableError({
        reason: "capability_unavailable",
      });
      const service = HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(),
        makeSnapshots({
          getThreadCheckpointContext: failingContextLookup(expected),
        }),
      );

      const actual = yield* Effect.flip(service.read(threadId));

      assert.equal(actual, expected);
    }),
  );

  it.effect("maps an unexpected read error to read_failed", () =>
    Effect.gen(function* () {
      const service = HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(),
        makeSnapshots({
          getThreadCheckpointContext: failingContextLookup(new UnexpectedWorkStateTestError()),
        }),
      );

      const actual = yield* Effect.flip(service.read(threadId));

      assert.isTrue(isUnavailable(actual));
      if (isUnavailable(actual)) {
        assert.equal(actual.reason, "read_failed");
      }
    }),
  );

  it.effect("preserves revision conflicts", () =>
    Effect.gen(function* () {
      const service = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), makeSnapshots());

      const actual = yield* Effect.flip(
        service.checkpoint(threadId, "provider-session", "provider-instance", checkpointInput(1)),
      );

      assert.isTrue(isRevisionConflict(actual));
      if (isRevisionConflict(actual)) {
        assert.equal(actual.expectedRevision, 1);
        assert.equal(actual.currentRevision, 0);
      }
    }),
  );

  it.effect("preserves an unavailable write error from loading state", () =>
    Effect.gen(function* () {
      const expected = new HydeAgentWorkState.HydeAgentWorkStateUnavailableError({
        reason: "capability_unavailable",
      });
      const service = HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(),
        makeSnapshots({
          getThreadCheckpointContext: failingContextLookup(expected),
        }),
      );

      const actual = yield* Effect.flip(
        service.checkpoint(threadId, "provider-session", "provider-instance", checkpointInput(0)),
      );

      assert.equal(actual, expected);
    }),
  );

  it.effect("maps an unexpected write error to write_failed", () =>
    Effect.gen(function* () {
      const dispatch: Dispatch = () =>
        Effect.fail(new UnexpectedWorkStateTestError()) as unknown as ReturnType<Dispatch>;
      const service = HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(dispatch),
        makeSnapshots(),
      );

      const actual = yield* Effect.flip(
        service.checkpoint(threadId, "provider-session", "provider-instance", checkpointInput(0)),
      );

      assert.isTrue(isUnavailable(actual));
      if (isUnavailable(actual)) {
        assert.equal(actual.reason, "write_failed");
      }
    }),
  );

  it.effect("constructs the live service layer with fake dependencies", () =>
    Effect.gen(function* () {
      const service = yield* Effect.service(HydeAgentWorkState.HydeAgentWorkStateService).pipe(
        Effect.provide(
          HydeAgentWorkState.HydeAgentWorkStateLive.pipe(
            Layer.provide(
              Layer.succeed(OrchestrationEngine.OrchestrationEngineService, makeEngine()),
            ),
            Layer.provide(
              Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, makeSnapshots()),
            ),
          ),
        ),
      );

      assert.isTrue(typeof service.read === "function");
      assert.isTrue(typeof service.checkpoint === "function");
    }),
  );

  it.effect("saves once, makes identical retries idempotent, and serializes competing writes", () =>
    Effect.gen(function* () {
      let latest: unknown;
      const snapshots = makeSnapshots({
        latestActivity: (({ kind }: Parameters<LatestActivityLookup>[0]) =>
          Effect.succeed(
            kind === HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND
              ? Option.fromNullishOr(latest)
              : Option.none(),
          )) as unknown as LatestActivityLookup,
      });
      const dispatch: Dispatch = (command) =>
        Effect.sync(() => {
          latest = (command as { readonly activity: unknown }).activity;
          return { sequence: 1 };
        });
      const service = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(dispatch), snapshots);

      const first = yield* service.checkpoint(
        threadId,
        "provider-session",
        "provider-instance",
        checkpointInput(0),
      );
      assert.equal(first.revision, 1);
      assert.isTrue(first.changed);

      const identical = yield* service.checkpoint(
        threadId,
        "provider-session",
        "provider-instance",
        checkpointInput(0),
      );
      assert.equal(identical.revision, 1);
      assert.isFalse(identical.changed);

      const changedState = { ...baseState, stage: "second" };
      const results = yield* Effect.all(
        [
          service
            .checkpoint(threadId, "provider-session", "provider-instance", {
              expectedRevision: 1,
              state: changedState,
            })
            .pipe(
              Effect.map((value) => ({ success: value })),
              Effect.catch((error) => Effect.succeed({ error })),
            ),
          service
            .checkpoint(threadId, "provider-session", "provider-instance", {
              expectedRevision: 1,
              state: { ...baseState, stage: "other" },
            })
            .pipe(
              Effect.map((value) => ({ success: value })),
              Effect.catch((error) => Effect.succeed({ error })),
            ),
        ],
        { concurrency: "unbounded" },
      );
      const successes = results.filter((result) => "success" in result);
      const conflicts = results.filter(
        (result) => "error" in result && isRevisionConflict(result.error),
      );
      assert.equal(successes.length, 1);
      assert.equal(conflicts.length, 1);
    }),
  );

  it.effect("turns semantic checkpoint validation into state_invalid", () =>
    Effect.gen(function* () {
      const invalidState: HydeAgentWorkState.HydeAgentWorkState = {
        ...baseState,
        workItems: [{ id: "missing", summary: "blocked", status: "ready", dependsOn: ["absent"] }],
      };
      const actual = yield* Effect.flip(
        HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), makeSnapshots()).checkpoint(
          threadId,
          "provider-session",
          "provider-instance",
          { expectedRevision: 0, state: invalidState },
        ),
      );
      assert.isTrue(isUnavailable(actual));
      if (isUnavailable(actual)) assert.equal(actual.reason, "state_invalid");
    }),
  );

  it.effect("rejects untrusted persisted provenance and chooses newest fallback activity", () =>
    Effect.gen(function* () {
      const state = HydeAgentWorkState.normalizeWorkState(baseState);
      const payload = {
        schemaVersion: "hyde-agent-work-state/v1",
        revision: 1,
        stateHash: HydeAgentWorkState.hashWorkState(state),
        capturedAt: "2026-01-01T00:00:00.000Z",
        writerProviderSessionId: "provider-session",
        writerProviderInstanceId: "provider-instance",
        timelineBypass: true,
        state,
      };
      const activity = (value: unknown, sequence: number) =>
        ({
          id: `activity-${sequence}`,
          threadId,
          turnId: null,
          tone: "info",
          kind: HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND,
          summary: "checkpoint",
          payload: value,
          sequence,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as never;
      const invalidService = HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(),
        makeSnapshots({
          latestActivity: () =>
            Effect.succeed(Option.some(activity({ ...payload, timelineBypass: false }, 1))),
        }),
      );
      const invalid = yield* Effect.flip(invalidService.read(threadId));
      assert.isTrue(isUnavailable(invalid));
      if (isUnavailable(invalid)) assert.equal(invalid.reason, "state_invalid");

      let useFastQuery = false;
      const fallbackService = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), {
        ...makeSnapshots(),
        getLatestThreadActivityByKind: undefined,
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              activities: [
                activity({ ...payload, revision: 1 }, 1),
                activity({ ...payload, revision: 2 }, 2),
              ],
            } as never),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);
      const fallback = yield* fallbackService.read(threadId);
      useFastQuery = fallback.revision === 2;
      assert.isTrue(useFastQuery);
    }),
  );

  it.effect("coalesces concurrent identical checkpoints into one append", () =>
    Effect.gen(function* () {
      let latest: OrchestrationThreadActivity | undefined;
      let appendCount = 0;
      const activity = (payload: unknown) =>
        ({
          id: "identical-checkpoint",
          threadId,
          turnId: null,
          tone: "info",
          kind: HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND,
          summary: "checkpoint",
          payload,
          sequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as never;
      const snapshots = makeSnapshots({
        latestActivity: () => Effect.succeed(Option.fromNullishOr(latest)),
      });
      const dispatch: Dispatch = (command) =>
        Effect.sync(() => {
          appendCount += 1;
          latest = activity(
            (command as { readonly activity: { readonly payload: unknown } }).activity.payload,
          );
          return { sequence: appendCount };
        });
      const service = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(dispatch), snapshots);
      const results = yield* Effect.all(
        [
          service.checkpoint(threadId, "provider-session", "provider-instance", checkpointInput(0)),
          service.checkpoint(threadId, "provider-session", "provider-instance", checkpointInput(0)),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(appendCount, 1);
      assert.equal(results.filter((result) => result.changed).length, 1);
      assert.equal(results.filter((result) => !result.changed).length, 1);
      assert.deepEqual(
        results.map((result) => result.revision),
        [1, 1],
      );
    }),
  );

  it.effect("rejects invalid dependency graphs as typed state_invalid failures", () =>
    Effect.gen(function* () {
      const invalidStates: ReadonlyArray<HydeAgentWorkState.HydeAgentWorkState> = [
        {
          ...baseState,
          decisions: [
            { id: "same", summary: "one" },
            { id: "same", summary: "two" },
          ],
        },
        {
          ...baseState,
          workItems: [
            { id: "same", summary: "one", status: "ready" },
            { id: "same", summary: "two", status: "ready" },
          ],
        },
        {
          ...baseState,
          workItems: [{ id: "a", summary: "missing", status: "ready", dependsOn: ["absent"] }],
        },
        {
          ...baseState,
          workItems: [{ id: "a", summary: "self", status: "ready", dependsOn: ["a"] }],
        },
        {
          ...baseState,
          workItems: [
            { id: "a", summary: "A", status: "ready", dependsOn: ["b"] },
            { id: "b", summary: "B", status: "ready", dependsOn: ["a"] },
          ],
        },
        { ...baseState, workItems: [{ id: "blocked", summary: "blocked", status: "blocked" }] },
      ];
      for (const state of invalidStates) {
        const actual = yield* Effect.flip(
          HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), makeSnapshots()).checkpoint(
            threadId,
            "provider-session",
            "provider-instance",
            { expectedRevision: 0, state },
          ),
        );
        assert.isTrue(isUnavailable(actual));
        if (isUnavailable(actual)) assert.equal(actual.reason, "state_invalid");
      }
      const accepted = yield* HydeAgentWorkState.makeHydeAgentWorkState(
        makeEngine(),
        makeSnapshots(),
      ).checkpoint(threadId, "provider-session", "provider-instance", {
        expectedRevision: 0,
        state: {
          ...baseState,
          workItems: [
            {
              id: "blocked",
              summary: "blocked",
              status: "blocked",
              reason: "waiting for approval",
            },
          ],
        },
      });
      assert.isTrue(accepted.changed);
    }),
  );

  it.effect("enforces the whole-state UTF-8 byte bound", () =>
    Effect.gen(function* () {
      const byteLength = (state: HydeAgentWorkState.HydeAgentWorkState) =>
        new TextEncoder().encode(HydeAgentWorkState.canonicalStateJson(state)).length;
      const seed = {
        ...baseState,
        invariants: Array.from({ length: 15 }, (_, index) => `${index}${"x".repeat(1_998)}`),
      };
      let below: HydeAgentWorkState.HydeAgentWorkState = seed;
      while (below.nextAction.length < 4_000) {
        const candidate = { ...below, nextAction: `${below.nextAction}x` };
        if (byteLength(candidate) >= 32_768) break;
        below = candidate;
      }
      const above = { ...below, nextAction: `${below.nextAction}xx` };
      assert.isTrue(byteLength(below) < 32_768);
      assert.isTrue(byteLength(above) > 32_768);
      assert.deepEqual(HydeAgentWorkState.normalizeWorkState(below), below);
      const actual = yield* Effect.flip(
        HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), makeSnapshots()).checkpoint(
          threadId,
          "provider-session",
          "provider-instance",
          { expectedRevision: 0, state: above },
        ),
      );
      assert.isTrue(isUnavailable(actual));
      if (isUnavailable(actual)) assert.equal(actual.reason, "state_invalid");
    }),
  );

  it.effect("returns the newest checkpoint and compaction evidence with bounded files", () =>
    Effect.gen(function* () {
      const state = HydeAgentWorkState.normalizeWorkState(baseState);
      const statePayload = {
        schemaVersion: "hyde-agent-work-state/v1",
        revision: 1,
        stateHash: HydeAgentWorkState.hashWorkState(state),
        capturedAt: "2026-01-01T00:00:00.000Z",
        writerProviderSessionId: "provider-session",
        writerProviderInstanceId: "provider-instance",
        sourceCheckpoint: {
          checkpointRef: "checkpoint-9",
          checkpointTurnCount: 9,
          status: "completed",
          completedAt: "2026-01-01T00:00:09.000Z",
        },
        timelineBypass: true,
        state,
      };
      const activity = (kind: string, payload: unknown, sequence: number) =>
        ({
          id: `activity-${sequence}`,
          threadId,
          turnId: null,
          tone: "info",
          kind,
          summary: "activity",
          payload,
          sequence,
          createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
        }) as never;
      const files = Array.from({ length: 101 }, (_, index) => ({
        path: `file-${index}`,
        kind: "modified",
        additions: 1,
        deletions: 0,
      }));
      const context = {
        ...makeCheckpointContext(),
        checkpoints: [
          {
            turnId: "turn-8",
            checkpointTurnCount: 8,
            checkpointRef: "checkpoint-8",
            status: "completed",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:08.000Z",
          },
          {
            turnId: "turn-9",
            checkpointTurnCount: 9,
            checkpointRef: "checkpoint-9",
            status: "completed",
            files,
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:09.000Z",
          },
        ],
      } as unknown as ProjectionSnapshotQuery.ProjectionThreadCheckpointContext;
      const service = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), {
        ...makeSnapshots(),
        getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
        getLatestThreadActivityByKind: undefined,
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              activities: [
                activity(HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND, statePayload, 1),
                activity(
                  "context-compaction",
                  { summary: "old compaction", beforeTokens: 8000, afterTokens: 4000 },
                  2,
                ),
                activity(
                  "context-compaction",
                  { summary: "new compaction", beforeTokens: 12000, afterTokens: 5000 },
                  3,
                ),
              ],
            } as never),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);
      const result = yield* service.read(threadId);
      assert.equal(result.currentCheckpoint?.checkpointTurnCount, 9);
      assert.equal(result.currentCheckpoint?.files.length, 100);
      assert.isTrue(result.currentCheckpoint?.filesTruncated === true);
      assert.isTrue(result.sourceCheckpointMatchesCurrent === true);
      assert.deepEqual(result.lastCompaction, {
        createdAt: "2026-01-01T00:00:03.000Z",
        summary: "new compaction",
        beforeTokens: 12000,
        afterTokens: 5000,
      });

      const drift = yield* HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(), {
        ...makeSnapshots({
          getThreadCheckpointContext: () =>
            Effect.succeed(
              Option.some({
                ...context,
                checkpoints: [{ ...context.checkpoints[1]!, checkpointTurnCount: 10 }],
              } as never),
            ),
          latestActivity: ({ kind }) =>
            Effect.succeed(
              kind === HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND
                ? Option.some(
                    activity(
                      HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND,
                      statePayload,
                      1,
                    ),
                  )
                : Option.none(),
            ),
        }),
      } as never).read(threadId);
      assert.isTrue(drift.sourceCheckpointMatchesCurrent === false);
    }),
  );

  it.effect("isolates threads and rejects malformed durable activities", () =>
    Effect.gen(function* () {
      const threadA = ThreadId.make("hyde-work-state-thread-a");
      const threadB = ThreadId.make("hyde-work-state-thread-b");
      let stored: unknown;
      const dispatch: Dispatch = (command) =>
        Effect.sync(() => {
          stored = (command as { readonly activity: unknown }).activity;
          return { sequence: 1 };
        });
      const isolated = HydeAgentWorkState.makeHydeAgentWorkState(makeEngine(dispatch), {
        ...makeSnapshots({
          getThreadCheckpointContext: () => Effect.succeed(Option.some(makeCheckpointContext())),
        }),
        getLatestThreadActivityByKind: (({
          threadId: requestedThreadId,
          kind,
        }: Parameters<LatestActivityLookup>[0]) =>
          Effect.succeed(
            requestedThreadId === threadA &&
              kind === HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND
              ? Option.fromNullishOr(stored)
              : Option.none(),
          )) as unknown as LatestActivityLookup,
      });
      const saved = yield* isolated.checkpoint(
        threadA,
        "provider-session",
        "provider-instance",
        checkpointInput(0),
      );
      assert.equal(saved.revision, 1);
      assert.isFalse((yield* isolated.read(threadB)).present);

      const state = HydeAgentWorkState.normalizeWorkState(baseState);
      const good = {
        schemaVersion: "hyde-agent-work-state/v1",
        revision: 1,
        stateHash: HydeAgentWorkState.hashWorkState(state),
        capturedAt: "2026-01-01T00:00:00.000Z",
        writerProviderSessionId: "provider-session",
        writerProviderInstanceId: "provider-instance",
        timelineBypass: true,
        state,
      };
      const activity = (payload: unknown) =>
        ({
          id: "malformed",
          threadId,
          turnId: null,
          tone: "info",
          kind: HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND,
          summary: "checkpoint",
          payload,
          sequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as never;
      const malformed = [
        { revision: 0 },
        { revision: 1.5 },
        { stateHash: "A".repeat(64) },
        { stateHash: "0".repeat(64) },
        { writerProviderSessionId: "" },
        { writerProviderInstanceId: "" },
        { timelineBypass: false },
        {
          sourceCheckpoint: {
            checkpointRef: "checkpoint",
            checkpointTurnCount: 1.5,
            status: "completed",
            completedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          sourceCheckpoint: {
            checkpointRef: "",
            checkpointTurnCount: 1,
            status: "completed",
            completedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ];
      for (const override of malformed) {
        const service = HydeAgentWorkState.makeHydeAgentWorkState(
          makeEngine(),
          makeSnapshots({
            latestActivity: ({ kind }) =>
              Effect.succeed(
                kind === HydeAgentWorkState.HYDE_AGENT_WORK_STATE_ACTIVITY_KIND
                  ? Option.some(activity({ ...good, ...override }))
                  : Option.none(),
              ),
          }),
        );
        const actual = yield* Effect.flip(service.read(threadId));
        assert.isTrue(isUnavailable(actual));
        if (isUnavailable(actual)) assert.equal(actual.reason, "state_invalid");
      }
    }),
  );
});
