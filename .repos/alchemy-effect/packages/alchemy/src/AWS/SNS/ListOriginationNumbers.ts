import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListOriginationNumbersRequest
  extends sns.ListOriginationNumbersRequest {}

/**
 * Runtime binding for `sns:ListOriginationNumbers`.
 *
 * An account-scoped operation — lists the origination phone numbers
 * available to send SMS from this account.
 * Provide the `ListOriginationNumbersHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Account Settings
 * @example List Origination Numbers
 * ```typescript
 * const listOriginationNumbers = yield* SNS.ListOriginationNumbers();
 * const { PhoneNumbers } = yield* listOriginationNumbers();
 * ```
 */
export interface ListOriginationNumbers extends Binding.Service<
  ListOriginationNumbers,
  "AWS.SNS.ListOriginationNumbers",
  () => Effect.Effect<
    (
      request?: ListOriginationNumbersRequest,
    ) => Effect.Effect<
      sns.ListOriginationNumbersResult,
      sns.ListOriginationNumbersError
    >
  >
> {}

export const ListOriginationNumbers = Binding.Service<ListOriginationNumbers>(
  "AWS.SNS.ListOriginationNumbers",
);
