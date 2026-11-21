import { useClerk } from "@clerk/react";
import { type ConnectionCatalogEntry, hasRelayRoute } from "@t3tools/client-runtime/connection";

let mountedClerk: { readonly status: string } | null = null;

/** Lets code outside Clerk's React context see whether the mounted Clerk failed to load. */
export function trackMountedClerk(clerk: { readonly status: string }): () => void {
  mountedClerk = clerk;
  return () => {
    if (mountedClerk === clerk) mountedClerk = null;
  };
}

export function useClerkLoadFailed() {
  return useClerk().status === "error";
}

export function retryClerkLoad() {
  // Clerk caches its failed script load for the life of the page and never
  // retries, so a reload is the only recovery.
  window.location.reload();
}

/**
 * A T3 Connect route waits on the Clerk session, so after Clerk failed to load
 * retrying it only succeeds after a reload. Returns whether it reloaded.
 */
export function retryClerkLoadForEnvironment(entry: ConnectionCatalogEntry): boolean {
  if (mountedClerk?.status !== "error" || !hasRelayRoute(entry)) return false;
  retryClerkLoad();
  return true;
}
