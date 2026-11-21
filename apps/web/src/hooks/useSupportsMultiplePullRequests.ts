import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentServerConfigFlags } from "~/state/presentation";

const NO_ENVIRONMENT_ATOM = Atom.make(false);

export function useSupportsMultiplePullRequests(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_ENVIRONMENT_ATOM
      : environmentServerConfigFlags.hasServerConfigAtom(environmentId),
  );
}
