import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { AsyncResult } from "effect/unstable/reactivity";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Disconnected" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string };

export function resolveAssetUrlState(input: {
  readonly httpBaseUrl: string | null;
  readonly requested: boolean;
  readonly result: AsyncResult.AsyncResult<{ readonly relativeUrl: string }, unknown>;
}): AssetUrlState {
  if (!input.requested) {
    return { _tag: "Loading" };
  }
  if (input.result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  // Environment queries park on Effect.never while disconnected, so a missing
  // prepared connection is a terminal state even when the atom still looks waiting.
  if (input.httpBaseUrl === null) {
    return { _tag: "Disconnected" };
  }
  if (input.result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(input.httpBaseUrl, input.result.value.relativeUrl);
  return url === null ? { _tag: "Failure" } : { _tag: "Success", url };
}
