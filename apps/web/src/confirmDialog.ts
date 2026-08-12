import type {
  AlertDialogOptions,
  ConfirmDialogOptions,
  ConfirmDialogVariant,
} from "@t3tools/contracts";

type ActiveDialogState =
  | {
      readonly mode: "alert";
      readonly title: string;
      readonly description?: string;
    }
  | {
      readonly mode: "confirm";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
    };

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ActiveDialogState)
  | ({ readonly status: "closing" } & ActiveDialogState);

type PendingDialog =
  | {
      readonly mode: "alert";
      readonly title: string;
      readonly description?: string;
      readonly resolve: () => void;
    }
  | {
      readonly mode: "confirm";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly resolve: (confirmed: boolean) => void;
    };

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeDialog: PendingDialog | null = null;
let queuedDialogs: PendingDialog[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolveDialog(dialog: PendingDialog, confirmed: boolean): void {
  if (dialog.mode === "alert") {
    dialog.resolve();
    return;
  }
  dialog.resolve(confirmed);
}

function resolvePendingDialogs(confirmed: boolean): void {
  if (activeDialog) {
    resolveDialog(activeDialog, confirmed);
  }
  for (const dialog of queuedDialogs) {
    resolveDialog(dialog, confirmed);
  }
  activeDialog = null;
  queuedDialogs = [];
}

function enqueueDialog(dialog: PendingDialog): void {
  if (activeDialog || state.status === "closing") {
    queuedDialogs.push(dialog);
    return;
  }

  activeDialog = dialog;
  publish(
    dialog.mode === "alert"
      ? {
          status: "confirming",
          mode: "alert",
          title: dialog.title,
          ...(dialog.description === undefined ? {} : { description: dialog.description }),
        }
      : {
          status: "confirming",
          mode: "confirm",
          message: dialog.message,
          variant: dialog.variant,
        },
  );
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
      resolvePendingDialogs(false);
      publish(idleState);
    }
  };
}

/** Requests a themed one-button alert when a host is mounted. */
export function requestAlertDialog(options: AlertDialogOptions): Promise<void> | undefined {
  if (registeredHostCount === 0) return undefined;

  return new Promise<void>((resolve) => {
    enqueueDialog({
      mode: "alert",
      title: options.title,
      ...(options.description === undefined ? {} : { description: options.description }),
      resolve,
    });
  });
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
    const pending = {
      mode: "confirm",
      message,
      variant: options?.variant ?? "default",
      resolve,
    } satisfies PendingDialog;
    enqueueDialog(pending);
  });

  return confirmation;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeDialog) return;

  const dialog = activeDialog;
  activeDialog = null;
  resolveDialog(dialog, confirmed);
  publish({ ...state, status: "closing" });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedDialogs.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeDialog = next;
  publish(
    next.mode === "alert"
      ? {
          status: "confirming",
          mode: "alert",
          title: next.title,
          ...(next.description === undefined ? {} : { description: next.description }),
        }
      : {
          status: "confirming",
          mode: "confirm",
          message: next.message,
          variant: next.variant,
        },
  );
}

export function resetConfirmDialogForTests(): void {
  resolvePendingDialogs(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
