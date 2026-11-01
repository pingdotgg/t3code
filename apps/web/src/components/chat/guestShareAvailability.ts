import { type EnvironmentId, managedCapabilityDenial } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Labs). The server refuses links while the beta is off.
 * Guests arrive through T3 Connect, so a policy that turns Connect off hides sharing too.
 */
export const canShareWithGuestAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const serverConfig = get(environmentPresentations.serverConfigsAtom).get(environmentId);
    return (
      get(serverEnvironment.createGuestShare.permissionAtom(environmentId)) &&
      serverConfig?.settings.guestSharingEnabled === true &&
      managedCapabilityDenial(serverConfig.managedPolicy, "connect") === undefined
    );
  }).pipe(Atom.withLabel(`guest-share:available:${environmentId}`)),
);
