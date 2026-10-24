import { useClerk } from "@clerk/react";

export function useClerkLoadFailed() {
  return useClerk().status === "error";
}

export function retryClerkLoad() {
  // Clerk caches its failed script load for the life of the page and never
  // retries, so a reload is the only recovery. It keeps stored sessions and the
  // local server, so the user comes back signed in.
  window.location.reload();
}
