import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createThreadFamilyAtoms } from "@t3tools/client-runtime/state/threads";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useContext, useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import type { FamilyRow } from "./boardModel";
import { environmentShell } from "./projects";
import { engineProvidersAtom } from "./server";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);

const NO_FAMILY: ReadonlyArray<FamilyRow> = [];

/**
 * Every thread under an orchestrator. The shell stream leaves out idle children, so the family
 * is read from the engine and merged behind the shell's rows, which stay current as runs change.
 */
export function useThreadFamily(
  environmentId: EnvironmentId,
  orchestratorThreadId: string | null,
): ReadonlyArray<FamilyRow> {
  const registry = useContext(RegistryContext);
  useEffect(
    () =>
      orchestratorThreadId === null
        ? undefined
        : threadFamilies.mount(registry, environmentId, ThreadId.make(orchestratorThreadId)),
    [registry, environmentId, orchestratorThreadId],
  );
  const threads = useAtomValue(threadFamilies.snapshotAtom(environmentId))?.threads;
  return useMemo(
    () =>
      orchestratorThreadId === null || threads === undefined
        ? NO_FAMILY
        : threads.filter(
            (thread) =>
              thread.lineage.rootThreadId === orchestratorThreadId &&
              thread.archivedAt === null &&
              thread.deletedAt === null,
          ),
    [threads, orchestratorThreadId],
  );
}

/** The driver behind a provider instance, which picks an agent's glyph. */
export function useDriverOf(): (instanceId: string) => string | null {
  const providers = useAtomValue(engineProvidersAtom);
  return useMemo(() => {
    const drivers = new Map<string, string>(
      providers.map((provider) => [provider.instanceId, provider.driver]),
    );
    return (instanceId) => drivers.get(instanceId) ?? null;
  }, [providers]);
}
