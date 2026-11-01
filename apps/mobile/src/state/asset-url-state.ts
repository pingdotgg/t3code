import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { AssetUrlState as SharedAssetUrlState } from "@t3tools/client-runtime/state/assets";

export type AssetUrlFailureReason = "disconnected" | "failed" | "missing-file-access";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly reason: AssetUrlFailureReason }
  | Extract<SharedAssetUrlState, { readonly _tag: "Success" }>;

export function deriveAssetUrlState(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly shared: SharedAssetUrlState;
}): AssetUrlState {
  if (
    input.connectionPhase === "offline" ||
    input.connectionPhase === "reconnecting" ||
    input.connectionPhase === "error" ||
    input.connectionPhase === "unsupported"
  ) {
    return { _tag: "Failure", reason: "disconnected" };
  }
  if (input.shared._tag === "Success") {
    return input.shared;
  }
  switch (input.connectionPhase) {
    // available means idle before dialing. A query failure there means disconnected, not missing file.
    case "available":
      return input.shared._tag === "Failure"
        ? { _tag: "Failure", reason: "disconnected" }
        : { _tag: "Loading" };
    case "connecting":
      return { _tag: "Loading" };
    case "connected":
      return input.shared._tag === "Failure"
        ? { _tag: "Failure", reason: input.shared.reason ?? "failed" }
        : { _tag: "Loading" };
  }
}
