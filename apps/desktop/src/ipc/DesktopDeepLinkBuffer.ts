import type { DesktopDeepLinkTarget } from "@t3tools/contracts";

export function decodeDesktopDeepLinkTarget(value: unknown): DesktopDeepLinkTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "thread" ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.length === 0 ||
    candidate.environmentId.trim() !== candidate.environmentId ||
    typeof candidate.threadId !== "string" ||
    candidate.threadId.length === 0 ||
    candidate.threadId.trim() !== candidate.threadId
  ) {
    return null;
  }
  return candidate as unknown as DesktopDeepLinkTarget;
}

export function createDesktopDeepLinkBuffer() {
  const listeners = new Set<(target: DesktopDeepLinkTarget) => void>();
  let pending: DesktopDeepLinkTarget | null = null;

  return {
    publish(target: DesktopDeepLinkTarget) {
      if (listeners.size === 0) {
        pending = target;
        return;
      }
      for (const listener of listeners) listener(target);
    },
    subscribe(listener: (target: DesktopDeepLinkTarget) => void) {
      listeners.add(listener);
      if (pending !== null) {
        const target = pending;
        pending = null;
        listener(target);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
