import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

/**
 * Runtime binding for `datazone:GetIamPortalLoginUrl`.
 *
 * Mints a single-use data portal sign-in URL for the bound domain, e.g. to embed in a notification. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetIamPortalLoginUrlHttp)`.
 * @binding
 * @section Portal, Profiles & Notifications
 * @example Mint a Portal URL
 * ```typescript
 * // init — bind the operation to the domain
 * const getIamPortalLoginUrl = yield* AWS.DataZone.GetIamPortalLoginUrl(domain);
 *
 * // runtime
 * const { authCodeUrl } = yield* getIamPortalLoginUrl();
 * ```
 */
export interface GetIamPortalLoginUrl extends Binding.Service<
  GetIamPortalLoginUrl,
  "AWS.DataZone.GetIamPortalLoginUrl",
  (
    domain: Domain,
  ) => Effect.Effect<
    () => Effect.Effect<
      datazone.GetIamPortalLoginUrlOutput,
      datazone.GetIamPortalLoginUrlError
    >
  >
> {}
export const GetIamPortalLoginUrl = Binding.Service<GetIamPortalLoginUrl>(
  "AWS.DataZone.GetIamPortalLoginUrl",
);
