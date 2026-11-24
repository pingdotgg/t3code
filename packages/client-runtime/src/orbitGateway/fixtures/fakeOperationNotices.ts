import type { OrbitOperationNotices } from "../operationNotices.ts";

/** Operation notices a test sends by hand, as Reverb would; always live. */
export function fakeOperationNotices() {
  const followed: number[] = [];
  const stopped: number[] = [];
  const waiting = new Map<number, () => void>();
  const pending = new Set<number>();
  /** The sequence each wait was told the reader has read, per Operation. */
  const readSequences = new Map<number, Array<number | null>>();
  return {
    followed,
    stopped,
    readSequences: (operationId: number) => readSequences.get(operationId) ?? [],
    /** Whether a reader of the Operation waits on its next notice now. */
    waiting: (operationId: number) => waiting.has(operationId),
    notify(operationId: number) {
      const wake = waiting.get(operationId);
      waiting.delete(operationId);
      if (wake) wake();
      else pending.add(operationId);
    },
    operationNotices: (operationId: number): OrbitOperationNotices => {
      followed.push(operationId);
      return {
        next: (afterSequence) => {
          readSequences.set(operationId, [
            ...(readSequences.get(operationId) ?? []),
            afterSequence,
          ]);
          if (pending.delete(operationId)) return Promise.resolve();
          return new Promise<void>((resolve) => waiting.set(operationId, resolve));
        },
        abandonWait: () => waiting.delete(operationId),
        live: () => true,
        reconnect: () => {},
        stop: () => {
          stopped.push(operationId);
          const wake = waiting.get(operationId);
          waiting.delete(operationId);
          wake?.();
        },
      };
    },
  };
}
