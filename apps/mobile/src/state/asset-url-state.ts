import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { AssetUrlState as SharedAssetUrlState } from "@t3tools/client-runtime/state/assets";

export type AssetUrlFailureReason = "disconnected" | "failed";

/** The shared state plus a reason on failure, so previews can offer the right retry. */
export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly reason: AssetUrlFailureReason }
  | Extract<SharedAssetUrlState, { readonly _tag: "Success" }>;

/**
 * Folds the shared asset URL state with the environment connection phase. A
 * dead environment wins over everything else: even a resolved URL is
 * unreachable there, and a failed query is caused by the outage, not the file.
 */
export function deriveAssetUrlState(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly shared: SharedAssetUrlState;
}): AssetUrlState {
  if (
    input.connectionPhase === "offline" ||
    input.connectionPhase === "reconnecting" ||
    input.connectionPhase === "error"
  ) {
    return { _tag: "Failure", reason: "disconnected" };
  }
  if (input.shared._tag === "Success") {
    return input.shared;
  }
  switch (input.connectionPhase) {
    // "available" is the idle, not yet dialled state. A pending query there is
    // still on its way, but the query atom fails at once while idle, so a
    // failure means the environment is not connected rather than the file is
    // missing.
    case "available":
      return input.shared._tag === "Failure"
        ? { _tag: "Failure", reason: "disconnected" }
        : { _tag: "Loading" };
    case "connecting":
      return { _tag: "Loading" };
    case "connected":
      return input.shared._tag === "Failure"
        ? { _tag: "Failure", reason: "failed" }
        : { _tag: "Loading" };
  }
}
