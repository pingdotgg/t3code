interface ThreadDismissal {
  readonly finished: Promise<void>;
  readonly restore: () => void;
}

const rows = new Map<string, Set<() => ThreadDismissal>>();

export function registerThreadDismissal(key: string, dismiss: () => ThreadDismissal) {
  const registrations = rows.get(key) ?? new Set();
  registrations.add(dismiss);
  rows.set(key, registrations);
  return () => {
    registrations.delete(dismiss);
    if (registrations.size === 0) rows.delete(key);
  };
}

export async function withThreadDismissal<T>(
  key: string,
  action: () => Promise<T>,
  succeeded: (result: T) => boolean,
): Promise<T> {
  const dismissals = Array.from(rows.get(key) ?? [], (dismiss) => dismiss());
  let committed = false;
  try {
    await Promise.all(dismissals.map(({ finished }) => finished));
    const result = await action();
    committed = succeeded(result);
    return result;
  } finally {
    if (!committed) dismissals.forEach(({ restore }) => restore());
  }
}

/**
 * Collapse the row only when it is leaving the list. Search keeps settle/snooze/pin
 * rows in place, so dismissing them leaves a blank slot until the query clears.
 */
export async function withThreadListChange<T>(
  key: string,
  action: () => Promise<T>,
  succeeded: (result: T) => boolean,
  options?: { readonly dismiss?: boolean },
): Promise<T> {
  if (options?.dismiss === false) return action();
  return withThreadDismissal(key, action, succeeded);
}
