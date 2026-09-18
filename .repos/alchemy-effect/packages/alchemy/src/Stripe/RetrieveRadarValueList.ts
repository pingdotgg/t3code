import type {
  GetRadarValueListError,
  GetRadarValueListRequest,
  RadarValueList as StripeRadarValueList,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { RadarValueList } from "./RadarValueList.ts";

export interface RetrieveRadarValueListRequest extends Omit<
  GetRadarValueListRequest,
  "value_list"
> {}

/**
 * Retrieve a bound Stripe Radar Value List over HTTP.
 *
 * ### Reading a Value List
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveRadarValueList(blocklist);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveRadarValueList extends Binding.Service<
  RetrieveRadarValueList,
  "Stripe.RetrieveRadarValueList",
  (
    valueList: RadarValueList,
  ) => Effect.Effect<
    (
      request?: RetrieveRadarValueListRequest,
    ) => Effect.Effect<
      StripeRadarValueList,
      GetRadarValueListError,
      RuntimeContext
    >
  >
> {}

export const RetrieveRadarValueList = Binding.Service<RetrieveRadarValueList>(
  "Stripe.RetrieveRadarValueList",
);
