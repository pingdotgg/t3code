import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface CreateAuthTokenRequest
  extends microvms.CreateMicrovmAuthTokenRequest {}

/**
 * Runtime binding for `CreateMicrovmAuthToken`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that mints a short-lived
 * token for a running MicroVM. Send it on the MicroVM `endpoint` in the
 * `X-aws-proxy-auth` header.
 * @binding
 * @section Auth Tokens
 * @example Mint an auth token
 * ```typescript
 * const createAuthToken = yield* AWS.Lambda.CreateAuthToken(Sandbox);
 * const { authToken } = yield* createAuthToken({
 *   microvmIdentifier: vm.microvmId,
 *   expirationInMinutes: 5,
 *   allowedPorts: [{ port: 5000 }],
 * });
 * ```
 */
export interface CreateAuthToken extends Binding.Service<
  CreateAuthToken,
  "AWS.Lambda.CreateAuthToken",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: CreateAuthTokenRequest,
    ) => Effect.Effect<
      microvms.CreateMicrovmAuthTokenResponse,
      microvms.CreateMicrovmAuthTokenError
    >
  >
> {}
export const CreateAuthToken = Binding.Service<CreateAuthToken>(
  "AWS.Lambda.CreateAuthToken",
);
