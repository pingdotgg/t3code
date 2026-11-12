import { EnvironmentId, type GatewayScope, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import * as Membership from "../peer/Membership.ts";
import { EffectOutboxV2, SETTLED_EFFECT_RETENTION } from "./EffectOutbox.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  type RemoteSettlementInput,
  RemoteSettlementPending,
  RemoteSettlementRelay,
  type RemoteSettlementRequest,
} from "./SettlementCascade.ts";

/**
 * A child on another environment settles with its card through a connected T3 app, the path
 * t3_settle_thread takes there, and its own environment cascades to what is under it. Each
 * environment gets its own outbox effect; one that cannot be reached yet fails and is queued
 * again when an app connects or the roster changes.
 */

// A card's settle time is this machine's clock; a remote child's is its own machine's.
const CLOCK_SKEW_MS = 60_000;

const settles = (scopes: ReadonlyArray<GatewayScope> | undefined) =>
  scopes?.includes("read") === true && scopes.includes("lifecycle");

export const make = Effect.gen(function* () {
  const broker = yield* McpGatewayBroker;
  const membership = yield* Membership.Membership;
  const outbox = yield* EffectOutboxV2;
  const projections = yield* ProjectionStoreV2;
  const local = (yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor).environmentId;

  const fullAccess = (environmentId: EnvironmentId) =>
    membership
      .accessOf(environmentId)
      .pipe(Effect.map((access) => Option.getOrUndefined(access) === "full-access"));

  /** Where children may be: environments an app settles on now, and full-access members. */
  const plan = Effect.fn("RemoteSettlementCascade.plan")(function* (input: RemoteSettlementInput) {
    const targets = new Set(
      Object.entries((yield* broker.access).grants)
        .filter(([id, scopes]) => id !== local && settles(scopes))
        .map(([id]) => id),
    );
    const members = yield* Effect.all([membership.members, membership.local]).pipe(
      Effect.map(([network, linked]) => [...network, ...linked].map((m) => m.environmentId)),
      Effect.orElseSucceed(() => []),
    );
    for (const environmentId of members) {
      if (environmentId !== local && (yield* fullAccess(environmentId))) targets.add(environmentId);
    }
    if (targets.size === 0) return;
    yield* outbox
      .enqueue(
        [...targets].map((environmentId) => ({
          id: `${input.effectId}:${environmentId}`,
          commandId: input.commandId,
          threadId: input.threadId,
          request: { ...input.request, environmentId },
        })),
      )
      .pipe(
        Effect.andThen(outbox.notifyAvailable(targets.size)),
        Effect.mapError((error) => new RemoteSettlementPending({ message: error.message })),
      );
  });

  /** A later settle or un-settle of the card replaces this one, so a late retry never undoes it. */
  const stillCurrent = Effect.fn("RemoteSettlementCascade.stillCurrent")(function* (
    threadId: ThreadId,
    request: RemoteSettlementRequest,
  ) {
    const card = yield* projections.getThread(threadId).pipe(Effect.orElseSucceed(() => null));
    if (card === null || card.deletedAt != null) return false;
    return request.action === "settle"
      ? card.settledOverride === "settled" &&
          card.settledAt != null &&
          DateTime.toEpochMillis(card.settledAt) === DateTime.toEpochMillis(request.settledAt)
      : card.settledOverride !== "settled";
  });

  const carry = Effect.fn("RemoteSettlementCascade.carry")(function* (
    input: RemoteSettlementInput,
    environmentId: EnvironmentId,
  ) {
    const { request } = input;
    if (!(yield* stillCurrent(input.threadId, request))) return;
    const access = yield* broker.access;
    if (!settles(access.grants[environmentId])) {
      // Connected apps that do not relay it at all, or a member below full access, never will.
      const relayed =
        access.grants[environmentId] !== undefined || access.refusals[environmentId] !== undefined;
      if (broker.available() && !(relayed && (yield* fullAccess(environmentId)))) return;
      return yield* new RemoteSettlementPending({
        message:
          access.refusals[environmentId] ??
          `No connected T3 app lets this machine settle chats on ${environmentId} yet.`,
      });
    }
    const listed = yield* broker
      .call("listThreads", [environmentId])
      .pipe(Effect.mapError((error) => new RemoteSettlementPending({ message: error.message })));
    const parents = new Set<string>(request.threadIds);
    let failure: string | undefined;
    for (const thread of listed.items) {
      if (thread.parentEnvironmentId !== local || thread.parentThreadId == null) continue;
      if (!parents.has(thread.parentThreadId)) continue;
      // Un-settle returns only children that settled with the chat, not ones settled before it.
      if (
        request.action === "unsettle" &&
        (thread.settledAt == null ||
          DateTime.toEpochMillis(thread.settledAt) <
            DateTime.toEpochMillis(request.settledAt) - CLOCK_SKEW_MS)
      ) {
        continue;
      }
      // Settling a settled child again still cascades on its environment to what is under it.
      yield* broker
        .call(request.action === "settle" ? "settleThread" : "unsettleThread", [
          environmentId,
          thread.id,
        ])
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failure = error.message;
            }),
          ),
        );
    }
    if (failure !== undefined) return yield* new RemoteSettlementPending({ message: failure });
  });

  const run = (input: RemoteSettlementInput) =>
    input.request.environmentId === undefined
      ? plan(input)
      : carry(input, EnvironmentId.make(input.request.environmentId));

  /** Queues every remote settlement that could not reach its environment again. */
  const retryWaiting = Effect.gen(function* () {
    const createdAfter = DateTime.subtractDuration(yield* DateTime.now, SETTLED_EFFECT_RETENTION);
    yield* outbox.requeueFailed({ effectType: "thread-settlement.remote", createdAfter });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not retry settlement on other environments", { cause }),
    ),
    Effect.withSpan("RemoteSettlementCascade.retryWaiting"),
  );

  return { run, retryWaiting };
});

export const layer = Layer.effect(
  RemoteSettlementRelay,
  Effect.gen(function* () {
    const cascade = yield* make;
    const broker = yield* McpGatewayBroker;
    const rosterChanges = yield* (yield* Membership.Membership).subscribeChanges;
    // An app connecting or the roster changing may open a path that was closed.
    yield* Stream.merge(broker.hostConnected, rosterChanges).pipe(
      Stream.runForEach(() => cascade.retryWaiting),
      Effect.forkScoped,
    );
    return { run: cascade.run };
  }),
);
