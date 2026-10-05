import type * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AppsDebugToken } from "./AppsDebugToken.ts";

export interface ExchangeDebugTokenRequest {
  /**
   * When true, the attestation is limited-use (replay protection).
   * @default false
   */
  limitedUse?: boolean;
}

/**
 * Runtime binding for App Check `apps.exchangeDebugToken`.
 *
 * Bind this operation to an {@link AppsDebugToken} in a Function/Action
 * init phase. Provide {@link ExchangeDebugTokenHttp}. The secret is read
 * from Alchemy state (`token` is never returned by get).
 *
 * ### Exchanging a Debug Token
 * **Example:** Mint a session App Check token
 * ```typescript
 * const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(debug);
 * const { token, ttl } = yield* exchange();
 * ```
 *
 * **Example:** Limited-use token
 * ```typescript
 * const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(debug);
 * const { token } = yield* exchange({ limitedUse: true });
 * ```
 *
 * @binding
 * @category FirebaseAppCheck
 */
export interface ExchangeDebugToken extends Binding.Service<
  ExchangeDebugToken,
  "GCP.FirebaseAppCheck.ExchangeDebugToken",
  (
    debugToken: AppsDebugToken,
  ) => Effect.Effect<
    (
      request?: ExchangeDebugTokenRequest,
    ) => Effect.Effect<
      firebaseappcheck.GoogleFirebaseAppcheckV1AppCheckToken,
      firebaseappcheck.ExchangeDebugTokenProjectsAppsError,
      RuntimeContext
    >
  >
> {}

export const ExchangeDebugToken = Binding.Service<ExchangeDebugToken>(
  "GCP.FirebaseAppCheck.ExchangeDebugToken",
);
