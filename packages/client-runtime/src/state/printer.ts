import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPrinterEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:printer:state",
      tag: WS_METHODS.subscribePrinterState,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:configure",
      tag: WS_METHODS.printerConfigure,
      scheduler,
      concurrency,
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:test-connection",
      tag: WS_METHODS.printerTestConnection,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:list",
      tag: WS_METHODS.printerList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:open",
      tag: WS_METHODS.printerOpen,
      scheduler,
      concurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:close",
      tag: WS_METHODS.printerClose,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:printer:action",
      tag: WS_METHODS.printerAction,
      scheduler,
      concurrency,
    }),
  };
}
