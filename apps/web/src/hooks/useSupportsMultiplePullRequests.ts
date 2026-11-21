import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { environmentPresentations } from "~/state/presentation";

export function useSupportsMultiplePullRequests(environmentId: EnvironmentId | null): boolean {
  // Select the boolean: every server-config push replaces the map, and most callers are list rows.
  return useAtomValue(
    environmentPresentations.serverConfigsAtom,
    (configs) => environmentId !== null && configs.has(environmentId),
  );
}
