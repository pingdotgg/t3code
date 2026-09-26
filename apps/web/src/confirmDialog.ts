import type {
  ConfirmDialogCheckboxOptions,
  ConfirmDialogOptions,
  ConfirmDialogVariant,
} from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly id: string;
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly checkbox?: ConfirmDialogCheckboxOptions | undefined;
    }
  | {
      readonly status: "closing";
      readonly id: string;
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly checkbox?: ConfirmDialogCheckboxOptions | undefined;
    };

type PendingConfirmation = {
  readonly id: string;
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly checkbox?: ConfirmDialogCheckboxOptions | undefined;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let confirmationSequence = 0;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

/** Returns the current confirmation dialog state. */
export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/** Subscribes a listener to confirmation dialog state changes. */
export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    confirmationSequence += 1;
    const id = `confirm-${confirmationSequence}`;
    const pending = {
      id,
      message,
      variant: options?.variant ?? "default",
      checkbox: options?.checkbox,
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      id,
      message,
      variant: pending.variant,
      checkbox: pending.checkbox,
    });
  });

  return confirmation;
}

/** Resolves the active confirmation and transitions the dialog to closing. */
export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    id: state.id,
    message: state.message,
    variant: state.variant,
    checkbox: state.checkbox,
  });
}

/** Completes the closing animation and activates any queued confirmation. */
export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    id: next.id,
    message: next.message,
    variant: next.variant,
    checkbox: next.checkbox,
  });
}

/** Resets confirmation dialog state for tests. */
export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  confirmationSequence = 0;
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
