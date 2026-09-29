import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkitHandlersLive } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const NEXT_TURN_ID = TurnId.make("turn-2");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeSession(
  activeTurnId: TurnId | null,
): NonNullable<OrchestrationThreadShell["session"]> {
  return {
    threadId: THREAD_ID,
    status: activeTurnId === null ? "ready" : "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function sessionSet(activeTurnId: TurnId | null): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.make(`event-session-${activeTurnId ?? "ready"}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-08-20T00:01:00.000Z",
    commandId: CommandId.make("provider:session-set"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: { threadId: THREAD_ID, session: makeSession(activeTurnId) },
  };
}

const makeHarness = Effect.fn("makeThreadToolkitHarness")(function* (
  thread: OrchestrationThreadShell,
  options: { readonly reject?: boolean } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  // Receipts for the deferred archive: it subscribed, and it finished waiting.
  const subscribed = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      if (options.reject) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread is already archived.",
        });
      }
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map(Stream.fromSubscription),
        Effect.tap(() => Deferred.succeed(subscribed, undefined)),
        Effect.tap(() => Effect.addFinalizer(() => Deferred.succeed(released, undefined))),
      ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  // Keep the handler layer open for the whole test: deferred archives run in its scope.
  const context = yield* Layer.build(ThreadToolkitHandlersLive.pipe(Layer.provide(dependencies)));
  const toolkit = yield* ThreadToolkit.pipe(Effect.provide(context));
  const archiveThread = (
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["thread"],
  ) =>
    toolkit.handle("archive_thread", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, events, subscribed, released, archiveThread };
});

describe("thread toolkit handlers", () => {
  it.effect("refuses a credential without the thread capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread());
      const error = yield* harness.archiveThread(["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "thread",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("archives the token's thread right away when no turn is running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread({ session: makeSession(null) }));
      expect(yield* harness.archiveThread()).toEqual({
        threadId: THREAD_ID,
        alreadyArchived: false,
        scheduled: false,
      });
      const commands = yield* Ref.get(harness.commands);
      expect(commands).toMatchObject([{ type: "thread.archive", threadId: THREAD_ID }]);
      expect(commands[0]?.commandId).toMatch(/^server:mcp-thread-archive:thread-1:/);
    }),
  );

  it.effect("reports an archived thread without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread({ archivedAt: "2026-08-21T00:00:00.000Z" }));
      expect(yield* harness.archiveThread()).toEqual({
        threadId: THREAD_ID,
        alreadyArchived: true,
        scheduled: false,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("treats a thread archived concurrently as already archived", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread(), { reject: true });
      expect(yield* harness.archiveThread()).toEqual({
        threadId: THREAD_ID,
        alreadyArchived: true,
        scheduled: false,
      });
    }),
  );

  it.effect("defers a mid-turn archive until that turn ends", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread({ session: makeSession(TURN_ID) }));
      expect(yield* harness.archiveThread()).toEqual({
        threadId: THREAD_ID,
        alreadyArchived: false,
        scheduled: true,
      });
      yield* Deferred.await(harness.subscribed);
      expect(yield* Ref.get(harness.commands)).toEqual([]);

      // Events for other threads and for the same turn keep it waiting.
      yield* PubSub.publish(harness.events, {
        ...sessionSet(null),
        aggregateId: ThreadId.make("thread-other"),
      });
      yield* PubSub.publish(harness.events, sessionSet(TURN_ID));
      yield* PubSub.publish(harness.events, sessionSet(null));
      yield* Deferred.await(harness.released);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.archive", threadId: THREAD_ID },
      ]);
    }),
  );

  it.effect("cancels a deferred archive when a new turn starts first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(makeThread({ session: makeSession(TURN_ID) }));
      expect(yield* harness.archiveThread()).toMatchObject({ scheduled: true });
      yield* Deferred.await(harness.subscribed);

      yield* PubSub.publish(harness.events, sessionSet(NEXT_TURN_ID));
      yield* Deferred.await(harness.released);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
