import { WS_METHODS, type SessionTransferImportResult } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createSessionTransferAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    export: createEnvironmentRpcCommand(runtime, {
      label: "session-transfer:export",
      tag: WS_METHODS.sessionTransferExport,
    }),
    import: createEnvironmentRpcCommand(runtime, {
      label: "session-transfer:import",
      tag: WS_METHODS.sessionTransferImport,
    }),
    finish: createEnvironmentRpcCommand(runtime, {
      label: "session-transfer:finish",
      tag: WS_METHODS.sessionTransferFinish,
    }),
  };
}

/** The source cannot be stopped before the destination acknowledges both its files and thread. */
export async function runSessionTransfer<Archive>(steps: {
  capture: () => Promise<Archive>;
  prepareLocal: (archive: Archive) => Promise<SessionTransferImportResult>;
  stopRemote: (archive: Archive) => Promise<void>;
  startLocal: (local: SessionTransferImportResult) => Promise<void>;
}) {
  const archive = await steps.capture();
  const local = await steps.prepareLocal(archive);
  try {
    await steps.stopRemote(archive);
  } catch (error) {
    return { status: "remote-stop-failed" as const, local, error };
  }
  try {
    await steps.startLocal(local);
  } catch (error) {
    return { status: "local-start-failed" as const, local, error };
  }
  return { status: "complete" as const, local };
}
