import {
  EnvironmentId,
  type GatewayScope,
  type OrchestrationV2ParentSettlement,
  OrchestrationV2ParentSettlementResult,
  PARENT_SETTLEMENT_PARENTS_MAX,
  PEER_FOLLOW_PARENT_SETTLEMENT_TOOL,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import * as Membership from "../peer/Membership.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as TailnetDevices from "../peer/TailnetDevices.ts";
import { EffectOutboxV2, SETTLED_EFFECT_RETENTION } from "./EffectOutbox.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  type RemoteSettlementInput,
  RemoteSettlementPending,
  RemoteSettlementRelay,
  type RemoteSettlementRequest,
} from "./SettlementCascade.ts";
import { APP_NAME } from "@t3tools/shared/branding";

/**
 * A child on another environment settles with its card over this server's own full-access link
 * there, else through a connected T3 app. Each environment gets its own outbox effect; one not
 * reachable yet fails, and is queued again by a backing-off minute sweep or at once on a change.
 */

const SWEEP_BACKOFF_CAP = Duration.minutes(15);

const settles = (scopes: ReadonlyArray<GatewayScope> | undefined) =>
  scopes?.includes("read") === true && scopes.includes("lifecycle");

const LINK_LIMITS: PeerMcpClient.PeerCallLimits = {
  runtimeMode: "full-access",
  interactionMode: "default",
};

export const make = Effect.gen(function* () {
  const broker = yield* McpGatewayBroker;
  const membership = yield* Membership.Membership;
  const outbox = yield* EffectOutboxV2;
  const projections = yield* ProjectionStoreV2;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const tailnetDevices = yield* Effect.serviceOption(TailnetDevices.TailnetDevices);
  const local = (yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor).environmentId;
  // Failed rows may wait from before a restart, so the first sweep looks.
  let waiting = true;

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
    const members = yield* membership.members.pipe(
      Effect.map((network) => network.map((member) => member.environmentId)),
      Effect.orElseSucceed(() => []),
    );
    // With full access itself, this machine renews a member session with any member.
    const trusted = yield* fullAccess(local);
    for (const environmentId of members) {
      if (environmentId !== local && (trusted || (yield* fullAccess(environmentId)))) {
        targets.add(environmentId);
      }
    }
    if (yield* links.enabled) {
      for (const link of yield* links.stored.pipe(Effect.orElseSucceed(() => []))) {
        if (link.environmentId !== local && link.access === "full-access") {
          targets.add(link.environmentId);
        }
      }
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

  const pending = (error: { readonly message: string }) =>
    new RemoteSettlementPending({ message: error.message });

  /**
   * Whether this server's own link may settle chats there: only one with full access. A member's
   * link is minted at the access the roster gave this machine then, so a wider grant since takes
   * a new handshake; a link paired by code is the user's choice and stays as it is.
   */
  const linkSettles = Effect.fn("RemoteSettlementCascade.linkSettles")(function* (
    environmentId: EnvironmentId,
  ) {
    if (!(yield* links.enabled)) return false;
    const stored = links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
    const link = yield* stored;
    if (Option.isSome(link) && link.value.access === "full-access") return true;
    if (Option.isNone(tailnetDevices)) return false;
    if (Option.isSome(link) && link.value.origin !== "tailnet") return false;
    const access = yield* membership.accessOf(environmentId);
    if (Option.isNone(access) || access.value === "revoked" || !(yield* fullAccess(local))) {
      return false;
    }
    yield* tailnetDevices.value.refresh(environmentId);
    const renewed = yield* stored;
    return Option.isSome(renewed) && renewed.value.access === "full-access";
  });

  /** The settlement the children follow, in parent batches the receiver accepts. */
  const settlements = (input: RemoteSettlementInput) => {
    const { request } = input;
    const batches: Array<OrchestrationV2ParentSettlement> = [];
    for (let start = 0; start < request.threadIds.length; start += PARENT_SETTLEMENT_PARENTS_MAX) {
      batches.push({
        parentEnvironmentId: local,
        parentThreadIds: request.threadIds.slice(start, start + PARENT_SETTLEMENT_PARENTS_MAX),
        action: request.action,
        // Rows queued before the settlement was named follow the card's own.
        settledBy: request.settledBy ?? input.threadId,
        settledAt: DateTime.formatIso(request.settledAt),
      });
    }
    return batches;
  };

  /** Children still working refuse the settle; the effect stays pending until they finish. */
  const settleWaiting = (environmentId: EnvironmentId, waiting: ReadonlyArray<string>) =>
    waiting.length === 0
      ? Effect.void
      : Effect.fail(
          new RemoteSettlementPending({
            message: `${waiting.length} child chat(s) on ${environmentId} are still working; they settle once they finish.`,
          }),
        );

  /** A machine on a version that cannot follow a settlement is left as it is, never guessed at. */
  const unsupported = (environmentId: EnvironmentId) =>
    new RemoteSettlementPending({
      message: `${environmentId} runs an older ${APP_NAME} that cannot follow a parent's settlement; its chats settle once it is updated.`,
    });

  /** Over this server's own link: "unsupported" from a peer without the settlement call. */
  const overLink = Effect.fn("RemoteSettlementCascade.overLink")(function* (
    input: RemoteSettlementInput,
    environmentId: EnvironmentId,
  ) {
    const waiting: Array<string> = [];
    for (const { parentEnvironmentId: _local, ...settlement } of settlements(input)) {
      const result = yield* peers
        .call({
          environmentId,
          tool: PEER_FOLLOW_PARENT_SETTLEMENT_TOOL,
          arguments: settlement,
          limits: LINK_LIMITS,
          success: OrchestrationV2ParentSettlementResult,
        })
        .pipe(
          Effect.map((answer) => answer.waiting),
          Effect.catchIf(
            (error) =>
              error.message.includes(`Tool '${PEER_FOLLOW_PARENT_SETTLEMENT_TOOL}' not found`),
            () => Effect.succeed("unsupported" as const),
          ),
        );
      if (result === "unsupported") return result;
      waiting.push(...result);
    }
    return waiting;
  });

  const throughApp = Effect.fn("RemoteSettlementCascade.throughApp")(function* (
    input: RemoteSettlementInput,
    environmentId: EnvironmentId,
    waitingOn: string | undefined,
  ) {
    const access = yield* broker.access;
    if (!settles(access.grants[environmentId])) {
      // Nothing here may ever settle there: connected apps do not relay it, and neither the
      // network nor a link grants this machine full access to it.
      const mayLater =
        waitingOn !== undefined ||
        !broker.available() ||
        access.refusals[environmentId] !== undefined ||
        (yield* fullAccess(environmentId));
      if (!mayLater) return;
      return yield* new RemoteSettlementPending({
        message:
          waitingOn ??
          access.refusals[environmentId] ??
          `No connected ${APP_NAME} app or link lets this machine settle chats on ${environmentId} yet.`,
      });
    }
    const waiting: Array<string> = [];
    for (const settlement of settlements(input)) {
      // An app or a server without the call refuses it; the effect waits for both to update.
      const result = yield* broker
        .call("followParentSettlement", [environmentId, settlement])
        .pipe(Effect.mapError(pending));
      waiting.push(...result.waiting);
    }
    yield* settleWaiting(environmentId, waiting);
  });

  const carry = Effect.fn("RemoteSettlementCascade.carry")(function* (
    input: RemoteSettlementInput,
    environmentId: EnvironmentId,
  ) {
    if (!(yield* stillCurrent(input.threadId, input.request))) return;
    let linkFailure: string | undefined;
    if (yield* linkSettles(environmentId)) {
      const waiting = yield* overLink(input, environmentId).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            linkFailure = error.message;
            return undefined;
          }),
        ),
      );
      if (waiting === "unsupported") return yield* unsupported(environmentId);
      // The peer answered: its busy children wait for a retry here, never a plain app settle.
      if (waiting !== undefined) return yield* settleWaiting(environmentId, waiting);
    }
    yield* throughApp(input, environmentId, linkFailure);
  });

  const run = (input: RemoteSettlementInput) =>
    input.request.environmentId === undefined
      ? plan(input)
      : carry(input, EnvironmentId.make(input.request.environmentId)).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              waiting = true;
            }),
          ),
        );

  const requeue = Effect.fn("RemoteSettlementCascade.requeue")(
    function* (backoffCap: Duration.Duration | undefined) {
      const createdAfter = DateTime.subtractDuration(yield* DateTime.now, SETTLED_EFFECT_RETENTION);
      const requeued = yield* outbox.requeueFailed({
        effectType: "thread-settlement.remote",
        createdAfter,
        ...(backoffCap === undefined ? {} : { backoffCap }),
      });
      // Until one fails again, nothing waits: no row is younger than the age-out and failed.
      if (requeued === 0 && backoffCap === undefined) waiting = false;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not retry settlement on other environments", { cause }),
    ),
  );

  /** Queues every remote settlement that could not reach its environment again. */
  const retryWaiting = requeue(undefined).pipe(
    Effect.withSpan("RemoteSettlementCascade.retryWaiting"),
  );

  /**
   * The minute sweep, which writes nothing while no settlement waits. A machine that stays away
   * is asked less often, so waiting settlements do not rewrite the outbox every minute for days.
   */
  const sweep = Effect.suspend(() => (waiting ? requeue(SWEEP_BACKOFF_CAP) : Effect.void));

  return { run, retryWaiting, sweep };
});

export const layer = Layer.effect(
  RemoteSettlementRelay,
  Effect.gen(function* () {
    const cascade = yield* make;
    const broker = yield* McpGatewayBroker;
    const rosterChanges = yield* (yield* Membership.Membership).subscribeChanges;
    const linkChanges = yield* (yield* PeerLinks.PeerLinks).subscribeChanges;
    // An app connecting, a link or the roster changing may open a path that was closed.
    yield* Stream.merge(Stream.merge(broker.hostConnected, rosterChanges), linkChanges).pipe(
      Stream.runForEach(() => cascade.retryWaiting),
      Effect.forkScoped,
    );
    // A machine that comes back on its own, with nothing here changing.
    yield* cascade.sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
    return { run: cascade.run };
  }),
);
