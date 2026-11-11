/**
 * Provider-specific rules for migrating the released v0 profile store: one
 * central `profiles.json` with each provider's saved credentials in a
 * `credentials/<name>.json` sidecar. `ProfileStore` runs the migration once
 * and moves the original files into a `.profiles-v0-*` backup.
 *
 * This is a frozen snapshot of the v0 layout, not provider configuration:
 * the migration runs before any provider package is loaded and rewrites the
 * whole store, so every provider's old filenames must be known here. Delete
 * this module once v0 stores no longer need to roll forward.
 */
import * as Schema from "effect/Schema";
import type { ProviderConfig } from "./Profile.ts";

/** The v0 central manifest. */
export const V0ManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.Literal(0),
    profiles: Schema.Record(Schema.String, Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Each provider's v0 sidecar name, by its `method` where it had several. */
const SIDECARS: Record<string, string | Record<string, string>> = {
  AWS: "aws-stored",
  Axiom: "axiom-stored",
  Cloudflare: "cloudflare-stored",
  Fly: "fly-stored",
  GitHub: "github-stored",
  Hetzner: "hetzner-stored",
  Neon: "neon-stored",
  Planetscale: {
    stored: "planetscale-stored",
    oauth: "planetscale-oauth",
  },
  Prisma: "prisma-stored",
  Railway: {
    stored: "railway-stored",
    oauth: "railway-oauth",
  },
};

/** The earliest sidecars used shorter names. */
const EARLIEST_SIDECARS: Record<string, string> = {
  Cloudflare: "cf-stored",
  GitHub: "gh-stored",
};

/**
 * How to migrate one provider's v0 values: keep them as they are
 * (`Inline`), or fold in the first sidecar found among `candidates`
 * (sidecar names without `.json`), using `fallback` when none is readable.
 */
export type SidecarPlan =
  | { readonly _tag: "Inline"; readonly values: ProviderConfig }
  | {
      readonly _tag: "Sidecar";
      readonly candidates: ReadonlyArray<string>;
      readonly fallback: ProviderConfig;
    };

export const planSidecar = (provider: string, values: ProviderConfig): SidecarPlan => {
  // Cloudflare's released OAuth grant is obsolete, but its stored API token
  // and global API key formats still map exactly to the new provider-owned
  // values schema.
  if (provider === "Cloudflare" && values.method !== "stored") {
    return { _tag: "Inline", values: { method: "oauth" } };
  }
  const configured = SIDECARS[provider];
  const sidecar =
    typeof configured === "string"
      ? configured
      : values.method === undefined
        ? undefined
        : configured?.[values.method];
  if (sidecar === undefined) return { _tag: "Inline", values };
  const earliest = EARLIEST_SIDECARS[provider];
  return {
    _tag: "Sidecar",
    candidates: earliest === undefined ? [sidecar] : [sidecar, earliest],
    // A Cloudflare entry is only usable with its sidecar's credentials.
    fallback: provider === "Cloudflare" ? {} : values,
  };
};

/** Fold a decoded sidecar into the provider's v0 manifest values. */
export const mergeSidecar = (
  provider: string,
  values: ProviderConfig,
  sidecar: ProviderConfig,
): ProviderConfig => {
  const { type: _type, ...inline } = sidecar;
  const normalizedInline =
    provider === "Axiom" && inline.apiToken !== undefined
      ? (({ apiToken, ...rest }) => ({ ...rest, token: apiToken }))(inline)
      : inline;
  const { storageKey: _storageKey, ...manifestValues } = values;
  const migrated: ProviderConfig = {
    ...manifestValues,
    ...normalizedInline,
  };
  if (provider !== "Cloudflare") return migrated;
  return migrated.credentialType === "apiKey" &&
    typeof migrated.apiKey === "string" &&
    typeof migrated.email === "string" &&
    typeof migrated.accountId === "string"
    ? migrated
    : migrated.credentialType === "apiToken" &&
        typeof migrated.apiToken === "string" &&
        typeof migrated.accountId === "string"
      ? migrated
      : {};
};

/**
 * Values to write for a provider whose v0 entry can't be decoded, or
 * `undefined` to skip it (it stays in the v0 backup). Cloudflare gets an
 * empty profile so `alchemy login` prompts for fresh credentials.
 */
export const undecodableValues = (provider: string): ProviderConfig | undefined =>
  provider === "Cloudflare" ? {} : undefined;
