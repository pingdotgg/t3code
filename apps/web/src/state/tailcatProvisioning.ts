import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type TailcatProvisioningPhase = "starting-tunnel" | "pairing";

export interface TailcatProvisioningProgress {
  /** The forwarder connection id being provisioned (`tailcat:<environment id or address>`). */
  readonly connectionId: string;
  readonly phase: TailcatProvisioningPhase;
}

/**
 * Progress of the one Tailcat pairing in flight. The gateway publishes the
 * step it is on so the connect form can narrate it without polling; null when
 * nothing is being provisioned.
 */
export const tailcatProvisioningProgressAtom = Atom.make<TailcatProvisioningProgress | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("web:tailcat-provisioning-progress"));

export function reportTailcatProvisioningProgress(
  progress: TailcatProvisioningProgress | null,
): void {
  appAtomRegistry.set(tailcatProvisioningProgressAtom, progress);
}
