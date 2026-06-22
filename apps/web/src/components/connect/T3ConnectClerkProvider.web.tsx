import { ClerkProvider as ClerkReactProvider } from "@clerk/react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";

export default function ClerkProvider({
  children,
  publishableKey,
}: {
  readonly children: React.ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <ClerkReactProvider publishableKey={publishableKey}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkReactProvider>
  );
}
