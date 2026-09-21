import { CreateAppsSecret as createAppsSecretOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateAppsSecret } from "./CreateAppsSecret.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateAppsSecret}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateAppsSecret
 */
export const CreateAppsSecretHttp = Layer.effect(
  CreateAppsSecret,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateAppsSecret",
    operation: createAppsSecretOp,
    permissions: ["apps_secrets_write"],
  }),
);
