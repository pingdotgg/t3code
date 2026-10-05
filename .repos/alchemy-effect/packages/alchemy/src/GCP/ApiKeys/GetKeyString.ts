import type * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Key } from "./Key.ts";

/**
 * Runtime binding for API Keys `keys.getKeyString`.
 *
 * Bind this operation to a {@link Key} in a Function/Action init phase.
 * Provide {@link GetKeyStringHttp}. The key string is not included on
 * `keys.get` — this is the only way to read it.
 *
 * ### Reading the Key String
 * **Example:** Get the encrypted key string
 * ```typescript
 * const getKeyString = yield* GCP.ApiKeys.GetKeyString(maps);
 * const { keyString } = yield* getKeyString();
 * ```
 *
 * @binding
 * @category ApiKeys
 */
export interface GetKeyString extends Binding.Service<
  GetKeyString,
  "GCP.ApiKeys.GetKeyString",
  (
    key: Key,
  ) => Effect.Effect<
    () => Effect.Effect<
      apikeys.V2GetKeyStringResponse,
      apikeys.GetKeyStringProjectsLocationsKeysError,
      RuntimeContext
    >
  >
> {}

export const GetKeyString = Binding.Service<GetKeyString>(
  "GCP.ApiKeys.GetKeyString",
);
