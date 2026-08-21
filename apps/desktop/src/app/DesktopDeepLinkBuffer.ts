import type { DesktopDeepLinkTarget } from "@t3tools/contracts";

export function decodeDesktopDeepLinkTarget(value: unknown): DesktopDeepLinkTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "thread" ||
    typeof candidate.environmentId !== "string" ||
    typeof candidate.threadId !== "string"
  ) {
    return null;
  }
  return {
    kind: "thread",
    environmentId: candidate.environmentId,
    threadId: candidate.threadId,
  };
}

export function makeDesktopDeepLinkBuffer() {
  const listeners = new Set<(target: DesktopDeepLinkTarget) => void>();
  let pending: DesktopDeepLinkTarget | null = null;

  const push = (target: DesktopDeepLinkTarget) => {
    if (listeners.size === 0) {
      pending = target;
      return;
    }
    for (const listener of listeners) listener(target);
  };

  const subscribe = (listener: (target: DesktopDeepLinkTarget) => void) => {
    listeners.add(listener);
    if (pending !== null) {
      const target = pending;
      pending = null;
      listener(target);
    }
    return () => listeners.delete(listener);
  };

  return { push, subscribe };
}
