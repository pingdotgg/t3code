import {
  describeGatewayScopes,
  gatewayPortCallScopes,
  unmetGatewayScopes,
  type GatewayRuntimePort,
} from "@t3tools/client-runtime/gateway";
import type * as Cause from "effect/Cause";
import {
  type EnvironmentId,
  type GatewayScope,
  McpGatewayRelayCalls,
  McpGatewayUnavailableError,
  NETWORK_ACCESS_CEILING,
  NETWORK_APP_SUBJECT_PREFIX,
  toMcpGatewayRelayJson,
  type McpGatewayRelayArgs,
  type McpGatewayRelayEvent,
  type McpGatewayRelayGrants,
  type McpGatewayRelayMethod,
  type McpGatewayRelayResponse,
  type McpGatewayRelayResult,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Membership from "../peer/Membership.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { DESKTOP_APP_SUBJECT } from "../auth/PairingGrantStore.ts";

const unavailable = (message: string) => new McpGatewayUnavailableError({ message });
const linksOff = unavailable(
  "Linked environments is off on this machine, so its agents cannot act on another machine.",
);
/** The gateway scopes a roster entry allows; undefined when the roster does not list it. */
const gatewayCeiling = (
  access: Option.Option<TailnetDeviceAccess>,
): ReadonlyArray<GatewayScope> | undefined =>
  Option.isSome(access) ? NETWORK_ACCESS_CEILING[access.value].gateway : undefined;
const revoked = unavailable(
  "This machine's access to the network was revoked, so its agents cannot act on another machine.",
);

/** What this server's agents may reach through connected apps, and why the rest is refused. */
export interface McpGatewayAccess {
  readonly grants: Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
  readonly refusals: Readonly<Record<string, string>>;
  /** Why every relay is capped at reading, when this machine's network access is below full. */
  readonly limit?: string | undefined;
}

const SERVER_MODES = { runtimeMode: "full-access", interactionMode: "default" } as const;

type HostGrants = Record<string, ReadonlyArray<GatewayScope>>;
interface Evaluated {
  readonly blocked: McpGatewayUnavailableError | undefined;
  /** Per app: what it may run now, and what it would without this machine's own cap. */
  readonly hosts: ReadonlyMap<Host, { readonly grants: HostGrants; readonly uncapped: HostGrants }>;
  readonly refusals: Readonly<Record<string, string>>;
  readonly ceilingNote: string | undefined;
}

interface RelayCodec {
  readonly encodeArgs: (args: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decodeResult: (answer: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}
const relayCodec = (spec: {
  readonly args: Schema.Codec<unknown, unknown>;
  readonly result: Schema.Codec<unknown, unknown>;
}): RelayCodec => ({
  encodeArgs: Schema.encodeUnknownEffect(spec.args),
  decodeResult: Schema.decodeUnknownEffect(spec.result),
});
/** Each relay call's argument encoder and answer decoder, compiled once. */
const relayCodecs: { readonly [M in McpGatewayRelayMethod]: RelayCodec } = {
  getThread: relayCodec(McpGatewayRelayCalls.getThread),
  listThreads: relayCodec(McpGatewayRelayCalls.listThreads),
  settleThread: relayCodec(McpGatewayRelayCalls.settleThread),
  unsettleThread: relayCodec(McpGatewayRelayCalls.unsettleThread),
  threadTask: relayCodec(McpGatewayRelayCalls.threadTask),
};

interface Host {
  readonly owner: string;
  /**
   * Who registered it: this machine's own desktop app, an app of the network, or a session
   * paired by code, which is only itself.
   */
  readonly relayer: "desktop" | "app" | "paired";
  readonly identity: string;
  readonly appId: string | undefined;
  readonly connectionId: string;
  readonly grants: McpGatewayRelayGrants;
  readonly requests: Queue.Queue<McpGatewayRelayEvent, Cause.Done>;
  /** Timed out since it last answered; other apps that reach the environment go first. */
  stalled: boolean;
}
interface Pending {
  readonly host: Host;
  readonly deferred: Deferred.Deferred<unknown, McpGatewayUnavailableError>;
}

/**
 * Connected apps that run T3 Agents runtime port calls for this server's agents on the other
 * environments they reach. Each app advertises the grants its user set.
 */
export const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const membership = yield* Membership.Membership;
  const settings = yield* ServerSettingsService;
  const identity = yield* ServerEnvironmentIdentity;
  const hosts = new Map<string, Host>();
  const pending = new Map<string, Pending>();
  /** Fires when an app connects, so queued cross-environment work can retry at once. */
  const connected = yield* PubSub.unbounded<void>();
  /** `subject` is the registering session's: an app of the network relays as that app. */
  const connect = (owner: string, grants: McpGatewayRelayGrants, subject: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connectionId = yield* random.uuidV4();
        const requests = yield* Queue.unbounded<McpGatewayRelayEvent, Cause.Done>();
        const appId = subject.startsWith(NETWORK_APP_SUBJECT_PREFIX)
          ? subject.slice(NETWORK_APP_SUBJECT_PREFIX.length)
          : undefined;
        const relayer =
          subject === DESKTOP_APP_SUBJECT ? "desktop" : appId === undefined ? "paired" : "app";
        const host: Host = {
          owner,
          relayer,
          identity: relayer === "paired" ? `session:${owner}` : subject,
          appId,
          connectionId,
          grants,
          requests,
          stalled: false,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => hosts.set(connectionId, host)).pipe(
            Effect.andThen(refresh),
            Effect.andThen(PubSub.publish(connected, undefined)),
          ),
          () =>
            Effect.gen(function* () {
              hosts.delete(connectionId);
              for (const [id, call] of pending) {
                if (call.host !== host) continue;
                pending.delete(id);
                yield* Deferred.fail(
                  call.deferred,
                  unavailable("The T3 app relaying this call disconnected."),
                );
              }
              yield* Queue.end(requests);
              yield* refresh;
            }),
        );
        return Stream.fromQueue(requests);
      }),
    );
  /**
   * What each app may run now, read live so a revoke or the switch applies at once. This
   * machine's own roster access caps every app. A network member is relayed by this machine's
   * own desktop app or by an app of the network, within that app's roster access; an app of the
   * network relays only members, and a session paired by code only environments outside it.
   */
  const evaluate = Effect.fn("McpGatewayBroker.evaluate")(function* (
    /** Only these environments, so a call reads the roster for what it touches. */
    only?: ReadonlySet<string>,
  ) {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.linkedEnvironmentsEnabled),
      Effect.orElseSucceed(() => false),
    );
    const own = enabled
      ? yield* membership.accessOf(yield* identity.getEnvironmentId)
      : Option.none<TailnetDeviceAccess>();
    const ceiling = gatewayCeiling(own);
    const blocked = !enabled ? linksOff : ceiling?.length === 0 ? revoked : undefined;
    const ceilingNote =
      Option.isSome(own) && own.value !== "full-access"
        ? `This machine's access in the network is ${own.value}, so its agents may only read on other machines.`
        : undefined;
    const refusals: Record<string, string> = {};
    const bound = new Map<Host, { grants: HostGrants; uncapped: HostGrants }>();
    if (blocked !== undefined) {
      for (const host of hosts.values()) {
        for (const environmentId of Object.keys(host.grants)) {
          refusals[environmentId] = blocked.message;
        }
      }
      return { blocked, hosts: bound, refusals, ceilingNote } satisfies Evaluated;
    }
    const targets = new Map<string, Option.Option<TailnetDeviceAccess>>();
    for (const host of hosts.values()) {
      // An app the roster no longer lists relays nothing.
      const appScopes =
        host.appId === undefined
          ? undefined
          : (gatewayCeiling(yield* membership.appAccessOf(host.appId)) ?? []);
      const grants: HostGrants = {};
      const uncapped: HostGrants = {};
      for (const [environmentId, scopes] of Object.entries(host.grants)) {
        if (only !== undefined && !only.has(environmentId)) continue;
        let target = targets.get(environmentId);
        if (target === undefined) {
          target = yield* membership.accessOf(environmentId as EnvironmentId);
          targets.set(environmentId, target);
        }
        const member = Option.isSome(target);
        const refusal =
          Option.isSome(target) && target.value === "revoked"
            ? `${environmentId} was revoked from the network.`
            : member && host.relayer === "paired"
              ? `${environmentId} is a member of the network; only this machine's own T3 app or an app of the network relays to it.`
              : !member && host.relayer === "app"
                ? `${environmentId} is not in the network, so an app of the network does not relay to it.`
                : undefined;
        if (refusal !== undefined) {
          refusals[environmentId] = refusal;
          continue;
        }
        const allowed = scopes.filter(
          (scope) => appScopes === undefined || appScopes.includes(scope),
        );
        const capped = allowed.filter((scope) => ceiling === undefined || ceiling.includes(scope));
        if (allowed.length > 0) uncapped[environmentId] = allowed;
        if (capped.length > 0) grants[environmentId] = capped;
        else
          refusals[environmentId] =
            allowed.length > 0 && ceilingNote !== undefined
              ? ceilingNote
              : `The app relaying ${environmentId} is no longer in the network.`;
      }
      bound.set(host, { grants, uncapped });
    }
    // A session paired by code vouches only for itself: it never takes an environment from
    // this machine's desktop app or an app of the network, nor from the earliest connected
    // session paired by code that still answers. Leaving frees it.
    const holder = new Map<string, Host>();
    for (const [host, { uncapped }] of bound) {
      for (const environmentId of Object.keys(uncapped)) {
        const held = holder.get(environmentId);
        if (
          held === undefined ||
          (held.relayer === "paired" &&
            (host.relayer !== "paired" || (held.stalled && !host.stalled)))
        ) {
          holder.set(environmentId, host);
        }
      }
    }
    for (const [host, { grants, uncapped }] of bound) {
      if (host.relayer !== "paired") continue;
      for (const environmentId of Object.keys(uncapped)) {
        if (holder.get(environmentId)?.identity === host.identity) continue;
        delete grants[environmentId];
        delete uncapped[environmentId];
      }
    }
    for (const { grants } of bound.values()) {
      for (const environmentId of Object.keys(grants)) delete refusals[environmentId];
    }
    return { blocked, hosts: bound, refusals, ceilingNote } satisfies Evaluated;
  });
  let snapshot: McpGatewayAccess = { grants: {}, refusals: {} };
  /** Every scope some app may run now, per environment, merged: what agents may try. */
  const access = evaluate().pipe(
    Effect.map(({ hosts: bound, refusals, ceilingNote }): McpGatewayAccess => {
      const merged: Record<string, Set<GatewayScope>> = {};
      for (const { grants } of bound.values()) {
        for (const [environmentId, scopes] of Object.entries(grants)) {
          const into = (merged[environmentId] ??= new Set());
          for (const scope of scopes) into.add(scope);
        }
      }
      return {
        grants: Object.fromEntries(Object.entries(merged).map(([id, scopes]) => [id, [...scopes]])),
        refusals,
        limit: ceilingNote,
      };
    }),
    Effect.tap((current) =>
      Effect.sync(() => {
        snapshot = current;
      }),
    ),
  );
  const refresh = Effect.asVoid(access);
  /** Sends one call to one app and waits for its answer. */
  const ask = Effect.fn("McpGatewayBroker.ask")(function* (
    host: Host,
    method: keyof GatewayRuntimePort,
    relayedArgs: ReadonlyArray<unknown>,
    timeout: Duration.Input,
    modeCeiling?: McpGatewayRelayEvent["modeCeiling"],
  ) {
    const invocationId = yield* random.uuidV4();
    const deferred = yield* Deferred.make<unknown, McpGatewayUnavailableError>();
    pending.set(invocationId, { host, deferred });
    return yield* Effect.gen(function* () {
      yield* Queue.offer(host.requests, {
        type: "invoke",
        connectionId: host.connectionId,
        invocationId,
        method,
        args: relayedArgs,
        ...(modeCeiling === undefined ? {} : { modeCeiling }),
      });
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.sync(() => {
            host.stalled = true;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                unavailable("The T3 app relaying this call timed out; it was not retried."),
              ),
            ),
          ),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(invocationId))),
    );
  });
  /**
   * Each app sees the environments its own device reaches, so the listing merges every app's
   * answer; following one app would swap the agent's world whenever another app connects.
   */
  const listEnvironments = Effect.fn("McpGatewayBroker.listEnvironments")(function* (
    bound: Evaluated["hosts"],
  ) {
    const answers = yield* Effect.forEach(
      [...bound.keys()].toReversed(),
      (host) =>
        ask(host, "listEnvironments", [], "10 seconds").pipe(
          Effect.option,
          Effect.map((answer) => ({ host, answer })),
        ),
      { concurrency: "unbounded" },
    );
    const merged = new Map<string, Record<string, unknown>>();
    for (const { host, answer } of answers) {
      if (Option.isNone(answer) || !Array.isArray(answer.value)) continue;
      for (const candidate of answer.value as ReadonlyArray<unknown>) {
        if (typeof candidate !== "object" || candidate === null) continue;
        const environment = candidate as Record<string, unknown>;
        if (typeof environment.environmentId !== "string") continue;
        if (bound.get(host)?.grants[environment.environmentId] === undefined) continue;
        const known = merged.get(environment.environmentId);
        // The newest app's view wins unless only an older app is connected to the environment.
        if (
          known === undefined ||
          (known.connectionState !== "connected" && environment.connectionState === "connected")
        ) {
          merged.set(environment.environmentId, environment);
        }
      }
    }
    return [...merged.values()];
  });
  const invoke = Effect.fn("McpGatewayBroker.invoke")(function* (
    method: keyof GatewayRuntimePort,
    args: ReadonlyArray<unknown>,
    environmentIds: ReadonlyArray<string>,
    /** The calling chat's modes, applied again by the app where the call runs. */
    modeCeiling?: McpGatewayRelayEvent["modeCeiling"],
  ): Effect.fn.Return<unknown, McpGatewayUnavailableError> {
    if (method === "listEnvironments") {
      const evaluated = yield* evaluate();
      if (evaluated.blocked !== undefined) return yield* evaluated.blocked;
      return yield* listEnvironments(evaluated.hosts);
    }
    const requirements = gatewayPortCallScopes(method, args);
    if (requirements === undefined) {
      return yield* unavailable(
        `${method} names no environment whose T3 Agents access could be checked, so it is not relayed.`,
      );
    }
    const evaluated = yield* evaluate(new Set(requirements.map((need) => need.environmentId)));
    if (evaluated.blocked !== undefined) return yield* evaluated.blocked;
    const bound = evaluated.hosts;
    // The newest app whose own grant covers the call runs it, preferring one that answers; a
    // grant another app holds never widens it.
    const holding = [...bound]
      .toReversed()
      .filter(([, { grants }]) => unmetGatewayScopes(grants, requirements) === undefined)
      .map(([candidate]) => candidate);
    const host = holding.find((candidate) => !candidate.stalled) ?? holding[0];
    if (!host) {
      const unmet = requirements.find(({ environmentId }) =>
        [...bound.values()].every(({ grants }) => grants[environmentId] === undefined),
      );
      const refusal = unmet === undefined ? undefined : evaluated.refusals[unmet.environmentId];
      const capped =
        evaluated.ceilingNote !== undefined &&
        [...bound.values()].some(
          ({ uncapped }) => unmetGatewayScopes(uncapped, requirements) === undefined,
        );
      return yield* unavailable(
        hosts.size === 0
          ? "No T3 app with T3 Agents enabled is connected to this environment."
          : refusal !== undefined
            ? refusal
            : capped
              ? evaluated.ceilingNote!
              : unmet !== undefined
                ? `No connected T3 app grants T3 Agents access to ${environmentIds.join(", ")}.`
                : `No single connected T3 app grants the ${requirements.map(describeGatewayScopes).join("; ")} access ${method} needs on ${environmentIds.join(", ")}.`,
      );
    }
    // Omitted trailing arguments stay omitted rather than arriving as null.
    const sent = args.slice(0, args.findLastIndex((arg) => arg !== undefined) + 1);
    const relayedArgs = yield* Effect.try({
      try: () => toMcpGatewayRelayJson(sent) as ReadonlyArray<unknown>,
      catch: () => unavailable(`The arguments of ${method} cannot be relayed to a T3 app.`),
    });
    return yield* ask(host, method, relayedArgs, "60 seconds", modeCeiling);
  });
  /**
   * One of this server's own calls on another environment, with its arguments and answer checked
   * against the contract, so an app that answers in another shape fails here, not in the caller.
   */
  const call = <M extends McpGatewayRelayMethod>(
    method: M,
    args: McpGatewayRelayArgs<M>,
  ): Effect.Effect<McpGatewayRelayResult<M>, McpGatewayUnavailableError> => {
    const codec = relayCodecs[method];
    const environmentId = args[0];
    return codec.encodeArgs(args).pipe(
      Effect.mapError(() => unavailable(`The arguments of ${method} do not match its contract.`)),
      Effect.flatMap((encoded) =>
        // No chat makes these calls; the app answering runs a call without modes at the narrowest.
        invoke(method, encoded as ReadonlyArray<unknown>, [environmentId], SERVER_MODES),
      ),
      Effect.flatMap((answer) =>
        codec
          .decodeResult(answer)
          .pipe(
            Effect.mapError(() =>
              unavailable(
                `Environment ${environmentId} answered ${method} in a shape this server cannot read.`,
              ),
            ),
          ),
      ),
      Effect.map((result) => result as McpGatewayRelayResult<M>),
      Effect.withSpan("McpGatewayBroker.call", { attributes: { method } }),
    );
  };
  const respond = Effect.fn("McpGatewayBroker.respond")(function* (
    owner: string,
    input: McpGatewayRelayResponse,
  ) {
    const call = pending.get(input.invocationId);
    if (!call || call.host.owner !== owner || call.host.connectionId !== input.connectionId) {
      return yield* unavailable("Relay response does not belong to this connection.");
    }
    pending.delete(input.invocationId);
    call.host.stalled = false;
    if (input.error !== undefined) {
      yield* Deferred.fail(call.deferred, unavailable(input.error));
      return;
    }
    yield* Deferred.succeed(call.deferred, input.result);
  });
  // Roster and switch changes refresh what agents are shown; calls are checked live regardless.
  const rosterChanges = yield* membership.subscribeChanges;
  yield* Stream.merge(rosterChanges, settings.streamChanges).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  return {
    connect,
    /** Roster-bounded, read now. */
    access,
    /** Roster-bounded, as last read: on `access`, an app connecting, or a roster or settings change. */
    view: (): McpGatewayAccess => snapshot,
    call,
    /**
     * Runs a gateway tool's runtime port call on another environment as it is. Only the tool
     * catalog uses this: its calls are the port's own surface, typed by the port.
     */
    forward: invoke,
    respond,
    available: () => hosts.size > 0,
    hostConnected: Stream.fromPubSub(connected),
  };
});

export class McpGatewayBroker extends Context.Service<
  McpGatewayBroker,
  Effect.Success<typeof make>
>()("t3/mcp/McpGatewayBroker") {}

export const layer = Layer.effect(McpGatewayBroker, make);
