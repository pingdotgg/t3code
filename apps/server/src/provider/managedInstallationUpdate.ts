import type { ProviderDriverKind, ProviderInstallState } from "@t3tools/contracts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceManagedUpdateResult,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

export interface ManagedInstallation {
  readonly start: Effect.Effect<ProviderInstallState, { readonly detail: string }>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly checkForUpdate: Effect.Effect<void>;
}

const isRunning = (state: ProviderInstallState) =>
  state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying";

const runManagedInstallationUpdate = Effect.fn("runManagedInstallationUpdate")(function* (
  installation: ManagedInstallation,
  onProgress: (line: string) => Effect.Effect<void>,
): Effect.fn.Return<ProviderMaintenanceManagedUpdateResult> {
  const started = yield* installation.start.pipe(Effect.result);
  if (Result.isFailure(started)) return { status: "failed", message: started.failure.detail };
  const { operationId } = started.success;
  if (operationId === null || !isRunning(started.success)) {
    return started.success.phase === "succeeded"
      ? { status: "succeeded" }
      : { status: "failed", message: started.success.message ?? "Provider update failed." };
  }
  // Download progress changes only the byte counts; forward the messages, not every chunk.
  const finished = yield* installation.changes.pipe(
    Stream.changesWith(
      (a, b) => a.operationId === b.operationId && a.phase === b.phase && a.message === b.message,
    ),
    Stream.tap((state) =>
      state.operationId === operationId && isRunning(state) && state.message
        ? onProgress(state.message)
        : Effect.void,
    ),
    Stream.filter((state) => state.operationId !== operationId || !isRunning(state)),
    Stream.runHead,
  );
  if (Option.isSome(finished) && finished.value.operationId === operationId) {
    if (finished.value.phase === "succeeded") return { status: "succeeded" };
    return { status: "failed", message: finished.value.message ?? "Provider update failed." };
  }
  return { status: "failed", message: "Provider installation changed while updating." };
});

/** One-click updates for an instance that runs the T3-managed runtime; anything else stays manual. */
export function makeManagedInstallationMaintenance(input: {
  readonly provider: ProviderDriverKind;
  readonly installation: ManagedInstallation;
  readonly executable: Option.Option<{ readonly source: string; readonly executablePath: string }>;
}): ProviderMaintenanceCapabilities {
  const { provider, installation, executable } = input;
  if (Option.isNone(executable) || executable.value.source !== "managed") {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      ...(Option.isSome(executable) ? { installPath: executable.value.executablePath } : {}),
    });
  }
  const lockKey = `${provider}-managed`;
  return {
    provider,
    packageName: null,
    update: null,
    managedUpdate: {
      lockKey,
      run: (onProgress) => runManagedInstallationUpdate(installation, onProgress),
    },
    latestVersionCacheKey: lockKey,
    // The installation offers its newest eligible release through `state.version`.
    lookupLatestVersion: installation.checkForUpdate.pipe(
      Effect.andThen(installation.state),
      Effect.map((state) => state.version),
    ),
  };
}
