import { GATEWAY_PORT_METHODS } from "./bridgeClient.ts";
import type { GatewayEnvironmentSummary, GatewayRuntimePort } from "./port.ts";
import type { ModeLimit } from "./portModes.ts";

/**
 * Every environment a runtime port call acts on: the first argument when it is an ID, or the
 * environment fields of an input object. Empty for calls that are not about one environment.
 */
export function gatewayPortEnvironmentIds(args: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const [first] = args;
  if (typeof first === "string") return [first];
  if (typeof first !== "object" || first === null) return [];
  const input = first as Record<string, unknown>;
  return [input.environmentId, input.sourceEnvironmentId].filter(
    (id): id is string => typeof id === "string",
  );
}

/** Runs runtime port calls on environments this process cannot reach itself. */
export interface GatewayPortRelay {
  readonly invoke: (
    method: keyof GatewayRuntimePort,
    args: ReadonlyArray<unknown>,
    environmentIds: ReadonlyArray<string>,
    /** The calling chat's modes, for the app answering the call to apply where it runs. */
    modeCeiling?: ModeLimit,
  ) => Promise<unknown>;
}

/**
 * A port that runs calls for `localEnvironmentId` on `local` and every other environment's
 * calls through `relay`. Environment listing merges both, local first.
 */
export function createRoutedGatewayPort(
  localEnvironmentId: string,
  local: GatewayRuntimePort,
  relay: () => GatewayPortRelay | undefined,
): GatewayRuntimePort {
  const routed: Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>> = {};
  for (const method of GATEWAY_PORT_METHODS) {
    routed[method] = async (...args) => {
      const remote = relay();
      if (method === "listEnvironments") {
        const own = await local.listEnvironments();
        if (remote === undefined) return own;
        const others = (await remote
          .invoke(method, [], [])
          .catch(() => [])) as ReadonlyArray<GatewayEnvironmentSummary>;
        return [
          ...own,
          ...others.filter((environment) => environment.environmentId !== localEnvironmentId),
        ];
      }
      const environmentIds = gatewayPortEnvironmentIds(args);
      const elsewhere = environmentIds.find((id) => id !== localEnvironmentId);
      // An authenticated chat's task call stays with the server that knows the
      // chat; that server reaches other environments as the task's peer, so the
      // agent is never relayed as the user.
      const agentTaskCall = method === "threadTask" && args[2] !== undefined;
      if (elsewhere === undefined || agentTaskCall) {
        const run = local[method] as
          | ((...input: ReadonlyArray<unknown>) => Promise<unknown>)
          | undefined;
        if (run === undefined) throw new Error(`${method} is not available on this environment.`);
        return run.call(local, ...args);
      }
      if (remote === undefined) {
        throw new Error(
          `Environment ${elsewhere} is not reachable from this chat. Open T3 Code on a device connected to it and grant it T3 Agents access.`,
        );
      }
      // The calling chat is only meaningful to the local server that authenticated it.
      return remote.invoke(
        method,
        method === "threadTask" ? args.slice(0, 2) : args,
        environmentIds,
      );
    };
  }
  return routed as unknown as GatewayRuntimePort;
}
