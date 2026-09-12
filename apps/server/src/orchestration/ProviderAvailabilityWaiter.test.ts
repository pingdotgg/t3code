import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PendingProviderTurn,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { pendingProviderTurnSummary } from "@t3tools/shared/pendingProviderTurn";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { expect, describe } from "vite-plus/test";
import { it } from "@effect/vitest";

import * as ProviderAvailabilityWaiter from "./ProviderAvailabilityWaiter.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

describe("ProviderAvailabilityWaiter", () => {
  it.live("refreshes cached available quota before periodic admission", () =>
    Effect.gen(function* () {
      const observed = yield* Deferred.make<void>();
      const now = DateTime.formatIso(yield* DateTime.now);
      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");
      const pendingTurn: PendingProviderTurn = {
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text: "Wait",
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      };
      const thread: OrchestrationThreadShell = {
        id: ThreadId.make("queued"),
        projectId: ProjectId.make("project"),
        title: "Queued",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        pendingProviderTurn: pendingProviderTurnSummary(pendingTurn),
      };
      let provider: ServerProvider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        version: null,
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: now,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              resetsAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      };
      let refreshes = 0;
      let releases = 0;
      const registry = {
        ...makeProviderRegistryMock(),
        getProviders: Effect.sync(() => [provider]),
        refreshInstance: () =>
          Effect.gen(function* () {
            refreshes += 1;
            provider = {
              ...provider,
              usageLimits: {
                checkedAt: now,
                windows: [
                  {
                    id: "primary",
                    kind: "session",
                    label: "Session",
                    usedPercent: 100,
                    resetsAt: "2099-01-01T00:00:00.000Z",
                  },
                ],
              },
            };
            yield* Deferred.succeed(observed, undefined);
            return [provider];
          }),
      };
      const waiter = yield* ProviderAvailabilityWaiter.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, registry),
            Layer.mock(ProjectionSnapshotQuery)({
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [thread],
                  updatedAt: now,
                }),
              getThreadShellById: () => Effect.succeed(Option.some(thread)),
              getPendingProviderTurn: () => Effect.succeed(Option.some(Option.some(pendingTurn))),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: () =>
                Effect.gen(function* () {
                  releases += 1;
                  yield* Deferred.succeed(observed, undefined);
                  return { sequence: 1 };
                }),
            }),
          ),
        ),
      );
      yield* waiter.start;
      yield* Deferred.await(observed);
      yield* waiter.drain;
      expect(refreshes).toBe(1);
      expect(releases).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("confirms a cached-available window with a fresh check before releasing", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");
      const pendingTurn: PendingProviderTurn = {
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text: "Wait",
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      };
      const thread: OrchestrationThreadShell = {
        id: ThreadId.make("queued"),
        projectId: ProjectId.make("project"),
        title: "Queued",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        pendingProviderTurn: pendingProviderTurnSummary(pendingTurn),
      };
      // The cached snapshot claims capacity; only a fresh read reveals the
      // account is still exhausted. A non-refreshing trigger must escalate
      // instead of releasing on the stale window.
      let provider: ServerProvider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        version: null,
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: now,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              resetsAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      };
      let refreshes = 0;
      let releases = 0;
      const waiter = yield* ProviderAvailabilityWaiter.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, {
              ...makeProviderRegistryMock(),
              getProviders: Effect.sync(() => [provider]),
              refreshInstance: () =>
                Effect.sync(() => {
                  refreshes += 1;
                  provider = {
                    ...provider,
                    usageLimits: {
                      checkedAt: now,
                      windows: [
                        {
                          id: "primary",
                          kind: "session",
                          label: "Session",
                          usedPercent: 100,
                          resetsAt: "2099-01-01T00:00:00.000Z",
                        },
                      ],
                    },
                  };
                  return [provider];
                }),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [],
                  updatedAt: now,
                }),
              getThreadShellById: () => Effect.succeed(Option.some(thread)),
              getPendingProviderTurn: () => Effect.succeed(Option.some(Option.some(pendingTurn))),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: () =>
                Effect.sync(() => {
                  releases += 1;
                  return { sequence: releases };
                }),
            }),
          ),
        ),
      );
      // No waiter.start: the worker runs from make, so onEvent alone drives a
      // non-refreshing check — no periodic or streamChanges interference.
      const queued: OrchestrationEvent = {
        type: "thread.turn-queued",
        sequence: 1,
        eventId: EventId.make("queued"),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: now,
        commandId: CommandId.make("queue"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: thread.id, turn: pendingTurn },
      };
      yield* waiter.onEvent(queued);
      yield* waiter.drain;
      // The escalated fresh check ran and the stale snapshot never released.
      expect(refreshes).toBe(1);
      expect(releases).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not release when the refresh recovers with cached data", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");
      const pendingTurn: PendingProviderTurn = {
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text: "Wait",
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      };
      const thread: OrchestrationThreadShell = {
        id: ThreadId.make("queued"),
        projectId: ProjectId.make("project"),
        title: "Queued",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        pendingProviderTurn: pendingProviderTurnSummary(pendingTurn),
      };
      const provider: ServerProvider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        version: null,
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: now,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              resetsAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      };
      let refreshes = 0;
      let releases = 0;
      const waiter = yield* ProviderAvailabilityWaiter.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, {
              ...makeProviderRegistryMock(),
              getProviders: Effect.sync(() => [provider]),
              // A failed refresh recovers with the same cached entry — the
              // identical reference means no fresh read confirmed capacity.
              refreshInstance: () =>
                Effect.sync(() => {
                  refreshes += 1;
                  return [provider];
                }),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [],
                  updatedAt: now,
                }),
              getThreadShellById: () => Effect.succeed(Option.some(thread)),
              getPendingProviderTurn: () => Effect.succeed(Option.some(Option.some(pendingTurn))),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: () =>
                Effect.sync(() => {
                  releases += 1;
                  return { sequence: releases };
                }),
            }),
          ),
        ),
      );
      const queued: OrchestrationEvent = {
        type: "thread.turn-queued",
        sequence: 1,
        eventId: EventId.make("queued"),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: now,
        commandId: CommandId.make("queue"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: thread.id, turn: pendingTurn },
      };
      yield* waiter.onEvent(queued);
      yield* waiter.drain;
      expect(refreshes).toBe(1);
      expect(releases).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("dispatches one release per handoff and re-arms when the wait is re-queued", () =>
    Effect.gen(function* () {
      const releasedOnce = yield* Deferred.make<void>();
      const releasedTwice = yield* Deferred.make<void>();
      const now = DateTime.formatIso(yield* DateTime.now);
      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");
      const pendingProviderTurn: PendingProviderTurn = {
        message: {
          messageId: MessageId.make("message"),
          role: "user" as const,
          text: "Wait",
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        createdAt: now,
      };
      const thread: OrchestrationThreadShell = {
        id: ThreadId.make("queued"),
        projectId: ProjectId.make("project"),
        title: "Queued",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        pendingProviderTurn: pendingProviderTurnSummary(pendingProviderTurn),
      };
      const provider: ServerProvider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        version: null,
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: now,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              resetsAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      };
      const updates = yield* PubSub.unbounded<readonly ServerProvider[]>();
      let releases = 0;
      const waiter = yield* ProviderAvailabilityWaiter.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, {
              ...makeProviderRegistryMock(),
              getProviders: Effect.sync(() => [provider]),
              // A real refresh always lands a new snapshot object; returning
              // the same entry reads as "no fresh data" to the waiter.
              refreshInstance: () => Effect.succeed([{ ...provider }]),
              streamChanges: Stream.fromPubSub(updates),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [thread],
                  updatedAt: now,
                }),
              getThreadShellById: () => Effect.succeed(Option.some(thread)),
              getPendingProviderTurn: () =>
                Effect.succeed(Option.some(Option.some(pendingProviderTurn))),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: () =>
                Effect.gen(function* () {
                  releases += 1;
                  if (releases === 1) yield* Deferred.succeed(releasedOnce, undefined);
                  if (releases === 2) yield* Deferred.succeed(releasedTwice, undefined);
                  return { sequence: releases };
                }),
            }),
          ),
        ),
      );
      yield* waiter.start;
      yield* Deferred.await(releasedOnce);
      yield* waiter.drain;
      expect(releases).toBe(1);
      // The handoff is unresolved, so provider-change checks must not release again.
      yield* PubSub.publish(updates, [provider]);
      yield* waiter.drain;
      expect(releases).toBe(1);
      // A re-asserted wait makes the thread eligible for a fresh release.
      const requeued: OrchestrationEvent = {
        type: "thread.turn-queued",
        sequence: 2,
        eventId: EventId.make("requeued"),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: now,
        commandId: CommandId.make("requeue"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: thread.id, turn: pendingProviderTurn },
      };
      yield* waiter.onEvent(requeued);
      yield* Deferred.await(releasedTwice);
      yield* waiter.drain;
      expect(releases).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
