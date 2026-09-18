import { DEFAULT_API_BASE_URL } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getEnv, getEnvRedactedRequired } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const STRIPE_AUTH_PROVIDER_NAME = "Stripe";
export const STRIPE_API_KEY_ENV = "STRIPE_API_KEY";
export const STRIPE_API_BASE_URL_ENV = "STRIPE_API_BASE_URL";

export type StripeAuthConfig = StoredAuthConfig;

export type StripeResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: StripeAuthConfig["method"] | "env"; details?: string };
};

const stripeAuth = makeStoredAuthProvider<StripeResolvedCredentials>({
  provider: STRIPE_AUTH_PROVIDER_NAME,
  fields: [
    { name: "apiKey", label: "Stripe Secret API Key", secret: true },
    {
      name: "apiBaseUrl",
      label: "Stripe API base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    apiKey: getEnvRedactedRequired(STRIPE_API_KEY_ENV),
    apiBaseUrl: getEnv(STRIPE_API_BASE_URL_ENV),
  }).pipe(
    Effect.map(({ apiKey, apiBaseUrl }) => ({
      type: "apiKey" as const,
      apiKey,
      apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
      source: {
        type: "env" as const,
        details: apiBaseUrl
          ? `${STRIPE_API_KEY_ENV}, ${STRIPE_API_BASE_URL_ENV}`
          : STRIPE_API_KEY_ENV,
      },
    })),
  ),
  environment: [
    { name: STRIPE_API_KEY_ENV, required: true, secret: true },
    { name: STRIPE_API_BASE_URL_ENV, required: false },
  ],
});

/**
 * Layer that registers the Stripe {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Stripe `providers()`
 * layer so the alchemy CLI can discover it.
 *
 * Auth is a Stripe secret API key (`STRIPE_API_KEY`, typically `sk_test_…`
 * or `sk_live_…`). There is no OAuth flow. An optional
 * `STRIPE_API_BASE_URL` overrides the API root (default
 * `https://api.stripe.com`).
 */
export const StripeAuth = stripeAuth.layer;
