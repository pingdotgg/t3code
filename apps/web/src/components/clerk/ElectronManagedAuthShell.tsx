import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ClerkConnectAuthProvider } from "./ClerkConnectAuthProvider";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

/** Load only lazily inside desktop; clerk-js is statically bundled and would otherwise enter every
 * client's startup graph. */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <AppAtomRegistryProvider>
      <ClerkProvider
        appearance={clerkAppearance}
        publishableKey={publishableKey}
        passkeys={passkeys}
      >
        <ClerkConnectAuthProvider>
          <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
        </ClerkConnectAuthProvider>
      </ClerkProvider>
    </AppAtomRegistryProvider>
  );
}
