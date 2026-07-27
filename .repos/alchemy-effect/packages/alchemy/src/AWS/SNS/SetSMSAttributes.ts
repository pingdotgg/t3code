import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface SetSMSAttributesRequest extends sns.SetSMSAttributesInput {}

/**
 * Runtime binding for `sns:SetSMSAttributes`.
 *
 * An account-scoped operation — updates the account-level SMS settings,
 * e.g. switching the default message type between `Promotional` and
 * `Transactional`.
 * Provide the `SetSMSAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Account Settings
 * @example Set the Default SMS Type
 * ```typescript
 * const setSmsAttributes = yield* SNS.SetSMSAttributes();
 * yield* setSmsAttributes({
 *   attributes: { DefaultSMSType: "Transactional" },
 * });
 * ```
 */
export interface SetSMSAttributes extends Binding.Service<
  SetSMSAttributes,
  "AWS.SNS.SetSMSAttributes",
  () => Effect.Effect<
    (
      request: SetSMSAttributesRequest,
    ) => Effect.Effect<sns.SetSMSAttributesResponse, sns.SetSMSAttributesError>
  >
> {}

export const SetSMSAttributes = Binding.Service<SetSMSAttributes>(
  "AWS.SNS.SetSMSAttributes",
);
