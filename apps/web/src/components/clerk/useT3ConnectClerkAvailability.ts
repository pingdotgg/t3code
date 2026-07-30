import { useAuth } from "@clerk/react";
import { useEffect, useState } from "react";

import {
  resolveT3ConnectClerkAvailability,
  type T3ConnectClerkAvailability,
} from "./T3ConnectSidebarControl.logic";

/**
 * clerk-js never fires a load failure on origins the publishable key does not
 * cover (e.g. a domain-locked production key on localhost), so `isLoaded`
 * can stay false forever. After this window we treat Clerk as unavailable and
 * fall back to local link state instead of an indefinite "Connecting…".
 */
export const CLERK_LOAD_TIMEOUT_MS = 8_000;

export function useT3ConnectClerkAvailability(): T3ConnectClerkAvailability {
  const { isLoaded, isSignedIn } = useAuth();
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    if (isLoaded) {
      return undefined;
    }
    const timer = window.setTimeout(() => setLoadTimedOut(true), CLERK_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);

  return resolveT3ConnectClerkAvailability({ isLoaded, isSignedIn, loadTimedOut });
}
