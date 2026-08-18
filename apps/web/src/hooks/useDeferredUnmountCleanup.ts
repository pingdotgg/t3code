import { useEffect, useRef } from "react";

/**
 * Defers unmount cleanup until React has had a chance to replay the effect in
 * StrictMode. A replay cancels the pending work; a real unmount does not.
 */
export function useDeferredUnmountCleanup(cleanup: () => void): void {
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  const pendingCleanupRef = useRef<object | null>(null);

  useEffect(() => {
    pendingCleanupRef.current = null;

    return () => {
      const pendingCleanup = {};
      pendingCleanupRef.current = pendingCleanup;
      queueMicrotask(() => {
        if (pendingCleanupRef.current !== pendingCleanup) {
          return;
        }
        pendingCleanupRef.current = null;
        cleanupRef.current();
      });
    };
  }, []);
}
