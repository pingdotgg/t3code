import type { ScopedThreadRef } from "@t3tools/contracts";

/** Keep one archive/delete in flight, including its confirmation and navigation. */
export async function runThreadActionShortcut<T>(
  event: Pick<KeyboardEvent, "repeat" | "preventDefault" | "stopPropagation">,
  target: ScopedThreadRef | null,
  pending: { current: boolean },
  action: (target: ScopedThreadRef) => Promise<T>,
): Promise<T | undefined> {
  if (target === null) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || pending.current) return;
  pending.current = true;
  try {
    return await action(target);
  } finally {
    pending.current = false;
  }
}
