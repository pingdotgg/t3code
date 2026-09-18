import type {
  GetTaxSettingsError,
  GetTaxSettingsRequest,
  TaxSettings as StripeTaxSettings,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TaxSettings } from "./TaxSettings.ts";

export interface RetrieveTaxSettingsRequest extends GetTaxSettingsRequest {}

/**
 * Retrieve bound Stripe Tax Settings over HTTP. Tax Settings is an
 * account singleton — the retrieve op has no id field; the bound resource
 * associates the API key with the host.
 *
 * ### Reading Tax Settings
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTaxSettings(settings);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveTaxSettings extends Binding.Service<
  RetrieveTaxSettings,
  "Stripe.RetrieveTaxSettings",
  (
    settings: TaxSettings,
  ) => Effect.Effect<
    (
      request?: RetrieveTaxSettingsRequest,
    ) => Effect.Effect<StripeTaxSettings, GetTaxSettingsError, RuntimeContext>
  >
> {}

export const RetrieveTaxSettings = Binding.Service<RetrieveTaxSettings>(
  "Stripe.RetrieveTaxSettings",
);
