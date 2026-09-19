import { CreateTaxSettings } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import {
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";
import type { TaxSettings } from "./TaxSettings.ts";
import {
  UpdateTaxSettings,
  type UpdateTaxSettingsRequest,
} from "./UpdateTaxSettings.ts";

/**
 * HTTP implementation of {@link UpdateTaxSettings}. Provide it on the
 * Function or Worker Effect. Tax Settings has no Stripe id — only the API
 * key is bound.
 *
 * @layer
 * @provides Stripe.UpdateTaxSettings
 */
export const UpdateTaxSettingsHttp = Layer.effect(
  UpdateTaxSettings,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (settings: TaxSettings) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        settings as unknown as ResourceLike,
        ["tax_write"],
        "Stripe.UpdateTaxSettings",
      );
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;
      return Effect.fn(`Stripe.UpdateTaxSettings(${settings.LogicalId})`)(
        function* (request?: UpdateTaxSettingsRequest) {
          return yield* auth(CreateTaxSettings(request ?? {}));
        },
      );
    });
  }),
);
