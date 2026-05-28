import { useAuth } from "@clerk/react";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import { useEffect, type ReactNode } from "react";

let relayTokenProvider: (() => Promise<string | null>) | null = null;

export async function readManagedRelayClerkToken(): Promise<string | null> {
  return relayTokenProvider?.() ?? null;
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    relayTokenProvider = isSignedIn ? () => getToken(RELAY_CLERK_TOKEN_OPTIONS) : null;
    return () => {
      relayTokenProvider = null;
    };
  }, [getToken, isSignedIn]);

  return children;
}
