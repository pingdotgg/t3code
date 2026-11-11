import {
  EnvironmentId,
  type GatewayScope,
  NETWORK_ACCESS_CEILING,
  type TailnetDevicesSnapshot,
  toMcpGatewayRelayJson,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { request, subscribe, subscribeDynamicWithSession } from "../rpc/client.ts";
import { GATEWAY_PORT_METHODS, type GatewayGrants } from "./bridgeClient.ts";
import type { GatewayEnvironmentSummary, GatewayRuntimePort } from "./port.ts";
import { type ModeLimit, withinModes } from "./portModes.ts";
import { describeGatewayScopes, gatewayPortCallScopes, unmetGatewayScopes } from "./portScopes.ts";

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
  rosterCap?: (environmentId: string) => Promise<ReadonlyArray<GatewayScope> | undefined>,
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
  const capped: Record<string, ReadonlyArray<GatewayScope>> = { ...grants };
  for (const { environmentId } of rosterCap === undefined ? [] : requirements) {
    const cap = await rosterCap!(environmentId);
    const held = capped[environmentId];
    if (cap !== undefined && held !== undefined) {
      capped[environmentId] = held.filter((scope) => cap.includes(scope));
    }
  }
  const unmet = unmetGatewayScopes(capped, requirements);
  if (unmet !== undefined) {
    throw new Error(
      grants[unmet.environmentId] === undefined
        ? `T3 Agents access is not granted for ${unmet.environmentId} on this device.`
        : capped[unmet.environmentId] !== grants[unmet.environmentId]
          ? `${unmet.environmentId}'s device network does not let the calling machine ${describeGatewayScopes(unmet)} there.`
          : `T3 Agents access to ${unmet.environmentId} on this device does not include ${describeGatewayScopes(unmet)}.`,
    );
  }
  const guarded = withinModes(port, modeCeiling);
  const run = guarded[method as keyof GatewayRuntimePort] as
    | ((...input: ReadonlyArray<unknown>) => Promise<unknown>)
    | undefined;
  if (run === undefined) throw new Error(`${method} is not available on this device.`);
  // A relayed call never carries a calling chat: this app acts as its user.
  return run.call(guarded, ...(method === "threadTask" ? args.slice(0, 2) : args));
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
            Effect.map((snapshot): ReadonlyArray<GatewayScope> | undefined => {
              const access = snapshot.devices.find((device) => device.environmentId === id)?.access;
              return access ? NETWORK_ACCESS_CEILING[access].gateway : undefined;
            }),
            Effect.orElseSucceed(() => []),
          ),
        );
      };
      const relays = registry.followStream(
        EnvironmentId.make(id),
        subscribeDynamicWithSession(WS_METHODS.mcpGatewayConnect, () => Effect.succeed({ grants })),
      );
      // A target that cannot push its roster is read on each call instead.
      yield* registry
        .followStream(EnvironmentId.make(id), subscribe(WS_METHODS.subscribeTailnetDevices, {}))
        .pipe(
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
              .catch((error: unknown) => ({
                error: error instanceof Error ? error.message : String(error),
              }))
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
