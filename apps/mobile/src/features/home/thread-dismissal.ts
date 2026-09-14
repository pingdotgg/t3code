interface ThreadDismissal {
  readonly finished: Promise<void>;
  readonly restore: () => void;
}

const rows = new Map<string, Set<() => ThreadDismissal>>();

/** A thread can be visible in Home and the navigation sidebar at once. */
export function registerThreadDismissal(key: string, dismiss: () => ThreadDismissal) {
  const registrations = rows.get(key) ?? new Set();
  registrations.add(dismiss);
  rows.set(key, registrations);
  return () => {
    registrations.delete(dismiss);
    if (registrations.size === 0) rows.delete(key);
  };
}

/** Finish the exit before mutating the list; failed commands put the rows back. */
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
