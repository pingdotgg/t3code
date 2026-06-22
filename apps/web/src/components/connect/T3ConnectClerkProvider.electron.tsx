import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ClerkElectronProvider } from "@clerk/electron/react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";

export default function ClerkProvider({
  children,
  publishableKey,
}: {
  readonly children: React.ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <ClerkElectronProvider publishableKey={publishableKey} passkeys={passkeys}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkElectronProvider>
  );
}
