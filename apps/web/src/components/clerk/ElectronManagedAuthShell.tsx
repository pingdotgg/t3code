import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";
import { definePluginComponent } from "~/plugins/features";

const ElectronManagedAuthShell = definePluginComponent(
  "component:components/clerk/ElectronManagedAuthShell/ElectronManagedAuthShell",
  PluginOriginalElectronManagedAuthShell,
);
export default ElectronManagedAuthShell;

/** Load only lazily inside desktop; clerk-js is statically bundled and would otherwise enter every
 * client's startup graph. */
function PluginOriginalElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey} passkeys={passkeys}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
