import type {
  CreateTaxSettingsError,
  CreateTaxSettingsRequest,
  TaxSettings as StripeTaxSettings,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TaxSettings } from "./TaxSettings.ts";

export interface UpdateTaxSettingsRequest extends CreateTaxSettingsRequest {}

/**
 * Update bound Stripe Tax Settings over HTTP. Tax Settings is an account
 * singleton — the update op has no id field; the bound resource associates
 * the API key with the host. Fields Stripe has already set cannot be
 * removed.
 *
 * ### Updating Tax Settings
 * **Example:** Bind and update
 * ```typescript
 * const update = yield* Stripe.UpdateTaxSettings(settings);
 * const live = yield* update({
 *   defaults: { tax_behavior: "exclusive" },
 * });
 * ```
 *
 * @binding
 */
export interface UpdateTaxSettings extends Binding.Service<
  UpdateTaxSettings,
  "Stripe.UpdateTaxSettings",
  (
    settings: TaxSettings,
  ) => Effect.Effect<
    (
      request?: UpdateTaxSettingsRequest,
    ) => Effect.Effect<
      StripeTaxSettings,
      CreateTaxSettingsError,
      RuntimeContext
    >
  >
> {}

export const UpdateTaxSettings = Binding.Service<UpdateTaxSettings>(
  "Stripe.UpdateTaxSettings",
);
