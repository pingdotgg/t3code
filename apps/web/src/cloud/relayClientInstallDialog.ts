import {
  RelayClientInstallProgressStageSchema,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class RelayClientInstallConfirmationConflictError extends Schema.TaggedError<RelayClientInstallConfirmationConflictError>()(
  "RelayClientInstallConfirmationConflictError",
  {
    requestedVersion: Schema.String,
    activeVersion: Schema.String,
    activeDialogStatus: Schema.Literals(["confirming", "installing", "closing"]),
    activeInstallStage: Schema.optional(RelayClientInstallProgressStageSchema),
  },
) {
  override get message(): string {
    return `Cannot confirm relay client installation ${this.requestedVersion}; installation ${this.activeVersion} has dialog status ${this.activeDialogStatus}.`;
  }
}

export interface RelayClientInstallingState {
  readonly status: "installing";
  readonly version: string;
  readonly stage: RelayClientInstallProgressStage;
  /** Size of the finished download, once the server reports it. */
  readonly downloadedBytes?: number;
  /** True once the download matched the pinned sha256. */
  readonly checksumVerified?: boolean;
  /** Cancel was pressed; the install stream is being interrupted. */
  readonly cancelling?: boolean;
}

export type RelayClientInstallDialogState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly version: string }
  | RelayClientInstallingState
  | {
      readonly status: "closing";
      readonly view:
        | { readonly status: "confirming"; readonly version: string }
        | RelayClientInstallingState;
    };

const idleState: RelayClientInstallDialogState = { status: "idle" };
let state: RelayClientInstallDialogState = idleState;
let resolveConfirmation: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const cancelListeners = new Set<() => void>();

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
    const activeInstall = state.status === "closing" ? state.view : state;
    return Promise.reject(
      new RelayClientInstallConfirmationConflictError({
        requestedVersion: version,
        activeVersion: activeInstall.version,
        activeDialogStatus: state.status,
        ...(activeInstall.status === "installing"
          ? { activeInstallStage: activeInstall.stage }
          : {}),
      }),
    );
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
  if (state.status !== "installing" || event.type !== "progress" || state.cancelling) {
    return;
  }
  publish({
    ...state,
    stage: event.stage,
    ...(event.downloadedBytes !== undefined ? { downloadedBytes: event.downloadedBytes } : {}),
    ...(event.checksumVerified ? { checksumVerified: true } : {}),
  });
}

// Interrupt the install stream to release server temp state and locks; activation cannot be cancelled.
export function cancelRelayClientInstall(): void {
  if (state.status !== "installing" || state.cancelling) {
    return;
  }
  publish({ ...state, cancelling: true });
  for (const listener of cancelListeners) {
    listener();
  }
}

export function onRelayClientInstallCancel(listener: () => void): () => void {
  cancelListeners.add(listener);
  return () => {
    cancelListeners.delete(listener);
  };
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
  cancelListeners.clear();
}
