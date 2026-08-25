import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WebExperience } from "./WebExperience.ts";

/**
 * `CreateAnonymousWebExperienceUrl` request with `applicationId` +
 * `webExperienceId` injected from the bound web experience.
 */
export interface CreateAnonymousWebExperienceUrlRequest {
  /**
   * How long the session opened from the returned URL lasts (wire:
   * `sessionDurationInMinutes`, 15-60 minutes).
   * @default 15 minutes
   */
  sessionDuration?: Duration.Input;
}

/**
 * Runtime binding for the `CreateAnonymousWebExperienceUrl` operation (IAM action
 * `qbusiness:CreateAnonymousWebExperienceUrl`), scoped to one {@link WebExperience}.
 *
 * Mints a short-lived URL that opens the web experience without
 * authentication (applications created with the `ANONYMOUS`
 * identity type).
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.CreateAnonymousWebExperienceUrlHttp)`.
 *
 * @binding
 * @section Anonymous Access
 * @example Mint an Anonymous Chat URL
 * ```typescript
 * const createUrl =
 *   yield* AWS.QBusiness.CreateAnonymousWebExperienceUrl(web);
 *
 * const { anonymousUrl } = yield* createUrl({
 *   sessionDuration: "30 minutes",
 * });
 * ```
 */
export interface CreateAnonymousWebExperienceUrl extends Binding.Service<
  CreateAnonymousWebExperienceUrl,
  "AWS.QBusiness.CreateAnonymousWebExperienceUrl",
  (
    webExperience: WebExperience,
  ) => Effect.Effect<
    (
      request?: CreateAnonymousWebExperienceUrlRequest,
    ) => Effect.Effect<
      qbusiness.CreateAnonymousWebExperienceUrlResponse,
      qbusiness.CreateAnonymousWebExperienceUrlError
    >
  >
> {}
export const CreateAnonymousWebExperienceUrl =
  Binding.Service<CreateAnonymousWebExperienceUrl>(
    "AWS.QBusiness.CreateAnonymousWebExperienceUrl",
  );
