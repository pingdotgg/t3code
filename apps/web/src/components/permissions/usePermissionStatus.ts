import { useEffect, useEffectEvent, useState } from "react";

export function usePermissionStatus<Id extends string>(
  check: () => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let checking = false;
    const refresh = async () => {
      if (disposed || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const next = await checkLatest();
        if (!disposed) {
          setStatus(next);
          setError(null);
        }
      } catch {
        if (!disposed) setError("Could not check permissions. We'll try again automatically.");
      }
      checking = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);
  return {
    status,
    error,
    isReady: (required: readonly Id[]) => error === null && required.every((id) => status[id]),
  };
}
