import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:GetMessageInsights`.
 *
 * Retrieves the delivery insights SES tracked for a single sent message —
 * the per-recipient event timeline (send, delivery, open, click, bounce,
 * complaint) plus the resolved subject, from-address, and tags. Requires VDM
 * (Virtual Deliverability Manager) to be enabled and the message to have been
 * sent within the retention window; an unknown message id fails with the
 * typed `NotFoundException`. Account-level operation. Provide the
 * implementation with `Effect.provide(AWS.SES.GetMessageInsightsHttp)`.
 * ### Deliverability Insights
 * **Example:** Look Up a Message's Delivery Timeline
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInsights = yield* SES.GetMessageInsights();
 *
 * // runtime — MessageId returned by a prior SendEmail
 * const { Insights } = yield* getInsights({ MessageId: messageId });
 * ```
 *
 * @binding
 */
export interface GetMessageInsights extends Binding.Service<
  GetMessageInsights,
  "AWS.SES.GetMessageInsights",
  () => Effect.Effect<
    (
      request: sesv2.GetMessageInsightsRequest,
    ) => Effect.Effect<
      sesv2.GetMessageInsightsResponse,
      sesv2.GetMessageInsightsError
    >
  >
> {}
export const GetMessageInsights = Binding.Service<GetMessageInsights>(
  "AWS.SES.GetMessageInsights",
);
