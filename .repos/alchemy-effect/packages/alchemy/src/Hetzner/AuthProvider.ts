import { DEFAULT_API_BASE_URL } from "@distilled.cloud/hetzner";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getEnv, getEnvRedactedRequired } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const HETZNER_AUTH_PROVIDER_NAME = "Hetzner";
export const HCLOUD_TOKEN_ENV = "HCLOUD_TOKEN";
export const HCLOUD_ENDPOINT_ENV = "HCLOUD_ENDPOINT";

export type HetznerAuthConfig = StoredAuthConfig;

export type HetznerResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: HetznerAuthConfig["method"] | "env"; details?: string };
};

const hetznerAuth = makeStoredAuthProvider<HetznerResolvedCredentials>({
  provider: HETZNER_AUTH_PROVIDER_NAME,
  fields: [
    { name: "token", label: "Hetzner Cloud API Token", secret: true },
    {
      name: "apiBaseUrl",
      label: "Hetzner API endpoint",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values) => ({
    type: "token",
    token: storedSecret(values.token) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    token: getEnvRedactedRequired(HCLOUD_TOKEN_ENV),
    apiBaseUrl: getEnv(HCLOUD_ENDPOINT_ENV),
  }).pipe(
    Effect.map(({ token, apiBaseUrl }) => ({
      type: "token" as const,
      token,
      apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
      source: {
        type: "env" as const,
        details: apiBaseUrl
          ? `${HCLOUD_TOKEN_ENV}, ${HCLOUD_ENDPOINT_ENV}`
          : HCLOUD_TOKEN_ENV,
      },
    })),
  ),
  environment: [
    { name: HCLOUD_TOKEN_ENV, required: true, secret: true },
    { name: HCLOUD_ENDPOINT_ENV, required: false },
  ],
});

/**
 * Layer that registers the Hetzner {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * Auth is a Hetzner Cloud API token (`HCLOUD_TOKEN`). An optional
 * `HCLOUD_ENDPOINT` overrides the API root.
 */
export const HetznerAuth = hetznerAuth.layer;
