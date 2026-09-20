import type {
  GetRadarValueListItemError,
  GetRadarValueListItemRequest,
  RadarValueListItem as StripeRadarValueListItem,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { RadarValueListItem } from "./RadarValueListItem.ts";

export interface RetrieveRadarValueListItemRequest extends Omit<
  GetRadarValueListItemRequest,
  "item"
> {}

/**
 * Retrieve a bound Stripe Radar Value List Item over HTTP.
 *
 * ### Reading a Value List Item
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveRadarValueListItem(item);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveRadarValueListItem extends Binding.Service<
  RetrieveRadarValueListItem,
  "Stripe.RetrieveRadarValueListItem",
  (
    item: RadarValueListItem,
  ) => Effect.Effect<
    (
      request?: RetrieveRadarValueListItemRequest,
    ) => Effect.Effect<
      StripeRadarValueListItem,
      GetRadarValueListItemError,
      RuntimeContext
    >
  >
> {}

export const RetrieveRadarValueListItem =
  Binding.Service<RetrieveRadarValueListItem>(
    "Stripe.RetrieveRadarValueListItem",
  );
