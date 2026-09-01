export interface SnoozeForDialogRequest {
  readonly threadCount?: number;
  readonly onSnooze: (snoozedUntil: string) => void;
}

export type SnoozeForDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "open";
      readonly id: number;
      readonly threadCount: number;
      readonly onSnooze: (snoozedUntil: string) => void;
    };

const idleState: SnoozeForDialogState = { status: "idle" };
let state: SnoozeForDialogState = idleState;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: SnoozeForDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function readSnoozeForDialogState(): SnoozeForDialogState {
  return state;
}

export function subscribeSnoozeForDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSnoozeForDialog(request: SnoozeForDialogRequest): void {
  publish({
    status: "open",
    id: nextId++,
    threadCount: request.threadCount ?? 1,
    onSnooze: request.onSnooze,
  });
}

export function closeSnoozeForDialog(): void {
  publish(idleState);
}
