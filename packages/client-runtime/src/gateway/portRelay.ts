import {
  EnvironmentId,
  type GatewayScope,
  MCP_GATEWAY_RELAY_GRANTS_MAX,
  NETWORK_ACCESS_CEILING,
  type TailnetDevicesSnapshot,
  toMcpGatewayRelayJson,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { request, subscribe, subscribeDynamicWithSession } from "../rpc/client.ts";
import { GATEWAY_PORT_METHODS, type GatewayGrants, wireTaskError } from "./bridgeClient.ts";
import type { GatewayEnvironmentSummary, GatewayRuntimePort } from "./port.ts";
import { type ModeLimit, withinModes } from "./portModes.ts";
import { describeGatewayScopes, gatewayPortCallScopes, unmetGatewayScopes } from "./portScopes.ts";

/** How a target's roster push is followed again after it fails; tests step it by hand. */
export const RosterRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/gateway/portRelay/RosterRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
      ),
  },
);

/** What a target's roster lets the calling machine do there, and why. */
export interface RosterCap {
  readonly scopes: ReadonlyArray<GatewayScope>;
  readonly why: string;
}

/** This app did not run the call: it cannot reach the environment or was not granted it there. */
class GatewayRelayUnreachable extends Schema.TaggedError<GatewayRelayUnreachable>()(
  "GatewayRelayUnreachable",
  { message: Schema.String },
) {}
export const isGatewayRelayUnreachable = Schema.is(GatewayRelayUnreachable);

/** A call that names no modes, as from an older server, runs as the narrowest chat would. */
const NARROWEST: ModeLimit = { runtimeMode: "approval-required", interactionMode: "plan" };

/**
 * Runs one relayed runtime port call if this app grants every scope it needs on each environment,
 * and within the calling chat's modes as this app reads the target, not as the relaying server did.
 * `rosterCap` gives what an environment's own roster lets the calling machine do, if it caps it.
 */
export async function answerGatewayPortCall(
  port: GatewayRuntimePort,
  grants: GatewayGrants,
  method: string,
  args: ReadonlyArray<unknown>,
  modeCeiling: ModeLimit = NARROWEST,
  rosterCap?: (environmentId: string) => Promise<RosterCap | undefined>,
): Promise<unknown> {
  if (!GATEWAY_PORT_METHODS.has(method as keyof GatewayRuntimePort)) {
    throw new Error(`Unknown T3 Agents call ${method}.`);
  }
  if (method === "listEnvironments") {
    const environments = await port.listEnvironments();
    return environments.filter(
      (environment: GatewayEnvironmentSummary) => grants[environment.environmentId] !== undefined,
    );
  }
  const requirements = gatewayPortCallScopes(method as keyof GatewayRuntimePort, args);
  if (requirements === undefined) {
    throw new Error("T3 Agents access is not granted for this call on this device.");
  }
  const ownUnmet = unmetGatewayScopes(grants, requirements);
  if (ownUnmet !== undefined) {
    throw new GatewayRelayUnreachable({
      message:
        grants[ownUnmet.environmentId] === undefined
          ? `T3 Agents access is not granted for ${ownUnmet.environmentId} on this device.`
          : `T3 Agents access to ${ownUnmet.environmentId} on this device does not include ${describeGatewayScopes(ownUnmet)}.`,
    });
  }
  for (const requirement of rosterCap === undefined ? [] : requirements) {
    const cap = await rosterCap!(requirement.environmentId);
    if (cap === undefined) continue;
    const held = grants[requirement.environmentId]!.filter((scope) => cap.scopes.includes(scope));
    if (unmetGatewayScopes({ [requirement.environmentId]: held }, [requirement]) !== undefined) {
      throw new GatewayRelayUnreachable({
        message: `${requirement.environmentId}'s device network ${cap.why}, so the calling machine may not ${describeGatewayScopes(requirement)} there.`,
      });
    }
  }
  const connected = new Set(
    (await port.listEnvironments())
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const offline = requirements.find(({ environmentId }) => !connected.has(environmentId));
  if (offline !== undefined) {
    throw new GatewayRelayUnreachable({
      message: `This T3 app is not connected to ${offline.environmentId} right now.`,
    });
  }
  const guarded = withinModes(port, modeCeiling);
  const run = guarded[method as keyof GatewayRuntimePort] as
    | ((...input: ReadonlyArray<unknown>) => Promise<unknown>)
    | undefined;
  if (run === undefined) throw new Error(`${method} is not available on this device.`);
  // A relayed call never carries a calling chat: this app acts as its user.
  return run.call(guarded, ...(method === "threadTask" ? args.slice(0, 2) : args));
}

/** Why a server would refuse to register these grants, if it would. */
export function relayGrantsProblem(grants: GatewayGrants): string | undefined {
  const count = Object.keys(grants).length;
  return count > MCP_GATEWAY_RELAY_GRANTS_MAX
    ? `T3 Agents relays at most ${MCP_GATEWAY_RELAY_GRANTS_MAX} environments, and ${count} are granted, so this app relays none. Turn some off in Settings > MCP Gateway.`
    : undefined;
}

/**
 * Lets agents on each granted environment act on the other granted environments through this
 * app's connections. Each server runs the tools; this app only answers runtime port calls for
 * environments and scopes the user granted, and advertises those grants so the server routes each
 * call only to an app that grants what it needs.
 */
export function serveGatewayPortRelays<R>(
  context: Context.Context<EnvironmentRegistry | R>,
  port: GatewayRuntimePort,
  grants: GatewayGrants,
  onFailure: (error: unknown) => void,
) {
  // Every server would refuse the registration, so retrying it would only repeat the refusal.
  const problem = relayGrantsProblem(grants);
  if (problem !== undefined) {
    onFailure(new Error(problem));
    return () => undefined;
  }
  const abort = new AbortController();
  const rosters = new Map<string, TailnetDevicesSnapshot>();
  for (const id of Object.keys(grants)) {
    const serve = Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      const runResponse = Effect.runPromiseWith(yield* Effect.context<never>());
      // The target's own roster, pushed by it, caps each call, so a narrowing or revoke there
      // applies even while the calling machine's copy is stale. A caller it does not list keeps
      // the grant; a roster that cannot be read lets it do nothing.
      const rosterCap = (target: string) => {
        if (target === id) return Promise.resolve(undefined);
        const held = rosters.get(target);
        return runResponse(
          (held === undefined
            ? registry.run(EnvironmentId.make(target), request(WS_METHODS.tailnetDevicesList, {}))
            : Effect.succeed(held)
          ).pipe(
            Effect.map((snapshot): RosterCap | undefined => {
              const access = snapshot.devices.find((device) => device.environmentId === id)?.access;
              return access
                ? {
                    scopes: NETWORK_ACCESS_CEILING[access].gateway,
                    why:
                      access === "revoked"
                        ? "revoked the calling machine"
                        : `gives the calling machine ${access} access`,
                  }
                : undefined;
            }),
            Effect.orElseSucceed(() => ({ scopes: [], why: "could not be read" })),
          ),
        );
      };
      const relays = registry.followStream(
        EnvironmentId.make(id),
        subscribeDynamicWithSession(WS_METHODS.mcpGatewayConnect, () => Effect.succeed({ grants })),
      );
      // A target that cannot push its roster is read on each call until the push is back.
      const retry = yield* RosterRetrySchedule;
      yield* registry
        .followStream(EnvironmentId.make(id), subscribe(WS_METHODS.subscribeTailnetDevices, {}))
        .pipe(
          Stream.tapError(() => Effect.sync(() => rosters.delete(id))),
          Stream.retry(retry),
          Stream.runForEach((snapshot) => Effect.sync(() => rosters.set(id, snapshot))),
          Effect.ensuring(Effect.sync(() => rosters.delete(id))),
          Effect.ignore,
          Effect.forkScoped,
        );
      yield* relays.pipe(
        Stream.runForEach(([session, event]) =>
          Effect.sync(() => {
            // Calls run concurrently; a slow handoff must not hold up a listing.
            void answerGatewayPortCall(
              port,
              grants,
              event.method,
              event.args,
              event.modeCeiling,
              rosterCap,
            )
              .then((result) => {
                const json = toMcpGatewayRelayJson(result);
                return json === undefined ? {} : { result: json };
              })
              .catch((error: unknown) => {
                const taskError = wireTaskError(error);
                return {
                  error: error instanceof Error ? error.message : String(error),
                  ...(isGatewayRelayUnreachable(error) ? { unreachable: true as const } : {}),
                  ...(taskError === undefined ? {} : { taskError }),
                };
              })
              .then((outcome) =>
                runResponse(
                  session.client[WS_METHODS.mcpGatewayRespond]({
                    connectionId: event.connectionId,
                    invocationId: event.invocationId,
                    ...outcome,
                  }),
                ),
              )
              .catch((error) => {
                if (!abort.signal.aborted) onFailure(error);
              });
          }),
        ),
      );
    }).pipe(Effect.scoped);
    // A failed subscription is reported and replaced; otherwise this environment's agents lose
    // every other granted environment until the gateway is restarted.
    const supervised = Effect.sandbox(serve).pipe(
      Effect.tapError((cause) => Effect.sync(() => onFailure(Cause.squash(cause)))),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        while: (cause) => !Cause.hasInterruptsOnly(cause),
      }),
    );
    void Effect.runPromiseWith(context)(supervised, { signal: abort.signal }).catch(
      () => undefined,
    );
  }
  return () => abort.abort();
}
