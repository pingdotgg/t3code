import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface CreateShellAuthTokenRequest
  extends microvms.CreateMicrovmShellAuthTokenRequest {}

/**
 * Runtime binding for `CreateMicrovmShellAuthToken`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that mints a short-lived
 * token for interactive shell access to a running MicroVM (the MicroVM must
 * have been run with the shell ingress connector attached).
 * @binding
 * @section Auth Tokens
 * @example Mint a shell auth token
 * ```typescript
 * const createShellAuthToken = yield* AWS.Lambda.CreateShellAuthToken(Sandbox);
 * const { authToken } = yield* createShellAuthToken({
 *   microvmIdentifier: vm.microvmId,
 *   expirationInMinutes: 5,
 * });
 * ```
 */
export interface CreateShellAuthToken extends Binding.Service<
  CreateShellAuthToken,
  "AWS.Lambda.CreateShellAuthToken",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: CreateShellAuthTokenRequest,
    ) => Effect.Effect<
      microvms.CreateMicrovmShellAuthTokenResponse,
      microvms.CreateMicrovmShellAuthTokenError
    >
  >
> {}
export const CreateShellAuthToken = Binding.Service<CreateShellAuthToken>(
  "AWS.Lambda.CreateShellAuthToken",
);
