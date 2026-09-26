import { GetTaxSettings } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import {
  RetrieveTaxSettings,
  type RetrieveTaxSettingsRequest,
} from "./RetrieveTaxSettings.ts";
import {
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";
import type { TaxSettings } from "./TaxSettings.ts";

/**
 * HTTP implementation of {@link RetrieveTaxSettings}. Provide it on the
 * Function or Worker Effect. Tax Settings has no Stripe id — only the API
 * key is bound.
 *
 * @layer
 * @provides Stripe.RetrieveTaxSettings
 */
export const RetrieveTaxSettingsHttp = Layer.effect(
  RetrieveTaxSettings,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (settings: TaxSettings) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        settings as unknown as ResourceLike,
        ["tax_read"],
        "Stripe.RetrieveTaxSettings",
      );
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;
      return Effect.fn(`Stripe.RetrieveTaxSettings(${settings.LogicalId})`)(
        function* (request?: RetrieveTaxSettingsRequest) {
          return yield* auth(GetTaxSettings(request ?? {}));
        },
      );
    });
  }),
);
