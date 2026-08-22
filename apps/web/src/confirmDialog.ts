import type {
  ConfirmDialogOptions,
  ConfirmDialogResult,
  ConfirmDialogSecondaryAction,
  ConfirmDialogVariant,
} from "@t3tools/contracts";

type ConfirmDialogPayload = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly secondary?: ConfirmDialogSecondaryAction | undefined;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmDialogPayload)
  | ({ readonly status: "closing" } & ConfirmDialogPayload);

type PendingConfirmation = ConfirmDialogPayload & {
  readonly resolve: (result: ConfirmDialogResult) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function payloadFromOptions(message: string, options?: ConfirmDialogOptions): ConfirmDialogPayload {
  return {
    message,
    variant: options?.variant ?? "default",
    confirmLabel: options?.confirmLabel,
    cancelLabel: options?.cancelLabel,
    secondary: options?.secondary,
  };
}

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  const result: ConfirmDialogResult = { confirmed, secondary: false };
  activeConfirmation?.resolve(result);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(result);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

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
): Promise<ConfirmDialogResult> | undefined {
  if (registeredHostCount === 0) return undefined;

  return new Promise<ConfirmDialogResult>((resolve) => {
    const payload = payloadFromOptions(message, options);
    const pending: PendingConfirmation = { ...payload, resolve };
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", ...payload });
  });
}

/**
 * Resolves the active confirmation with the given result. The host calls this
 * from each action button: cancel/close -> `confirmed: false`, the primary
 * button -> `{ confirmed: true, secondary: false }`, the secondary button ->
 * `{ confirmed: true, secondary: true }`.
 */
export function respondToConfirmDialog(result: ConfirmDialogResult): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  const { status: _status, ...payload } = state;
  activeConfirmation = null;
  confirmation.resolve(result);
  publish({ status: "closing", ...payload });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  const { resolve: _resolve, ...payload } = next;
  publish({ status: "confirming", ...payload });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
