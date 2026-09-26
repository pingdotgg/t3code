import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type TailcatProvisioningPhase = "starting-tunnel" | "pairing";

/**
 * The step of the one Tailcat pairing in flight. The gateway publishes it so
 * the connect form can narrate progress without polling; null when nothing is
 * being provisioned.
 */
export const tailcatProvisioningPhaseAtom = Atom.make<TailcatProvisioningPhase | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:tailcat-provisioning-phase"),
);

export function reportTailcatProvisioningPhase(phase: TailcatProvisioningPhase | null): void {
  appAtomRegistry.set(tailcatProvisioningPhaseAtom, phase);
}
