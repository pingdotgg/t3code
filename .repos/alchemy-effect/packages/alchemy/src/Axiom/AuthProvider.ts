import { DEFAULT_API_BASE_URL } from "@distilled.cloud/axiom/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const AXIOM_AUTH_PROVIDER_NAME = "Axiom";

export type AxiomAuthConfig = StoredAuthConfig;

/**
 * Resolved Axiom credentials. The provider values are a flat record
 * (token + optional orgId/apiBaseUrl); the `apiToken`/`pat` distinction is
 * derived at resolution time from orgId presence — an org id means the token
 * is treated as a personal access token, mirroring how the CI environment
 * resolution has always classified `AXIOM_ORG_ID`.
 */
export type AxiomResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      apiBaseUrl: string;
      orgId?: string;
      source: { type: AxiomAuthConfig["method"] | "env"; details?: string };
    }
  | {
      type: "pat";
      apiToken: Redacted.Redacted<string>;
      apiBaseUrl: string;
      orgId: string;
      source: { type: AxiomAuthConfig["method"] | "env"; details?: string };
    };

const readEnvironment = Effect.gen(function* () {
  const apiToken =
    (yield* getEnvRedacted("AXIOM_TOKEN")) ??
    (yield* getEnvRedacted("AXIOM_API_KEY"));
  if (!apiToken) {
    return yield* new AuthError({
      message:
        "Axiom CI credentials not found. Set AXIOM_TOKEN or AXIOM_API_KEY.",
    });
  }
  const apiBaseUrl = (yield* getEnv("AXIOM_URL")) ?? DEFAULT_API_BASE_URL;
  const orgId = yield* getEnv("AXIOM_ORG_ID");
  return orgId
    ? {
        type: "pat" as const,
        apiToken,
        apiBaseUrl,
        orgId,
        source: { type: "env" as const },
      }
    : {
        type: "apiToken" as const,
        apiToken,
        apiBaseUrl,
        source: { type: "env" as const },
      };
});

const axiomAuth = makeStoredAuthProvider<AxiomResolvedCredentials>({
  provider: AXIOM_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "token",
      label: "Axiom API Token or Personal Access Token",
      secret: true,
    },
    {
      name: "orgId",
      label: "Axiom Org ID (required for personal access tokens)",
      optional: true,
    },
    {
      name: "apiBaseUrl",
      label: "Axiom API Base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => {
    const apiToken = storedSecret(values.token) ?? Redacted.make("");
    const apiBaseUrl =
      storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL;
    return values.orgId !== undefined
      ? {
          type: "pat",
          apiToken,
          apiBaseUrl,
          orgId: storedValueText(values.orgId) ?? "",
          source: { type: source },
        }
      : {
          type: "apiToken",
          apiToken,
          apiBaseUrl,
          source: { type: source },
        };
  },
  readEnvironment,
  environment: [
    {
      name: "AXIOM_TOKEN",
      required: true,
      secret: true,
      alternatives: ["AXIOM_API_KEY"],
      description: "Personal access token or API token.",
    },
    {
      name: "AXIOM_URL",
      required: false,
      description: "API base URL for self-hosted or regional deployments.",
    },
    {
      name: "AXIOM_ORG_ID",
      required: false,
      description:
        "Organization id; required when the token is a personal access token.",
    },
  ],
});

/**
 * Layer that registers the Axiom {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Axiom
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const AxiomAuth = axiomAuth.layer;

/** Schema of Axiom's inline static-token values. */
export const AxiomStoredCredentials = axiomAuth.storedSchema;
export type AxiomStoredCredentials = typeof AxiomStoredCredentials.Type;
