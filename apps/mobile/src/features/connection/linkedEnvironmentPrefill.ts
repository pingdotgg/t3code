import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/**
 * A linked machine the add-environment screen opens for, with what the environment that links to
 * it said about it. Set only by this app; a route names the machine and never supplies an address.
 */
export const linkedEnvironmentPrefillAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly host: string | null;
} | null>(null).pipe(Atom.withLabel("linked-environment-prefill"));
