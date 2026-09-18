import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { profileCommandHint } from "../../Util/interactive.ts";

/** Typed values stored in a Cloudflare provider profile document. */
export const CloudflareAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("stored"),
    credentialType: Schema.Literal("apiToken"),
    apiToken: Schema.String,
    accountId: Schema.String,
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    credentialType: Schema.Literal("apiKey"),
    apiKey: Schema.String,
    email: Schema.String,
    accountId: Schema.String,
  }),
  Schema.Struct({
    method: Schema.Literal("oauth"),
    scopes: Schema.mutable(Schema.Array(Schema.String)),
    accountId: Schema.String,
    clientId: Schema.optional(Schema.String),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
  }),
  // Released v0 OAuth grants cannot be reused, but retaining the method lets
  // `profile refresh` restart OAuth at scope selection.
  Schema.Struct({
    method: Schema.Literal("oauth"),
  }),
]);
export type CloudflareAuthConfig = typeof CloudflareAuthConfigSchema.Type;

export type CloudflareResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "apiKey";
      apiKey: Redacted.Redacted<string>;
      email: Redacted.Redacted<string>;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    };

export const CLOUDFLARE_AUTH_PROVIDER_NAME = "Cloudflare";

/**
 * Cloudflare account IDs are 32 lowercase hex characters. Placeholder
 * values ("", "-", "dummy", …) end up interpolated into API paths and
 * surface as baffling `InvalidRoute: Could not route to
 * /accounts/<value>/...` errors, so reject them up front with an
 * actionable message instead.
 */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

export const validateAccountId = (
  accountId: string | undefined,
  source: string,
): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const trimmed = accountId?.trim() ?? "";
    const command = yield* profileCommandHint(
      "alchemy profile edit --reconfigure Cloudflare",
    );
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Cloudflare account ID is missing (${source}). ` +
            `Re-run \`${command}\` and provide your account ID ` +
            "(found in the Cloudflare dashboard under Workers & Pages → Account details).",
        }),
      );
    }
    if (!ACCOUNT_ID_PATTERN.test(trimmed)) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `'${trimmed}' is not a valid Cloudflare account ID (${source}) — expected 32 hex characters. ` +
            "Copy the account ID from the Cloudflare dashboard (Workers & Pages → Account details) " +
            `and re-run \`${command}\`.`,
        }),
      );
    }
    return trimmed.toLowerCase();
  });

/** Field-level validator reusing {@link ACCOUNT_ID_PATTERN}. */
export const validateAccountIdField = (v: string): string | undefined =>
  ACCOUNT_ID_PATTERN.test(v.trim())
    ? undefined
    : "Expected a 32-character hex account ID (Workers & Pages → Account details)";
