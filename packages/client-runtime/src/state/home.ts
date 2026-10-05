import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Home, the fleet-wide agent thread a desktop hub runs, and the relay the
 * desktop renderer provides for its calls to other environments.
 */
export function createHomeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const relayScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    enable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:enable",
      tag: WS_METHODS.homeEnable,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    disable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:disable",
      tag: WS_METHODS.homeDisable,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    startFresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:start-fresh",
      tag: WS_METHODS.homeStartFresh,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    /** Requests the hub sends this renderer to run elsewhere. Disposed with its owner. */
    relayRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:home:relay-requests",
      tag: WS_METHODS.fleetConnect,
      idleTtlMs: 0,
    }),
    relayRespond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:relay-respond",
      tag: WS_METHODS.fleetRespond,
      scheduler: relayScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.requestId]),
      },
    }),
    /** Runs one Home operation on the environment it names. */
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:invoke",
      tag: WS_METHODS.fleetInvoke,
      scheduler: relayScheduler,
    }),
    reportWatchEvents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:report-watch-events",
      tag: WS_METHODS.fleetReportWatchEvents,
      scheduler: relayScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
