import { Session } from "@opencode/client/effect";
import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { OPENCODE_PROVIDER } from "../adapter.ts";
import { makeConfig } from "./session/config.ts";
import { makeLifecycle } from "./session/lifecycle.ts";
import { makeThreadHistory } from "./session/history.ts";
import { makeProjections } from "./session/projections.ts";
import { makeRequests } from "./session/requests.ts";
import { makeRouting } from "./session/routing.ts";
import { makeRuntime } from "./session/runtime.ts";
import { createSessionState } from "./session/state.ts";
import { makeTurnStart } from "./session/turnStart.ts";
import { makeTurns } from "./session/turns.ts";
import { OpenCode2ProviderCapabilities } from "./capabilities.ts";
import { t3McpServerName } from "./session/protocol.ts";

export { OPENCODE_2_STILL_STOPPING, t3McpServerName } from "./session/protocol.ts";

export const make = Effect.fn("OpenCode2Adapter.make")(function* (instanceId: ProviderInstanceId) {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const fileSystem = yield* FileSystem.FileSystem;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const crypto = yield* Digest.Digest;
  const driver = OPENCODE_PROVIDER;
  const mcpServerNameFor = (threadId: string) =>
    t3McpServerName(threadId).pipe(Effect.provideService(Digest.Digest, crypto));

  const borrow = Effect.gen(function* () {
    const lent = yield* Deferred.make<
      OpenCode2Server.OpenCode2Connection,
      OpenCodeRuntime.OpenCodeRuntimeError
    >();
    yield* server
      .withConnection((connection) =>
        Deferred.succeed(lent, connection).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(
        Effect.catch((error) => Deferred.fail(lent, error)),
        Effect.forkScoped,
      );
    return yield* Deferred.await(lent);
  });

  const openSession = Effect.fn("OpenCode2Adapter.openSession")(function* (
    input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0],
    initial: {
      readonly connection: OpenCode2Server.OpenCode2Connection;
      readonly scope: Scope.Closeable;
    },
  ) {    const state = yield* createSessionState({
      instanceId,
      driver,
      host,
      idAllocator,
      mcpSessions,
      fileSystem,
      continuationRequests,
      mcpServerNameFor,
      borrow,
      input,
      initial,
    });
    const live = state.live;

    // Installed in dependency order; each layer may call every layer above it.
    const withProjections = Object.assign(state, makeProjections(state));
    const withConfig = Object.assign(withProjections, makeConfig(withProjections));
    const withTurns = Object.assign(withConfig, makeTurns(withConfig));
    const withRequests = Object.assign(withTurns, makeRequests(withTurns));
    const withRouting = Object.assign(withRequests, makeRouting(withRequests));
    const withLifecycle = Object.assign(withRouting, makeLifecycle(withRouting));
    const withTurnStart = Object.assign(withLifecycle, makeTurnStart(withLifecycle));
    const withHistory = Object.assign(withTurnStart, makeThreadHistory(withTurnStart));
    const { follow, readModels, removeMcp, threads } = withHistory;

    yield* Effect.addFinalizer(() => Scope.close(live.currentScope, Exit.void));
    // Subscribed before any session or prompt call, so no event of theirs is missed.
    yield* follow(yield* live.connection.events).pipe(Effect.forkScoped);

    // External servers outlive T3; stop their turns before losing observation.
    if (live.connection.external) {
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...threads].filter(([, thread]) => thread.active !== undefined),
          ([sessionId]) =>
            live.client.session
              .interrupt({ sessionID: Session.ID.make(sessionId) })
              .pipe(Effect.timeout("1 second"), Effect.ignore({ log: true })),
          { concurrency: 8, discard: true },
        ),
      );
    }

    yield* readModels(live.session.cwd);

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...threads.values()].flatMap((thread) => (thread.mcp === undefined ? [] : [thread.mcp])),
        removeMcp,
        { concurrency: 8, discard: true },
      ),
    );

    return makeRuntime(withHistory);

  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("OpencodeAdapter.getCapabilities")(function () {
      return Effect.succeed(OpenCode2ProviderCapabilities);
    }),
    planSelectionTransition: Effect.fn("OpencodeAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    // The session borrows the instance's server for as long as it is open, so a
    // spawned server is not idle-stopped under a long tool call.
    openSession: Effect.fn("OpenCode2Adapter.borrowAndOpenSession")(
      function* (input) {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const connection = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        return yield* openSession(input, { connection, scope });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
