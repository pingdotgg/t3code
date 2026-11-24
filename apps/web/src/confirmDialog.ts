import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

/** Labels for a dialog that offers a second way to proceed besides Confirm. */
export interface ConfirmChoiceLabels {
  readonly confirm: string;
  readonly alternate: string;
}

export type ConfirmDialogChoice = "confirm" | "alternate" | "cancel";

type ConfirmDialogContent = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly initialFocus: ConfirmDialogOptions["initialFocus"];
  readonly labels: ConfirmChoiceLabels | undefined;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" | "closing" } & ConfirmDialogContent);

type PendingConfirmation = ConfirmDialogContent & {
  readonly resolve: (choice: ConfirmDialogChoice) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function cancelPendingConfirmations(): void {
  activeConfirmation?.resolve("cancel");
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve("cancel");
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    cancelPendingConfirmations();
    publish(idleState);
  };
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  return requestConfirmChoice(message, options)?.then((choice) => choice === "confirm");
}

/** Like `requestConfirmDialog`, with an extra action when `labels` is given. */
export function requestConfirmChoice(
  message: string,
  options?: ConfirmDialogOptions & { readonly labels?: ConfirmChoiceLabels },
): Promise<ConfirmDialogChoice> | undefined {
  if (listeners.size === 0) return undefined;

  const confirmation = new Promise<ConfirmDialogChoice>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      initialFocus: options?.initialFocus,
      labels: options?.labels,
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ ...contentOf(pending), status: "confirming" });
  });

  return confirmation;
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

function contentOf(pending: PendingConfirmation): ConfirmDialogContent {
  const { resolve: _resolve, ...content } = pending;
  return content;
}

export function respondToConfirmDialog(response: boolean | "alternate"): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(response === true ? "confirm" : response === false ? "cancel" : response);
  publish({ ...state, status: "closing" });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({ ...contentOf(next), status: "confirming" });
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  cancelPendingConfirmations();
  publish(idleState);
}
