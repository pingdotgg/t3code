import * as securityTxt from "@distilled.cloud/cloudflare/security-txt";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.SecurityTxt.SecurityTxt" as const;
type TypeId = typeof TypeId;

export type Props = {
  /**
   * Zone the security.txt file belongs to. Stable — changing the zone
   * triggers a replacement (the old zone's security.txt is deleted and a
   * new one is created on the new zone).
   */
  zoneId: string;
  /**
   * Whether the security.txt file is served at
   * `/.well-known/security.txt` on the zone. Mutable.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Contact channels for security researchers — `mailto:` addresses,
   * `tel:` numbers, or HTTPS URLs (RFC 9116 `Contact` field). Required —
   * Cloudflare rejects a security.txt without it. Mutable.
   */
  contact: string[];
  /**
   * RFC 3339 timestamp after which the file's content should be
   * considered stale (RFC 9116 `Expires` field), e.g.
   * `2027-01-01T00:00:00Z`. Required — Cloudflare rejects a security.txt
   * without it. Mutable.
   */
  expires: string;
  /**
   * URLs of pages crediting security researchers (RFC 9116
   * `Acknowledgments` field). Mutable.
   */
  acknowledgments?: string[];
  /**
   * Canonical URLs where this security.txt file is served (RFC 9116
   * `Canonical` field). Mutable.
   */
  canonical?: string[];
  /**
   * URLs of encryption keys for secure communication (RFC 9116
   * `Encryption` field). Mutable.
   */
  encryption?: string[];
  /**
   * URLs of security-related job openings (RFC 9116 `Hiring` field).
   * Mutable.
   */
  hiring?: string[];
  /**
   * URLs of the vulnerability disclosure policy (RFC 9116 `Policy`
   * field). Mutable.
   */
  policy?: string[];
  /**
   * Comma-separated list of language tags the security team prefers
   * (RFC 9116 `Preferred-Languages` field), e.g. `"en, es"`. Mutable.
   */
  preferredLanguages?: string;
};

export type Attributes = {
  /** Zone the security.txt file belongs to. */
  zoneId: string;
  /** Whether the file is served at `/.well-known/security.txt`. */
  enabled: boolean;
  /** Contact channels for security researchers. */
  contact: string[];
  /** RFC 3339 timestamp after which the file is considered stale. */
  expires: string;
  /** URLs of pages crediting security researchers. */
  acknowledgments: string[] | undefined;
  /** Canonical URLs where this security.txt file is served. */
  canonical: string[] | undefined;
  /** URLs of encryption keys for secure communication. */
  encryption: string[] | undefined;
  /** URLs of security-related job openings. */
  hiring: string[] | undefined;
  /** URLs of the vulnerability disclosure policy. */
  policy: string[] | undefined;
  /** Comma-separated list of preferred language tags. */
  preferredLanguages: string | undefined;
};

export type SecurityTxt = Resource<TypeId, Props, Attributes, never, Providers>;

/**
 * A zone's `security.txt` file
 * (`/zones/{zone_id}/security-center/securitytxt`), served by the
 * Cloudflare edge at `https://<zone>/.well-known/security.txt` per
 * RFC 9116 so security researchers know how to report vulnerabilities.
 *
 * The file is a singleton per zone with true create/delete semantics:
 * creating the resource publishes the file, updating it is a full
 * replace of every field, and destroying it removes the file from the
 * zone entirely.
 *
 * Cloudflare requires the RFC 9116 mandatory fields — `contact` and
 * `expires` — on every write.
 * @resource
 * @product Security.txt
 * @category Application Security
 * @section Publishing a security.txt
 * @example Minimal security.txt
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
 *   zoneId: zone.zoneId,
 *   contact: ["mailto:security@example.com"],
 *   expires: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * @example Full security.txt with policy and acknowledgments
 * ```typescript
 * yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
 *   zoneId: zone.zoneId,
 *   contact: ["mailto:security@example.com", "https://example.com/report"],
 *   expires: "2027-01-01T00:00:00Z",
 *   policy: ["https://example.com/security-policy"],
 *   acknowledgments: ["https://example.com/hall-of-fame"],
 *   encryption: ["https://example.com/pgp-key.txt"],
 *   preferredLanguages: "en, es",
 * });
 * ```
 *
 * @section Pausing without deleting
 * @example Keep the configuration but stop serving the file
 * ```typescript
 * yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 *   contact: ["mailto:security@example.com"],
 *   expires: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/security-center/infrastructure/security-file/
 */
export const SecurityTxt = Resource<SecurityTxt>(TypeId, {
  aliases: ["Cloudflare.SecurityTxt"],
});

/**
 * Returns true if the given value is a SecurityTxt resource.
 */
export const isSecurityTxt = (value: unknown): value is SecurityTxt =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SecurityTxtProvider = () =>
  Provider.succeed(SecurityTxt, {
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // There is no account-wide API for this per-zone singleton, and the
      // file is only present on zones that have explicitly configured it —
      // enumerate every zone, read its security.txt, and emit one entry per
      // configured zone (an empty-string sentinel means unconfigured, which
      // `read` treats as absent, so skip it).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          securityTxt
            .getSecurityTxt({ zoneId })
            .pipe(
              Effect.map((observed) =>
                typeof observed === "string"
                  ? undefined
                  : toAttributes(zoneId, observed),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is Attributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Props;
      const n = news as Props;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* securityTxt.getSecurityTxt({ zoneId });
      // An unconfigured zone returns an empty-string sentinel — absent.
      if (typeof observed === "string") return undefined;
      const attrs = toAttributes(zoneId, observed);
      // The file is a zone singleton with no ownership markers. On a cold
      // read (no prior output) an existing file was configured outside
      // Alchemy — brand it `Unowned` so the engine refuses to take over
      // unless `--adopt` is set.
      if (output === undefined) return Unowned(attrs);
      return attrs;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired = desiredAttributes(zoneId, news);

      // 1. Observe — read the live file (an empty-string sentinel means
      //    the zone has no security.txt yet).
      const observed = yield* securityTxt.getSecurityTxt({ zoneId });

      // 2. Sync — PUT is a full replace (a true upsert), so create and
      //    update are the same call. Skip the API entirely when the
      //    observed file already matches the desired one.
      if (
        typeof observed !== "string" &&
        attributesEqual(toAttributes(zoneId, observed), desired)
      ) {
        return toAttributes(zoneId, observed);
      }
      yield* securityTxt.putSecurityTxt({
        zoneId,
        enabled: desired.enabled,
        contact: desired.contact,
        expires: desired.expires,
        acknowledgments: desired.acknowledgments,
        canonical: desired.canonical,
        encryption: desired.encryption,
        hiring: desired.hiring,
        policy: desired.policy,
        preferredLanguages: desired.preferredLanguages,
      });

      // 3. Return — re-read so attributes reflect what Cloudflare stored.
      const final = yield* securityTxt.getSecurityTxt({ zoneId });
      return typeof final === "string" ? desired : toAttributes(zoneId, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DELETE on an already-absent security.txt returns success, so the
      // operation is naturally idempotent.
      yield* securityTxt.deleteSecurityTxt({ zoneId: output.zoneId });
    }),
  });

/** Normalize the desired state from input props into the Attributes shape. */
const desiredAttributes = (zoneId: string, news: Props): Attributes => ({
  zoneId,
  enabled: news.enabled ?? true,
  contact: [...news.contact],
  expires: news.expires,
  acknowledgments: nonEmpty(news.acknowledgments),
  canonical: nonEmpty(news.canonical),
  encryption: nonEmpty(news.encryption),
  hiring: nonEmpty(news.hiring),
  policy: nonEmpty(news.policy),
  preferredLanguages:
    news.preferredLanguages === "" ? undefined : news.preferredLanguages,
});

/** Normalize the observed GET response into the Attributes shape. */
const toAttributes = (
  zoneId: string,
  observed: Exclude<securityTxt.GetSecurityTxtResponse, string>,
): Attributes => ({
  zoneId,
  enabled: observed.enabled ?? false,
  contact: [...(observed.contact ?? [])],
  expires: observed.expires ?? "",
  acknowledgments: nonEmpty(observed.acknowledgments),
  canonical: nonEmpty(observed.canonical),
  encryption: nonEmpty(observed.encryption),
  hiring: nonEmpty(observed.hiring),
  // Cloudflare echoes an empty string for an unset Preferred-Languages.
  policy: nonEmpty(observed.policy),
  preferredLanguages:
    observed.preferredLanguages === ""
      ? undefined
      : (observed.preferredLanguages ?? undefined),
});

/** Null/empty list fields normalize to `undefined` (not configured). */
const nonEmpty = (
  values: readonly string[] | null | undefined,
): string[] | undefined =>
  values === null || values === undefined || values.length === 0
    ? undefined
    : [...values];

const listEquals = (
  a: string[] | undefined,
  b: string[] | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

const attributesEqual = (a: Attributes, b: Attributes): boolean =>
  a.zoneId === b.zoneId &&
  a.enabled === b.enabled &&
  a.expires === b.expires &&
  a.preferredLanguages === b.preferredLanguages &&
  listEquals(a.contact, b.contact) &&
  listEquals(a.acknowledgments, b.acknowledgments) &&
  listEquals(a.canonical, b.canonical) &&
  listEquals(a.encryption, b.encryption) &&
  listEquals(a.hiring, b.hiring) &&
  listEquals(a.policy, b.policy);
