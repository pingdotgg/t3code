import type {
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
} from "@t3tools/contracts";

export type RelayClientInstallDialogState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly version: string }
  | {
      readonly status: "installing";
      readonly version: string;
      readonly stage: RelayClientInstallProgressStage;
    }
  | {
      readonly status: "closing";
      readonly view:
        | { readonly status: "confirming"; readonly version: string }
        | {
            readonly status: "installing";
            readonly version: string;
            readonly stage: RelayClientInstallProgressStage;
          };
    };

const idleState: RelayClientInstallDialogState = { status: "idle" };
let state: RelayClientInstallDialogState = idleState;
let resolveConfirmation: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: RelayClientInstallDialogState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readRelayClientInstallDialogState(): RelayClientInstallDialogState {
  return state;
}

export function subscribeRelayClientInstallDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestRelayClientInstallConfirmation(version: string): Promise<boolean> {
  if (state.status !== "idle") {
    return Promise.reject(new Error("A relay client installation is already in progress."));
  }

  publish({ status: "confirming", version });
  return new Promise<boolean>((resolve) => {
    resolveConfirmation = resolve;
  });
}

export function respondToRelayClientInstallConfirmation(confirmed: boolean): void {
  if (state.status !== "confirming" || !resolveConfirmation) {
    return;
  }

  const resolve = resolveConfirmation;
  resolveConfirmation = null;
  publish(
    confirmed
      ? { status: "installing", version: state.version, stage: "checking" }
      : { status: "closing", view: state },
  );
  resolve(confirmed);
}

export function reportRelayClientInstallProgress(event: RelayClientInstallProgressEvent): void {
  if (state.status !== "installing" || event.type !== "progress") {
    return;
  }
  publish({ ...state, stage: event.stage });
}

export function finishRelayClientInstall(): void {
  resolveConfirmation?.(false);
  resolveConfirmation = null;
  if (state.status === "confirming" || state.status === "installing") {
    publish({ status: "closing", view: state });
  }
}

export function completeRelayClientInstallDialogClose(): void {
  if (state.status === "closing") {
    publish(idleState);
  }
}

export function resetRelayClientInstallDialogForTests(): void {
  resolveConfirmation?.(false);
  resolveConfirmation = null;
  publish(idleState);
  listeners.clear();
}
