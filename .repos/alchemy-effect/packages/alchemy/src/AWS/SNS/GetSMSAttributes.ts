import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetSMSAttributesRequest extends sns.GetSMSAttributesInput {}

/**
 * Runtime binding for `sns:GetSMSAttributes`.
 *
 * An account-scoped operation — reads the account-level SMS settings such
 * as `DefaultSMSType`, `MonthlySpendLimit`, and delivery-status sampling.
 * Provide the `GetSMSAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Account Settings
 * @example Read SMS Settings
 * ```typescript
 * const getSmsAttributes = yield* SNS.GetSMSAttributes();
 * const { attributes } = yield* getSmsAttributes();
 * ```
 */
export interface GetSMSAttributes extends Binding.Service<
  GetSMSAttributes,
  "AWS.SNS.GetSMSAttributes",
  () => Effect.Effect<
    (
      request?: GetSMSAttributesRequest,
    ) => Effect.Effect<sns.GetSMSAttributesResponse, sns.GetSMSAttributesError>
  >
> {}

export const GetSMSAttributes = Binding.Service<GetSMSAttributes>(
  "AWS.SNS.GetSMSAttributes",
);
