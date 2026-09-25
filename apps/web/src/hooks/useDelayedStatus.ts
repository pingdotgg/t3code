import { createDelayedStatus, type ShownStatus } from "@t3tools/client-runtime/delayed-status";
import { useEffect, useState } from "react";

/**
 * Returns `value` only once it has lasted past the show delay, then holds it
 * for a minimum time, so a short status never flashes. `key` is what the
 * status belongs to (for example a thread). A new key drops it at once.
 * Mobile has the same hook.
 */
export function useDelayedStatus<A>(key: string, value: A | null): A | null {
  const [shown, setShown] = useState<ShownStatus<A> | null>(null);
  const [status] = useState(() => createDelayedStatus<A>(setShown));
  useEffect(() => () => status.dispose(), [status]);
  useEffect(() => {
    status.update(key, value);
  }, [status, key, value]);
  return shown?.key === key ? shown.value : null;
}
