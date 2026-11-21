import type { ProviderInstallState } from "@t3tools/contracts";
import type { ProviderMaintenanceManagedUpdateResult } from "@t3tools/provider-core/server/maintenance";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

const PROGRESS_INTERVAL_MS = 1_000;

export interface ManagedInstallationUpdater {
  readonly start: Effect.Effect<ProviderInstallState, { readonly message: string }>;
  readonly changes: Stream.Stream<ProviderInstallState>;
}

function isRunningPhase(phase: ProviderInstallState["phase"]): boolean {
  return phase === "downloading" || phase === "extracting" || phase === "verifying";
}

function formatManagedInstallProgress(state: ProviderInstallState): string | null {
  if (state.phase === "downloading" && state.downloadedBytes > 0) {
    const downloaded = (state.downloadedBytes / 1_000_000).toFixed(1);
    return state.totalBytes !== null && state.totalBytes > 0
      ? `Downloading ${downloaded} MB of ${(state.totalBytes / 1_000_000).toFixed(1)} MB`
      : `Downloading ${downloaded} MB`;
  }
  const message = state.message?.trim();
  return message && message.length > 0 ? message : null;
}

export const runManagedInstallationUpdate = Effect.fn("runManagedInstallationUpdate")(function* (
  installation: ManagedInstallationUpdater,
  onProgress: (line: string) => Effect.Effect<void>,
): Effect.fn.Return<ProviderMaintenanceManagedUpdateResult> {
  const startedResult = yield* installation.start.pipe(Effect.result);
  if (startedResult._tag === "Failure") {
    return { status: "failed", message: startedResult.failure.message };
  }
  const started = startedResult.success;
  if (started.phase === "succeeded") {
    return { status: "succeeded" };
  }
  if (!isRunningPhase(started.phase) || started.operationId === null) {
    return {
      status: "failed",
      message: started.message ?? "Provider update failed.",
    };
  }

  let lastPhase: ProviderInstallState["phase"] | null = null;
  let lastMessage: string | null = null;
  let lastReportedAt = 0;

  const reportProgress = Effect.fn("runManagedInstallationUpdate.reportProgress")(function* (
    state: ProviderInstallState,
  ) {
    if (!isRunningPhase(state.phase)) return;
    const line = formatManagedInstallProgress(state);
    if (line === null || line === lastMessage) return;
    const now = yield* Clock.currentTimeMillis;
    if (state.phase === lastPhase && now - lastReportedAt < PROGRESS_INTERVAL_MS) return;
    lastPhase = state.phase;
    lastMessage = line;
    lastReportedAt = now;
    yield* onProgress(line);
  });

  yield* reportProgress(started);

  const terminal = yield* installation.changes.pipe(
    Stream.tap((state) =>
      state.operationId === started.operationId ? reportProgress(state) : Effect.void,
    ),
    Stream.filter(
      (state) => state.operationId !== started.operationId || !isRunningPhase(state.phase),
    ),
    Stream.runHead,
  );

  if (Option.isNone(terminal)) {
    return { status: "failed", message: "Provider update did not finish." };
  }
  const finalState = terminal.value;
  if (finalState.operationId !== started.operationId) {
    return { status: "failed", message: "Provider installation changed while updating." };
  }
  if (finalState.phase === "succeeded") {
    return { status: "succeeded" };
  }
  return {
    status: "failed",
    message:
      finalState.message ??
      (finalState.phase === "cancelled"
        ? "Provider update was cancelled."
        : "Provider update failed."),
  };
});
