import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ClerkConnectAuthProvider } from "./ClerkConnectAuthProvider";
import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

/** Lazy-load Clerk so cloudless local mode never downloads it. */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <AppAtomRegistryProvider>
      <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
        <ClerkConnectAuthProvider>
          <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
        </ClerkConnectAuthProvider>
      </ClerkProvider>
    </AppAtomRegistryProvider>
  );
}
