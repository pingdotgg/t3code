import * as tokenValidation from "@distilled.cloud/cloudflare/token-validation";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.TokenValidation.Configuration" as const;
type TypeId = typeof TypeId;

/**
 * A JSON Web Key (JWK) in a token configuration's key set. These are public
 * keys (the public half of a JWKS), not secrets.
 */
export type JwkKey =
  | {
      /** Key type — RSA. */
      kty: "RSA";
      /** RSA signing algorithm the key is used with. */
      alg: "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512";
      /** Key ID — must match the `kid` header of incoming JWTs. */
      kid: string;
      /** RSA modulus (base64url). */
      n: string;
      /** RSA public exponent (base64url). */
      e: string;
    }
  | {
      /** Key type — elliptic curve. */
      kty: "EC";
      /** ECDSA P-256 signing algorithm. */
      alg: "ES256";
      /** Curve — P-256. */
      crv: "P-256";
      /** Key ID — must match the `kid` header of incoming JWTs. */
      kid: string;
      /** EC x coordinate (base64url). */
      x: string;
      /** EC y coordinate (base64url). */
      y: string;
    }
  | {
      /** Key type — elliptic curve. */
      kty: "EC";
      /** ECDSA P-384 signing algorithm. */
      alg: "ES384";
      /** Curve — P-384. */
      crv: "P-384";
      /** Key ID — must match the `kid` header of incoming JWTs. */
      kid: string;
      /** EC x coordinate (base64url). */
      x: string;
      /** EC y coordinate (base64url). */
      y: string;
    };

export interface TokenConfigurationProps {
  /**
   * Zone the token configuration belongs to.
   *
   * Stable — moving a configuration between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Human-readable name for the configuration. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
  /**
   * A description that gives more details than `title`.
   * @default ""
   */
  description?: string;
  /**
   * Where to look for the token on incoming requests, as firewall fields —
   * e.g. `http.request.headers["authorization"][0]`.
   */
  tokenSources: string[];
  /**
   * The JWKS key set used to validate token signatures. Replacing entries
   * rotates the key set in place via the credentials endpoint.
   */
  keys: JwkKey[];
  /**
   * The token format. Only JWT is supported today. Cannot be changed after
   * creation — updating this property triggers a replacement.
   * @default "JWT"
   */
  tokenType?: "JWT";
}

export interface TokenConfigurationAttributes {
  /** Cloudflare-assigned UUID of the token configuration. */
  configId: string;
  /** Zone the configuration belongs to. */
  zoneId: string;
  /** Human-readable name of the configuration. */
  title: string;
  /** Description of the configuration. */
  description: string;
  /** Where the token is looked for on incoming requests. */
  tokenSources: string[];
  /** The token format. */
  tokenType: "JWT";
  /** The JWKS key set currently active on the configuration. */
  keys: JwkKey[];
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp. */
  lastUpdated: string;
}

export type TokenConfiguration = Resource<
  TypeId,
  TokenConfigurationProps,
  TokenConfigurationAttributes,
  never,
  Providers
>;

/**
 * An API Shield JWT validation token configuration — the JWKS key material
 * and token source locations used to validate JSON Web Tokens on a zone.
 *
 * A configuration holds a set of public JWKs (`keys`) plus the request
 * fields where the token is found (`tokenSources`). Rules
 * ({@link Rule}) then reference the configuration by UUID in
 * their expression (e.g. `is_jwt_valid("<configId>")`) to enforce
 * validation on selected hosts/operations.
 *
 * JWT validation is an API Shield feature (Enterprise add-on) — accounts
 * without the entitlement receive the typed `TokenValidationNotEntitled`
 * error (Cloudflare code 10403) on every call.
 *
 * Title, description, and token sources are patched in place; the key set
 * is rotated in place via the credentials endpoint. Only `zoneId` and
 * `tokenType` force a replacement.
 * @resource
 * @product Token Validation
 * @category Application Security
 * @section Creating a Configuration
 * @example JWT configuration with an RSA key
 * ```typescript
 * const config = yield* Cloudflare.TokenValidation.TokenConfiguration("ApiJwt", {
 *   zoneId: zone.zoneId,
 *   tokenSources: ['http.request.headers["authorization"][0]'],
 *   keys: [
 *     {
 *       kty: "RSA",
 *       alg: "RS256",
 *       kid: "key-2026-01",
 *       n: "<base64url modulus>",
 *       e: "AQAB",
 *     },
 *   ],
 * });
 * ```
 *
 * @section Rotating Keys
 * @example Replace the key set in place
 * ```typescript
 * // Changing `keys` PUTs the full key set to the credentials endpoint —
 * // the configuration (and its UUID) stays in place.
 * const config = yield* Cloudflare.TokenValidation.TokenConfiguration("ApiJwt", {
 *   zoneId: zone.zoneId,
 *   tokenSources: ['http.request.headers["authorization"][0]'],
 *   keys: [oldKey, newKey],
 * });
 * ```
 *
 * @section Enforcing Validation
 * @example Reference the configuration from a rule
 * ```typescript
 * yield* Cloudflare.TokenValidation.Rule("RequireJwt", {
 *   zoneId: zone.zoneId,
 *   action: "block",
 *   expression: Output.interpolate`is_jwt_valid("${config.configId}")`,
 *   selector: { include: [{ host: ["api.example.com"] }] },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/security/jwt-validation/
 */
export const TokenConfiguration = Resource<TokenConfiguration>(TypeId);

/**
 * Returns true if the given value is a TokenConfiguration resource.
 */
export const isTokenConfiguration = (
  value: unknown,
): value is TokenConfiguration =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const TokenConfigurationProvider = () =>
  Provider.succeed(TokenConfiguration, {
    stables: ["configId", "zoneId", "tokenType", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Configurations are zone-scoped; the list op is keyed per zone.
      // Enumerate every zone, fan out the per-zone list, and flatten.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          tokenValidation.listConfigurations.items({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((c) => toAttributes(c, zone.id)),
            ),
            // JWT validation is entitlement-gated and freshly minted tokens
            // can briefly 403 — skip zones we can't enumerate.
            Effect.catchTag(["TokenValidationNotEntitled", "Forbidden"], () =>
              Effect.succeed([]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Moving between zones replaces the configuration.
      const oldZoneId = output?.zoneId ?? olds?.zoneId;
      if (typeof oldZoneId === "string" && oldZoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      // tokenType is not patchable (and "JWT" is the only value today).
      const oldType = output?.tokenType ?? olds?.tokenType ?? "JWT";
      if ((news.tokenType ?? "JWT") !== oldType) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by our persisted UUID.
      if (output?.configId) {
        const observed = yield* getConfiguration(zoneId, output.configId);
        if (observed) return toAttributes(observed, zoneId);
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical title. Configurations carry no ownership markers, so an
      // existing match is reported as `Unowned` and the engine gates
      // takeover behind the adopt policy.
      const title = yield* createConfigurationTitle(id, olds?.title);
      const match = yield* findByTitle(zoneId, title);
      if (match) return Unowned(toAttributes(match, zoneId));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete values by Plan.
      const zoneId = news.zoneId as string;
      const title = yield* createConfigurationTitle(id, news.title);

      // 1. Observe — the UUID cached on `output` is a hint, not a
      //    guarantee: a 404 falls through to "missing" and we recreate.
      let observed = output?.configId
        ? yield* getConfiguration(zoneId, output.configId)
        : undefined;

      // 2. Ensure — greenfield (or out-of-band delete): create with the
      //    full desired body. Titles are not unique on Cloudflare's side,
      //    so there is no AlreadyExists race to tolerate.
      if (!observed) {
        observed = yield* tokenValidation.createConfiguration({
          zoneId,
          title,
          description: news.description ?? "",
          tokenSources: news.tokenSources,
          tokenType: news.tokenType ?? "JWT",
          credentials: { keys: news.keys },
        });
        return toAttributes(observed, zoneId);
      }

      // 3. Sync metadata — diff observed title/description/tokenSources
      //    against desired; PATCH only the delta, skip on no-op.
      const desiredDescription = news.description ?? "";
      const metadataDirty =
        observed.title !== title ||
        observed.description !== desiredDescription ||
        !sameStrings(observed.tokenSources, news.tokenSources);
      if (metadataDirty) {
        yield* tokenValidation.patchConfiguration({
          zoneId,
          configId: observed.id,
          title,
          description: desiredDescription,
          tokenSources: news.tokenSources,
        });
      }

      // 4. Sync key set — compare the observed JWKS against the desired
      //    one by full key material; PUT the full set on any difference
      //    (the credentials endpoint replaces the whole key set).
      if (!sameKeys(observed.credentials.keys, news.keys)) {
        yield* tokenValidation.putConfigurationCredential({
          zoneId,
          configId: observed.id,
          keys: news.keys,
        });
      }

      // 5. Return — re-read so attributes reflect the final cloud state.
      const final = yield* getConfiguration(zoneId, observed.id);
      return toAttributes(final ?? observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare may answer DELETE for an already-gone configuration with
      // `result: null`, which the typed response decode rejects — observe
      // first and treat missing as done.
      const observed = yield* getConfiguration(output.zoneId, output.configId);
      if (!observed) return;
      yield* tokenValidation
        .deleteConfiguration({
          zoneId: output.zoneId,
          configId: output.configId,
        })
        .pipe(Effect.catchTag("TokenConfigurationNotFound", () => Effect.void));
    }),
  });

type ObservedConfiguration = tokenValidation.GetConfigurationResponse;

/**
 * Read a configuration by UUID, mapping "gone"
 * (`TokenConfigurationNotFound`, HTTP 404) to `undefined`.
 */
const getConfiguration = (zoneId: string, configId: string) =>
  tokenValidation.getConfiguration({ zoneId, configId }).pipe(
    Effect.map((c): ObservedConfiguration | undefined => c),
    Effect.catchTag("TokenConfigurationNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a configuration by exact title. Titles are not unique on
 * Cloudflare's side; if several match, pick the oldest for determinism.
 */
const findByTitle = (zoneId: string, title: string) =>
  tokenValidation.listConfigurations.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((c) => c.title === title)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(0),
    ),
  );

const createConfigurationTitle = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    return title ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const sameStrings = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(" ") === [...desired].sort().join(" ");

const keyIdentity = (key: JwkKey) =>
  key.kty === "RSA"
    ? `RSA:${key.alg}:${key.kid}:${key.n}:${key.e}`
    : `EC:${key.alg}:${key.crv}:${key.kid}:${key.x}:${key.y}`;

const sameKeys = (
  observed: ObservedConfiguration["credentials"]["keys"],
  desired: readonly JwkKey[],
) => {
  const observedIds = observed.map((key) => keyIdentity(key as JwkKey)).sort();
  const desiredIds = desired.map(keyIdentity).sort();
  return (
    observedIds.length === desiredIds.length &&
    observedIds.join(" ") === desiredIds.join(" ")
  );
};

const toAttributes = (
  configuration: ObservedConfiguration,
  zoneId: string,
): TokenConfigurationAttributes => ({
  configId: configuration.id,
  zoneId,
  title: configuration.title,
  description: configuration.description,
  tokenSources: [...configuration.tokenSources],
  tokenType: configuration.tokenType,
  // Distilled widens the RSA `alg` enum to an open union (`string & {}`).
  keys: configuration.credentials.keys.map((key) => ({ ...key }) as JwkKey),
  createdAt: configuration.createdAt,
  lastUpdated: configuration.lastUpdated,
});
