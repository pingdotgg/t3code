import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link GetSessionEndpoint} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type GetSessionEndpointInput = Omit<
  emr.GetSessionEndpointRequest,
  "applicationId"
>;

/**
 * Runtime binding for `emr-serverless:GetSessionEndpoint`.
 *
 * Resolves the connection endpoint and short-lived auth token for an
 * interactive session on the bound {@link Application}. The `authToken` in
 * the response is `Redacted` — unwrap it with `Redacted.value` only at the
 * point of use. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.GetSessionEndpointHttp)`.
 * @binding
 * @section Interactive Sessions
 * @example Connect To A Session
 * ```typescript
 * // init
 * const getSessionEndpoint = yield* AWS.EMRServerless.GetSessionEndpoint(app);
 *
 * // runtime
 * const { endpoint, authToken } = yield* getSessionEndpoint({ sessionId });
 * ```
 */
export interface GetSessionEndpoint extends Binding.Service<
  GetSessionEndpoint,
  "AWS.EMRServerless.GetSessionEndpoint",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetSessionEndpointInput,
    ) => Effect.Effect<
      emr.GetSessionEndpointResponse,
      emr.GetSessionEndpointError
    >
  >
> {}
export const GetSessionEndpoint = Binding.Service<GetSessionEndpoint>(
  "AWS.EMRServerless.GetSessionEndpoint",
);
