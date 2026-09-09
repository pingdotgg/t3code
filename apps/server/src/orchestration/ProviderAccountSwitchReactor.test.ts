import {
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ProviderAccountSwitchReactor from "./ProviderAccountSwitchReactor.ts";

const THREAD_ID = ThreadId.make("thread-account-switch");
const TURN_ID = TurnId.make("turn-1");
const WORK = ProviderInstanceId.make("claude_work");
const PERSONAL = ProviderInstanceId.make("claude_personal");
const AT = "2026-09-02T10:00:00.000Z";

function usageLimits(usedPercent: number, resetsAt?: string): ServerProvider["usageLimits"] {
  return {
    checkedAt: AT,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
    ],
  };
}

function provider(
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId,
    continuation: { groupKey: "claude:session-transcript" },
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const thread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: "project-1" as OrchestrationThread["projectId"],
  title: "Thread",
  modelSelection: { instanceId: WORK, model: "claude-sonnet-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  messages: [
    {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Fix the failing build",
      turnId: TURN_ID,
      streaming: false,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  session: null,
  latestTurn: null,
} as unknown as OrchestrationThread;

function makeHarness(input: {
  readonly autoSwitch: boolean;
  readonly workUsedPercent: number;
  readonly personalUsedPercent?: number;
}) {
  return Effect.gen(function* () {
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([
      provider(WORK, {
        usageLimits: usageLimits(input.workUsedPercent, "2026-09-02T12:00:00.000Z"),
      }),
      provider(PERSONAL, { usageLimits: usageLimits(input.personalUsedPercent ?? 10) }),
    ]);
    const dispatched: OrchestrationCommand[] = [];

    const layer = ProviderAccountSwitchReactor.layer.pipe(
      Layer.provideMerge(
        Layer.mock(ProviderService)({
          get streamEvents() {
            return Stream.fromPubSub(runtimeEvents);
          },
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) => {
            dispatched.push(command as OrchestrationCommand);
            return Effect.succeed(undefined as never);
          },
          subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: (threadId) =>
            Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderRegistry, {
          getProviders: Ref.get(providersRef),
          refresh: () => Ref.get(providersRef),
          refreshInstance: () => Ref.get(providersRef),
          refreshWorkspaceSnapshot: () => Ref.get(providersRef),
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, driver) =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: driver,
                packageName: null,
              }),
            ),
          setProviderMaintenanceActionState: () => Ref.get(providersRef),
          streamChanges: Stream.empty,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({ autoSwitchProviderOnRateLimit: input.autoSwitch }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return { layer, runtimeEvents, domainEvents, dispatched };
  });
}

const turnStartRequestedEvent = {
  eventId: EventId.make("event-turn-start"),
  sequence: 1,
  occurredAt: AT,
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  commandId: null,
  causationEventId: null,
  type: "thread.turn-start-requested",
  payload: {
    threadId: THREAD_ID,
    messageId: MessageId.make("message-1"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: AT,
  },
} as unknown as Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

const failedTurnEvent: ProviderRuntimeEvent = {
  eventId: EventId.make("event-turn-failed"),
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: WORK,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  createdAt: AT,
  type: "turn.completed",
  payload: { state: "failed", errorMessage: "You've hit your limit" },
};

describe("ProviderAccountSwitchReactor", () => {
  it.effect("re-sends a failed turn on a sibling account with usage left", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autoSwitch: true, workUsedPercent: 100 });
      yield* Effect.gen(function* () {
        const reactor = yield* ProviderAccountSwitchReactor.ProviderAccountSwitchReactor;
        yield* reactor.start();
        // Let the forked subscribers attach before publishing.
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.domainEvents, turnStartRequestedEvent);
        yield* PubSub.publish(harness.runtimeEvents, failedTurnEvent);
        yield* reactor.drain;

        assert.equal(harness.dispatched.length, 2);
        const [activity, retry] = harness.dispatched;
        assert.equal(activity?.type, "thread.activity.append");
        if (activity?.type === "thread.activity.append") {
          assert.equal(
            activity.activity.kind,
            ProviderAccountSwitchReactor.PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND,
          );
        }
        assert.equal(retry?.type, "thread.turn.start");
        if (retry?.type === "thread.turn.start") {
          assert.equal(retry.modelSelection?.instanceId, PERSONAL);
          assert.equal(retry.modelSelection?.model, "claude-sonnet-5");
          assert.equal(retry.message.text, "Fix the failing build");
          // Reusing the id keeps one bubble in the transcript.
          assert.equal(retry.message.messageId, "message-1");
        }

        // A second failure for the same turn is never retried again.
        yield* PubSub.publish(harness.runtimeEvents, failedTurnEvent);
        yield* reactor.drain;
        assert.equal(harness.dispatched.length, 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves the turn alone when the account still has usage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autoSwitch: true, workUsedPercent: 80 });
      yield* Effect.gen(function* () {
        const reactor = yield* ProviderAccountSwitchReactor.ProviderAccountSwitchReactor;
        yield* reactor.start();
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.domainEvents, turnStartRequestedEvent);
        yield* PubSub.publish(harness.runtimeEvents, failedTurnEvent);
        yield* reactor.drain;
        assert.equal(harness.dispatched.length, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves the turn alone when auto-switch is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autoSwitch: false, workUsedPercent: 100 });
      yield* Effect.gen(function* () {
        const reactor = yield* ProviderAccountSwitchReactor.ProviderAccountSwitchReactor;
        yield* reactor.start();
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.domainEvents, turnStartRequestedEvent);
        yield* PubSub.publish(harness.runtimeEvents, failedTurnEvent);
        yield* reactor.drain;
        assert.equal(harness.dispatched.length, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not retry when every sibling is also out of usage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        autoSwitch: true,
        workUsedPercent: 100,
        personalUsedPercent: 100,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* ProviderAccountSwitchReactor.ProviderAccountSwitchReactor;
        yield* reactor.start();
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.domainEvents, turnStartRequestedEvent);
        yield* PubSub.publish(harness.runtimeEvents, failedTurnEvent);
        yield* reactor.drain;
        assert.equal(harness.dispatched.length, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
