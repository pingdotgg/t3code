import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { readShellThreadInventory } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** Conn: the untrimmed inventory a Tasks peek marks; it never reaches the sidebar's shell. */
const inventoryRead = createRuntimeCommand(connectionAtomRuntime, {
  label: "conn:sidebar-hidden-threads:inventory",
  execute: Effect.fn("SidebarHiddenThreads.readInventory")(function* (
    environmentId: EnvironmentId,
  ) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(environmentId, readShellThreadInventory());
  }),
});

/** Every active thread of the environment, or null when the read failed (retry later). */
export async function readSidebarThreadInventory(
  environmentId: string,
): Promise<ReadonlyArray<OrchestrationV2ThreadShell> | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    inventoryRead,
    environmentId as EnvironmentId,
    { reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
}
