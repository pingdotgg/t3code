import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PullRequestMonitorSnapshot } from "../sourceControl/gitHubPullRequestMonitor.ts";
import * as MonitorRegistry from "./MonitorRegistry.ts";
import { cursorFromSnapshot } from "./monitorDiff.ts";
import { make, PullRequestSnapshotFetcher } from "./PullRequestMonitor.ts";

const threadId = ThreadId.make("monitor-thread");
const now = "2026-07-23T00:00:00.000Z";

const snapshot = (
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot => ({
  state: "open",
  draft: false,
  headSha: "head-1",
  mergeability: "mergeable",
  behindBaseBy: null,
  requiredChecksKnown: true,
  reviews: [],
  reviewThreads: [],
  issueComments: [],
  checkRuns: [
    {
      id: "ci-1",
      name: "CI",
      status: "in-progress",
      conclusion: null,
      startedAt: now,
      headSha: "head-1",
    },
  ],
  ...overrides,
});

const comment = (id: string) => ({
  id,
  author: { login: "bugbot", type: "app" as const },
  body: `Finding ${id}`,
  path: "src/file.ts",
  line: 12,
  createdAt: now,
  updatedAt: now,
  resolved: false,
});

const thread = (busy = false): OrchestrationThread => ({
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Monitor",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo",
  latestTurn: busy
    ? {
        turnId: TurnId.make("busy-turn"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      }
    : null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  monitor: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const harness = Effect.fn("PullRequestMonitor.testHarness")(function* (input: {
  readonly initial: PullRequestMonitorSnapshot;
  readonly current: { value: PullRequestMonitorSnapshot };
  readonly wakeCount?: number;
  readonly failWake?: boolean;
  readonly busy?: { value: boolean };
  readonly afterUpdate?: () => void;
  readonly changeGenerationAfterUpdate?: boolean;
}) {
  let registration: MonitorRegistry.MonitorRegistration | undefined = {
    threadId,
    prNumber: 42,
    generation: 1,
    cursor: cursorFromSnapshot(input.initial),
    wakeCount: input.wakeCount ?? 0,
    repoCwd: "/repo",
  };
  const commands: OrchestrationCommand[] = [];
  const ordering: string[] = [];
  const registry = MonitorRegistry.MonitorRegistry.of({
    registerIfAbsent: (next) =>
      Effect.sync(() => {
        if (registration !== undefined) return false;
        registration = next;
        return true;
      }),
    removeGeneration: (_, generation) =>
      Effect.sync(() => {
        if (registration?.generation === generation) registration = undefined;
      }),
    get: () => Effect.sync(() => (registration ? Option.some(registration) : Option.none())),
    updateCursor: (_, cursor) =>
      Effect.sync(() => {
        ordering.push("ack");
        if (registration) registration = { ...registration, cursor };
      }),
    incrementWake: () =>
      Effect.sync(() => {
        const count = (registration?.wakeCount ?? 0) + 1;
        if (registration) registration = { ...registration, wakeCount: count };
        return count;
      }),
    remove: () =>
      Effect.sync(() => {
        const removed = registration ? Option.some(registration) : Option.none();
        registration = undefined;
        return removed;
      }),
    listActive: Effect.sync(() => (registration ? [registration] : [])),
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
    dispatch: (command) => {
      commands.push(command);
      if (command.type === "thread.monitor.update") {
        input.afterUpdate?.();
        if (input.changeGenerationAfterUpdate && registration) {
          registration = { ...registration, generation: registration.generation + 1 };
        }
      }
      if (command.type === "thread.turn.start") {
        ordering.push("dispatch");
        if (input.failWake) {
          return Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "rejected",
            }),
          );
        }
      }
      return Effect.succeed({ sequence: commands.length });
    },
  });
  const monitor = yield* make.pipe(
    Effect.provideService(MonitorRegistry.MonitorRegistry, registry),
    Effect.provideService(PullRequestSnapshotFetcher, {
      fetch: () => Effect.succeed(input.current.value),
    }),
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () =>
            Effect.succeed(Option.some(thread(input.busy?.value ?? false))),
        }),
        NodeServices.layer,
      ),
    ),
  );
  return { monitor, commands, ordering, getRegistration: () => registration };
});

const endReason = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.find((command) => command.type === "thread.monitor.end");

describe("PullRequestMonitor dispatch protocol", () => {
  it.effect("terminal-discards-cycle", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ state: "merged", reviewThreads: [comment("late")] }) },
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(endReason(h.commands)?.type, "thread.monitor.end");
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
    }),
  );

  it.effect("ready-ends after a final update", () =>
    Effect.gen(function* () {
      const ready = snapshot({
        checkRuns: [{ ...snapshot().checkRuns[0]!, status: "completed", conclusion: "success" }],
      });
      const h = yield* harness({ initial: snapshot(), current: { value: ready } });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(
        h.commands.map((command) => command.type),
        ["thread.monitor.update", "thread.monitor.end"],
      );
    }),
  );

  it.effect("wake-then-ack ordering", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
      });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(h.ordering, ["dispatch", "ack"]);
      assert.strictEqual(h.getRegistration()?.wakeCount, 1);
    }),
  );

  it.effect("failed-dispatch-preserves-cursor", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        failWake: true,
      });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(initial));
      assert.strictEqual(h.getRegistration()?.wakeCount, 0);
    }),
  );

  it.effect("user-turn-discards-pending-wake", () =>
    Effect.gen(function* () {
      const busy = { value: true };
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        busy,
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(snapshot()));
    }),
  );

  it.effect("generation-change-discards", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        changeGenerationAfterUpdate: true,
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
    }),
  );

  it.effect("coalesces events while a wake is in flight", () =>
    Effect.gen(function* () {
      const current = { value: snapshot({ reviewThreads: [comment("one")] }) };
      const h = yield* harness({ initial: snapshot(), current });
      yield* h.monitor.pollOnce;
      current.value = snapshot({
        reviewThreads: [comment("one"), comment("two"), comment("three")],
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
      yield* h.monitor.handleDomainEvent({
        sequence: 1,
        eventId: EventId.make("session-ready"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("session-ready"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });
      yield* h.monitor.pollOnce;
      const wakes = h.commands.filter((command) => command.type === "thread.turn.start");
      assert.strictEqual(wakes.length, 2);
      assert.match(wakes[1]!.message.text, /Finding two/);
      assert.match(wakes[1]!.message.text, /Finding three/);
    }),
  );

  it.effect("breaker-at-10", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        wakeCount: 10,
      });
      yield* h.monitor.pollOnce;
      const ended = endReason(h.commands);
      assert.strictEqual(ended?.type === "thread.monitor.end" && ended.reason, "needs-attention");
    }),
  );
});
