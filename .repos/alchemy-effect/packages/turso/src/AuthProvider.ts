import { DEFAULT_API_BASE_URL } from "@distilled.cloud/turso/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Turso AuthProvider from inside provider Layers.
 */
export const TURSO_AUTH_PROVIDER_NAME = "Turso";

export type TursoAuthConfig = StoredAuthConfig;

/**
 * Resolved Turso Platform API credentials.
 *
 * Turso has no OAuth application flow — the Platform API authenticates
 * with API tokens only (`turso auth api-tokens mint <name>`). The
 * organization is optional: when omitted it is discovered from the token
 * (an organization-scoped token, or an account with a single organization).
 */
export interface TursoResolvedCredentials {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  organization: string | undefined;
  source: { type: TursoAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiToken = yield* getEnvRedacted("TURSO_API_TOKEN");
  const apiKey = yield* getEnvRedacted("TURSO_API_KEY");
  const token = apiToken ?? apiKey;
  if (token === undefined || Redacted.value(token).trim().length === 0) {
    return yield* AuthError.make({
      message: "Turso CI credentials not found. Set TURSO_API_TOKEN or TURSO_API_KEY.",
    });
  }
  return {
    type: "apiToken" as const,
    apiToken: Redacted.make(Redacted.value(token).trim()),
    apiBaseUrl: (yield* getEnv("TURSO_API_BASE_URL")) ?? DEFAULT_API_BASE_URL,
    organization: yield* getEnv("TURSO_ORGANIZATION"),
    source: {
      type: "env" as const,
      details: apiToken === undefined ? "TURSO_API_KEY" : "TURSO_API_TOKEN",
    },
  } satisfies TursoResolvedCredentials;
});

const tursoAuth = makeStoredAuthProvider<TursoResolvedCredentials>({
  provider: TURSO_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiToken",
      label: "Turso API Token",
      description: "Mint one with `turso auth api-tokens mint alchemy`.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "organization",
      label: "Turso Organization (slug)",
      description: "Defaults to the token's organization when it has exactly one.",
      optional: true,
    },
  ],
  toResolved: (values, source) => ({
    type: "apiToken",
    apiToken: storedSecret(values.apiToken) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    organization: storedValueText(values.organization),
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "TURSO_API_TOKEN",
      required: true,
      secret: true,
      alternatives: ["TURSO_API_KEY"],
      description: "Turso Platform API token.",
    },
    {
      name: "TURSO_ORGANIZATION",
      required: false,
      description: "Organization slug; defaults to the token's only organization.",
    },
    {
      name: "TURSO_API_BASE_URL",
      required: false,
      description: "Platform API base URL override.",
    },
  ],
});

/**
 * Layer that registers the Turso AuthProvider into the AuthProviders
 * registry when built. Included in `Turso.providers()` so the alchemy CLI
 * (`alchemy profile edit`) can configure it.
 */
export const TursoAuth = tursoAuth.layer;

/** Schema of Turso's inline API-token values. */
export const TursoStoredCredentials = tursoAuth.storedSchema;
export type TursoStoredCredentials = typeof TursoStoredCredentials.Type;
