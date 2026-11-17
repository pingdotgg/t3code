import {
  EnvironmentId,
  type GatewayScope,
  OrchestratorMcpThreadListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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

// A card's settle time is this machine's clock; a remote child's is its own machine's.
const CLOCK_SKEW_MS = 60_000;
const SWEEP_BACKOFF_CAP = Duration.minutes(15);

const settles = (scopes: ReadonlyArray<GatewayScope> | undefined) =>
  scopes?.includes("read") === true && scopes.includes("lifecycle");

const LINK_LIMITS: PeerMcpClient.PeerCallLimits = {
  runtimeMode: "full-access",
  interactionMode: "default",
};
const LINK_PAGE = 100;

interface RemoteThread {
  readonly id: ThreadId;
  readonly parentThreadId: string | null | undefined;
  readonly parentEnvironmentId: string | null | undefined;
  readonly settledAtMs: number | null;
}

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

  /** The children of the card's settled runs there, as `request` should change them. */
  const childrenOf = (request: RemoteSettlementRequest, threads: ReadonlyArray<RemoteThread>) => {
    const parents = new Set<string>(request.threadIds);
    return threads.filter(
      (thread) =>
        thread.parentEnvironmentId === local &&
        thread.parentThreadId != null &&
        parents.has(thread.parentThreadId) &&
        // Un-settle returns only children that settled with the chat, not ones settled before it.
        (request.action === "settle" ||
          (thread.settledAtMs !== null &&
            thread.settledAtMs >= DateTime.toEpochMillis(request.settledAt) - CLOCK_SKEW_MS)),
    );
  };

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

  /** Settles over this server's link; false when the peer is too old to list remote parents. */
  const overLink = Effect.fn("RemoteSettlementCascade.overLink")(function* (
    request: RemoteSettlementRequest,
    environmentId: EnvironmentId,
  ) {
    const threads: Array<RemoteThread> = [];
    for (let cursor: number | null = 0; cursor !== null;) {
      const page: OrchestratorMcpThreadListResult = yield* peers
        .call({
          environmentId,
          tool: "t3_thread_list",
          arguments: {
            allProjects: true,
            includeSubagents: false,
            ...(request.action === "unsettle" ? { settled: true } : {}),
            cursor,
            limit: LINK_PAGE,
          },
          limits: LINK_LIMITS,
          success: OrchestratorMcpThreadListResult,
        })
        .pipe(Effect.mapError(pending));
      for (const thread of page.threads) {
        // A version from before linked callers saw remote parents leaves this out.
        if (thread.parentEnvironmentId === undefined) return false;
        threads.push({
          id: thread.threadId,
          parentThreadId: thread.parentThreadId,
          parentEnvironmentId: thread.parentEnvironmentId,
          settledAtMs: thread.settledAt === null ? null : Date.parse(thread.settledAt),
        });
      }
      cursor = page.nextCursor;
    }
    let failure: string | undefined;
    for (const thread of childrenOf(request, threads)) {
      yield* peers
        .call({
          environmentId,
          tool: "t3_thread_organize",
          arguments: { threadId: thread.id, action: request.action },
          limits: LINK_LIMITS,
          success: Schema.Unknown,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failure = error.message;
            }),
          ),
        );
    }
    if (failure !== undefined) return yield* new RemoteSettlementPending({ message: failure });
    return true;
  });

  const throughApp = Effect.fn("RemoteSettlementCascade.throughApp")(function* (
    request: RemoteSettlementRequest,
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
    const listed = yield* broker
      .call("listThreads", [environmentId])
      .pipe(Effect.mapError(pending));
    const children = childrenOf(
      request,
      listed.items.map((thread) => ({
        id: thread.id,
        parentThreadId: thread.parentThreadId,
        parentEnvironmentId: thread.parentEnvironmentId,
        settledAtMs: thread.settledAt == null ? null : DateTime.toEpochMillis(thread.settledAt),
      })),
    );
    let failure: string | undefined;
    for (const thread of children) {
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

  const carry = Effect.fn("RemoteSettlementCascade.carry")(function* (
    input: RemoteSettlementInput,
    environmentId: EnvironmentId,
  ) {
    const { request } = input;
    if (!(yield* stillCurrent(input.threadId, request))) return;
    let linkFailure: string | undefined;
    if (yield* linkSettles(environmentId)) {
      const handled = yield* overLink(request, environmentId).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            linkFailure = error.message;
            return false;
          }),
        ),
      );
      if (handled) return;
      // An older peer cannot list its remote parents, so its children wait for an app.
      linkFailure ??= `${environmentId} runs an older ${APP_NAME}; a connected ${APP_NAME} app settles its chats.`;
    }
    yield* throughApp(request, environmentId, linkFailure);
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
