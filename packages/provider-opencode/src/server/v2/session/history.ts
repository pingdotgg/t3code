/**
 * Thread history for one OpenCode 2 provider session: native snapshots and forks.
 */
import {
  AbsolutePath,
  Session,
  SessionMessage,
} from "@opencode/client/effect";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../../adapter.ts";
import {
  boundaryAfter,
  isProviderAdapterError,
  ref,
  sessionIdOf,
} from "./protocol.ts";
import type { State } from "./state.ts";
import type { Projections } from "./projections.ts";
import type { Config } from "./config.ts";
import type { Turns } from "./turns.ts";
import type { Requests } from "./requests.ts";
import type { Routing } from "./routing.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { TurnStart } from "./turnStart.ts";

export const makeThreadHistory = (
  deps: State & Projections & Config & Turns & Requests & Routing & Lifecycle & TurnStart,
) => {
  const {
    driver,
    ensureQuiet,
    exclusive,
    idAllocator,
    input,
    instanceId,
    live,
    register,
    snapshotOf,
    userMessages,
    writeRules,
  } = deps;

  const readThreadSnapshot = Effect.fn("OpenCode2Adapter.readThreadSnapshot")(
    function* ({ providerThread }: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput) {
      const sessionId = yield* sessionIdOf(providerThread);
      return yield* snapshotOf(providerThread, sessionId);
    },
    (effect, { providerThread }) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProviderAdapterError(cause)
            ? cause
            : new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver,
                providerThreadId: providerThread.id,
                cause,
              }),
        ),
      ),
  );

  const forkThread = Effect.fn("OpenCode2Adapter.forkThread")(
    function* (forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
      const source = forkInput.sourceProviderThread;
      const sourceId = yield* sessionIdOf(source);
      // Fork only quiet history; OpenCode otherwise copies partially written runs.
      yield* ensureQuiet(sourceId, "fork");
      const selected =
        forkInput.providerTurnId === undefined
          ? undefined
          : forkInput.sourceProviderTurns?.find((turn) => turn.id === forkInput.providerTurnId);
      if (forkInput.providerTurnId !== undefined && selected === undefined) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
        });
      }
      const before =
        selected === undefined
          ? null
          : yield* boundaryAfter(
              forkInput.sourceProviderTurns ?? [],
              source.id,
              selected,
              yield* userMessages(sourceId, ["user", "synthetic"]),
            );
      const forked = yield* live.client.session.fork({
        sessionID: Session.ID.make(sourceId),
        ...(before === null ? {} : { before: SessionMessage.ID.make(before) }),
      });
      const createdAt = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({ driver, nativeThreadId: forked.id }),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: forkInput.targetThreadId,
        ownerNodeId: forkInput.ownerNodeId ?? null,
        nativeThreadRef: ref(forked.id),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: {
          providerThreadId: source.id,
          ...(forkInput.providerTurnId === undefined
            ? {}
            : { providerTurnId: forkInput.providerTurnId }),
        },
        createdAt,
        updatedAt: createdAt,
      };
      // Forks inherit source worktrees and skip initial resume; relocate to the destination now.
      const cwd = forkInput.runtimePolicy?.cwd;
      const state = register(providerThread, forked, cwd ?? forked.location.directory);
      yield* writeRules(state, forkInput.runtimePolicy ?? state.policy);
      if (cwd != null && forked.location.directory !== cwd) {
        yield* live.client.session.move({
          sessionID: Session.ID.make(forked.id),
          directory: AbsolutePath.make(cwd),
        });
      }
      return state.providerThread;
    },
    (effect, forkInput) =>
      effect.pipe(
        exclusive(forkInput.sourceProviderThread),
        Effect.mapError((cause) =>
          isProviderAdapterError(cause)
            ? cause
            : new ProviderAdapter.ProviderAdapterForkThreadError({
                driver,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
        ),
      ),
  );

  return {
    readThreadSnapshot,
    forkThread,
  };
};

export type ThreadHistory = ReturnType<typeof makeThreadHistory>;
