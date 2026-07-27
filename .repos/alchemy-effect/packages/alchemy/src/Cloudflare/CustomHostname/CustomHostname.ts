import * as customHostnames from "@distilled.cloud/cloudflare/custom-hostnames";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

/**
 * Domain control validation (DCV) method used to prove control over the
 * custom hostname before a certificate is issued.
 */
export type DcvMethod = "http" | "txt" | "email";

/**
 * Certificate authority that issues the managed certificate.
 */
export type CertificateAuthority =
  | "digicert"
  | "google"
  | "lets_encrypt"
  | "ssl_com";

/**
 * Per-hostname TLS settings applied to the edge certificate.
 */
export type SslSettings = {
  /** Allowed cipher suites. */
  ciphers?: string[];
  /** Whether Early Hints (HTTP 103) is enabled. */
  earlyHints?: "on" | "off";
  /** Whether HTTP/2 is enabled. */
  http2?: "on" | "off";
  /** Minimum TLS version served for this hostname. */
  minTlsVersion?: "1.0" | "1.1" | "1.2" | "1.3";
  /** Whether TLS 1.3 is enabled. */
  tls_1_3?: "on" | "off";
};

/**
 * SSL configuration for a custom hostname's managed certificate.
 */
export type Ssl = {
  /**
   * Domain control validation method.
   * @default "txt"
   */
  method?: DcvMethod;
  /**
   * Level of validation for the certificate. Only domain validation
   * (`dv`) is supported.
   * @default "dv"
   */
  type?: "dv";
  /**
   * Certificate authority that issues the certificate. Omit to let
   * Cloudflare choose.
   */
  certificateAuthority?: CertificateAuthority;
  /**
   * How the intermediate chain is bundled with the leaf certificate.
   */
  bundleMethod?: "ubiquitous" | "optimal" | "force";
  /**
   * Whether to add Cloudflare branding to the certificate (adds
   * `sni.cloudflaressl.com` as the certificate common name).
   */
  cloudflareBranding?: boolean;
  /**
   * Whether the certificate also covers `*.hostname`. Toggling can
   * trigger certificate reissuance, but is still an in-place update.
   */
  wildcard?: boolean;
  /**
   * Bring-your-own leaf certificate (PEM). Requires `customKey`.
   */
  customCertificate?: string;
  /**
   * Private key (PEM) for `customCertificate`.
   */
  customKey?: string;
  /**
   * Identifier of a previously generated custom CSR.
   */
  customCsrId?: string;
  /**
   * Per-hostname TLS settings.
   */
  settings?: SslSettings;
};

export interface Props {
  /**
   * Zone the custom hostname is onboarded onto (the SaaS zone). Stable —
   * changing the zone triggers replacement.
   */
  zoneId: string;
  /**
   * The customer-owned hostname that will point at your zone via CNAME
   * (e.g. `app.customer.com`).
   *
   * Stable — the hostname is the resource's identity and is not
   * patchable; a rename is a delete + create. Declared as plain `string`
   * (not `string`) so it is statically knowable inside `diff`.
   */
  hostname: string;
  /**
   * SSL configuration for the managed certificate. Mutable — patched in
   * place (note that changing `ssl` can trigger certificate
   * reissuance).
   *
   * @default { method: "txt", type: "dv" }
   */
  ssl?: Ssl;
  /**
   * Unique key/value metadata for this hostname, available to Workers
   * via the request. Requires the Enterprise Cloudflare for SaaS
   * entitlement — the API rejects it otherwise.
   */
  customMetadata?: Record<string, unknown>;
  /**
   * Origin server to route traffic for this hostname to, overriding the
   * zone's fallback origin. Must be a DNS record within the zone.
   * Requires the Enterprise Cloudflare for SaaS entitlement.
   */
  customOriginServer?: string;
  /**
   * SNI value sent to `customOriginServer` during the TLS handshake, or
   * the literal `:request_host_header:`. Requires the Enterprise
   * Cloudflare for SaaS entitlement.
   */
  customOriginSni?: string;
}

/**
 * TXT record the customer must create to prove ownership of the
 * hostname (pre-validation).
 */
export interface OwnershipVerification {
  /** TXT record name. */
  name: string | undefined;
  /** Record type (always `txt`). */
  type: string | undefined;
  /** TXT record value. */
  value: string | undefined;
}

/**
 * HTTP token alternative for ownership verification.
 */
export interface OwnershipVerificationHttp {
  /** URL the token must be served from. */
  httpUrl: string | undefined;
  /** Token body to serve. */
  httpBody: string | undefined;
}

/**
 * A DCV record the customer must create/serve for certificate
 * validation.
 */
export interface ValidationRecord {
  /** CNAME validation record name. */
  cname: string | undefined;
  /** CNAME validation record target. */
  cnameTarget: string | undefined;
  /** Email addresses validation mail is sent to. */
  emails: string[] | undefined;
  /** HTTP validation token body. */
  httpBody: string | undefined;
  /** HTTP validation token URL. */
  httpUrl: string | undefined;
  /** Validation record status. */
  status: string | undefined;
  /** TXT validation record name. */
  txtName: string | undefined;
  /** TXT validation record value. */
  txtValue: string | undefined;
}

export interface Attributes {
  /** Cloudflare-assigned custom hostname UUID. */
  customHostnameId: string;
  /** Zone that owns this custom hostname. */
  zoneId: string;
  /** The customer-owned hostname. */
  hostname: string;
  /**
   * Activation status of the hostname (`pending`, `active`, …). A
   * hostname for a domain whose DNS the customer has not pointed yet
   * stays `pending` — activation is asynchronous and not blocked on.
   */
  status: string | undefined;
  /** Certificate status (`initializing`, `pending_validation`, `active`, …). */
  sslStatus: string | undefined;
  /** TXT record the customer must create to verify ownership. */
  ownershipVerification: OwnershipVerification | undefined;
  /** HTTP token alternative for ownership verification. */
  ownershipVerificationHttp: OwnershipVerificationHttp | undefined;
  /** DCV records the customer must satisfy for certificate issuance. */
  validationRecords: ValidationRecord[] | undefined;
}

export type CustomHostname = Resource<
  "Cloudflare.CustomHostname.CustomHostname",
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A Cloudflare for SaaS custom hostname.
 *
 * Onboards a customer-owned hostname onto your zone with a managed TLS
 * certificate. The customer points their DNS (CNAME) at your zone;
 * Cloudflare validates ownership and issues a certificate
 * asynchronously. The first 100 custom hostnames are free on any plan.
 *
 * Traffic for custom hostnames is routed to the zone's
 * {@link FallbackOrigin} (or `customOriginServer` with the Enterprise
 * entitlement), so a fallback origin should usually be deployed
 * alongside.
 *
 * Safety: when there is no prior state, `read` scans the zone for an
 * existing hostname match. Custom hostnames carry no ownership markers,
 * so an existing match is reported as `Unowned` and the engine refuses
 * to take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Custom Hostnames
 * @category Domains & DNS
 * @section Creating a Custom Hostname
 * @example Basic custom hostname with TXT validation
 * ```typescript
 * const hostname = yield* Cloudflare.CustomHostname.CustomHostname("CustomerApp", {
 *   zoneId: zone.zoneId,
 *   hostname: "app.customer.com",
 * });
 * // Hand these to the customer so they can verify ownership:
 * // hostname.ownershipVerification?.name / .value
 * ```
 *
 * @example HTTP validation with a specific certificate authority
 * ```typescript
 * yield* Cloudflare.CustomHostname.CustomHostname("CustomerApp", {
 *   zoneId: zone.zoneId,
 *   hostname: "app.customer.com",
 *   ssl: {
 *     method: "http",
 *     type: "dv",
 *     certificateAuthority: "google",
 *   },
 * });
 * ```
 *
 * @section Pairing with a Fallback Origin
 * @example Route custom hostname traffic to your origin
 * ```typescript
 * const record = yield* Cloudflare.DNS.Record("Origin", {
 *   zoneId: zone.zoneId,
 *   name: "origin.my-saas.com",
 *   type: "A",
 *   content: "203.0.113.1",
 *   proxied: true,
 * });
 * yield* Cloudflare.CustomHostname.FallbackOrigin("Fallback", {
 *   zoneId: zone.zoneId,
 *   origin: record.name,
 * });
 * yield* Cloudflare.CustomHostname.CustomHostname("CustomerApp", {
 *   zoneId: zone.zoneId,
 *   hostname: "app.customer.com",
 * });
 * ```
 */
export const CustomHostname = Resource<CustomHostname>(
  "Cloudflare.CustomHostname.CustomHostname",
  { aliases: ["Cloudflare.CustomHostname"] },
);

export const isCustomHostname = (value: unknown): value is CustomHostname =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.CustomHostname.CustomHostname";

export const CustomHostnameProvider = () =>
  Provider.succeed(CustomHostname, {
    stables: ["customHostnameId", "zoneId", "hostname"],

    // Custom hostnames are a zone-scoped Cloudflare for SaaS feature. Fan out
    // over every zone in the account, exhaustively paginate each zone's custom
    // hostnames, and hydrate each into the same Attributes shape `read`
    // produces. Zones without the SaaS entitlement reject with the typed
    // `SaasQuotaNotAllocated`/`Forbidden` errors — skip them.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          customHostnames.listCustomHostnames.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map(
                  (raw): Attributes =>
                    toAttributes(narrowHostname(raw), zone.id),
                ),
              ),
            ),
            Effect.catchTag("SaasQuotaNotAllocated", () => Effect.succeed([])),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Props;
      const n = news as Props;
      if (o.hostname !== undefined && o.hostname !== n.hostname) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both sides are
      // concrete strings.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const customOriginServer = news.customOriginServer as string | undefined;
      const desiredSsl = buildSslBody(news.ssl);

      // 1. Observe by cached id first.
      let observed: ObservedHostname | undefined;
      if (output?.customHostnameId) {
        observed = yield* observeById(zoneId, output.customHostnameId);
      }

      // 2. Fall back to scanning the zone for the hostname (unique per
      //    zone). Ownership has already been verified upstream — `read`
      //    reports existing hostnames as `Unowned` and the engine gates
      //    takeover behind the adopt policy before reconcile runs.
      if (!observed) {
        observed = yield* findByHostname(zoneId, news.hostname);
      }

      // 3. Ensure. A create that races another writer (hostname already
      //    exists) is converged by re-observing; if the hostname still
      //    cannot be found the original error is re-raised.
      let justCreated = false;
      if (!observed) {
        observed = yield* customHostnames
          .createCustomHostname({
            zoneId,
            hostname: news.hostname,
            ssl: desiredSsl,
            customMetadata: news.customMetadata,
          })
          .pipe(
            Effect.map(narrowHostname),
            Effect.catch((originalError) =>
              Effect.gen(function* () {
                const existing = yield* findByHostname(
                  zoneId,
                  news.hostname,
                ).pipe(Effect.catch(() => Effect.succeed(undefined)));
                if (!existing) return yield* Effect.fail(originalError);
                return existing;
              }),
            ),
          );
        justCreated = true;
      }

      // 4. Sync — diff each mutable aspect against observed cloud state
      //    and PATCH only the delta. `ssl` is only sent when it actually
      //    differs because patching it can trigger certificate
      //    reissuance.
      const patch: {
        ssl?: ReturnType<typeof buildSslBody>;
        customMetadata?: Record<string, unknown>;
        customOriginServer?: string;
        customOriginSni?: string;
      } = {};
      if (
        !justCreated &&
        news.ssl !== undefined &&
        !sslEqualsObserved(news.ssl, observed.ssl)
      ) {
        patch.ssl = desiredSsl;
      }
      if (
        news.customMetadata !== undefined &&
        !metadataEquals(news.customMetadata, observed.customMetadata)
      ) {
        patch.customMetadata = news.customMetadata;
      }
      if (
        customOriginServer !== undefined &&
        customOriginServer !== observed.customOriginServer
      ) {
        patch.customOriginServer = customOriginServer;
      }
      if (
        news.customOriginSni !== undefined &&
        news.customOriginSni !== observed.customOriginSni
      ) {
        patch.customOriginSni = news.customOriginSni;
      }
      if (Object.keys(patch).length > 0) {
        observed = narrowHostname(
          yield* customHostnames.patchCustomHostname({
            zoneId,
            customHostnameId: observed.id,
            ...patch,
          }),
        );
      }

      // 5. Return fresh attributes.
      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* customHostnames
        .deleteCustomHostname({
          zoneId: output.zoneId,
          customHostnameId: output.customHostnameId,
        })
        .pipe(Effect.catchTag("CustomHostnameNotFound", () => Effect.void));
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // Owned path: we have persisted state (our own id) — refresh it.
      if (output?.customHostnameId) {
        const observed = yield* observeById(
          output.zoneId,
          output.customHostnameId,
        );
        if (observed) return toAttributes(observed, output.zoneId);
      }
      // Adoption path: no state of our own, but the hostname may already
      // exist on the zone. Custom hostnames carry no ownership markers we
      // can inspect, so brand any match `Unowned` — the engine refuses to
      // take over unless `adopt` is set.
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      const hostname = output?.hostname ?? olds?.hostname;
      if (zoneId && hostname) {
        const observed = yield* findByHostname(zoneId, hostname);
        if (observed) return Unowned(toAttributes(observed, zoneId));
      }
      return undefined;
    }),
  });

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

// A missing hostname is reported by the custom-hostnames API with code
// 1436 ("Custom hostname not found") on a 404 envelope — typed in the
// distilled union as `CustomHostnameNotFound`.
const observeById = (zoneId: string, customHostnameId: string) =>
  customHostnames.getCustomHostname({ zoneId, customHostnameId }).pipe(
    Effect.map(narrowHostname),
    Effect.catchTag("CustomHostnameNotFound", () => Effect.succeed(undefined)),
  );

// Locate an existing custom hostname by exact hostname. The API only
// offers a `contain` filter, so an exact client-side match is applied on
// top.
const findByHostname = (zoneId: string, hostname: string) =>
  customHostnames.listCustomHostnames
    .items({ zoneId, hostname: { contain: hostname } })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).find((h) => h.hostname === hostname),
      ),
      Effect.map((found) =>
        found === undefined ? undefined : narrowHostname(found),
      ),
    );

interface ObservedSsl {
  readonly status?: string;
  readonly method?: string;
  readonly type?: string;
  readonly wildcard?: boolean;
  readonly bundleMethod?: string;
  readonly certificateAuthority?: string;
  readonly settings?: {
    readonly ciphers?: ReadonlyArray<string>;
    readonly earlyHints?: string;
    readonly http2?: string;
    readonly minTlsVersion?: string;
    readonly tls_1_3?: string;
  };
  readonly validationRecords?: ReadonlyArray<{
    readonly cname?: string;
    readonly cnameTarget?: string;
    readonly emails?: string[];
    readonly httpBody?: string;
    readonly httpUrl?: string;
    readonly status?: string;
    readonly txtName?: string;
    readonly txtValue?: string;
  }>;
}

interface ObservedHostname {
  readonly id: string;
  readonly hostname: string;
  readonly status?: string;
  readonly customMetadata?: Record<string, unknown>;
  readonly customOriginServer?: string;
  readonly customOriginSni?: string;
  readonly ownershipVerification?: {
    readonly name?: string;
    readonly type?: string;
    readonly value?: string;
  };
  readonly ownershipVerificationHttp?: {
    readonly httpBody?: string;
    readonly httpUrl?: string;
  };
  readonly ssl?: ObservedSsl;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

type RawHostname =
  | customHostnames.GetCustomHostnameResponse
  | customHostnames.CreateCustomHostnameResponse
  | customHostnames.PatchCustomHostnameResponse
  | customHostnames.ListCustomHostnamesResponse["result"][number];

const narrowHostname = (raw: RawHostname): ObservedHostname => ({
  id: raw.id,
  hostname: raw.hostname,
  status: undef(raw.status),
  customMetadata: undef(raw.customMetadata),
  customOriginServer: undef(raw.customOriginServer),
  customOriginSni: undef(raw.customOriginSni),
  ownershipVerification:
    raw.ownershipVerification == null
      ? undefined
      : {
          name: undef(raw.ownershipVerification.name),
          type: undef(raw.ownershipVerification.type),
          value: undef(raw.ownershipVerification.value),
        },
  ownershipVerificationHttp:
    raw.ownershipVerificationHttp == null
      ? undefined
      : {
          httpBody: undef(raw.ownershipVerificationHttp.httpBody),
          httpUrl: undef(raw.ownershipVerificationHttp.httpUrl),
        },
  ssl:
    raw.ssl == null
      ? undefined
      : {
          status: undef(raw.ssl.status),
          method: undef(raw.ssl.method),
          type: undef(raw.ssl.type),
          wildcard: undef(raw.ssl.wildcard),
          bundleMethod: undef(raw.ssl.bundleMethod),
          certificateAuthority: undef(raw.ssl.certificateAuthority),
          settings:
            raw.ssl.settings == null
              ? undefined
              : {
                  ciphers: undef(raw.ssl.settings.ciphers),
                  earlyHints: undef(raw.ssl.settings.earlyHints),
                  http2: undef(raw.ssl.settings.http2),
                  minTlsVersion: undef(raw.ssl.settings.minTlsVersion),
                  tls_1_3: undef(raw.ssl.settings.tls_1_3),
                },
          validationRecords:
            raw.ssl.validationRecords == null
              ? undefined
              : raw.ssl.validationRecords.map((r) => ({
                  cname: undef(r.cname),
                  cnameTarget: undef(r.cnameTarget),
                  emails: undef(r.emails),
                  httpBody: undef(r.httpBody),
                  httpUrl: undef(r.httpUrl),
                  status: undef(r.status),
                  txtName: undef(r.txtName),
                  txtValue: undef(r.txtValue),
                })),
        },
});

const toAttributes = (
  observed: ObservedHostname,
  zoneId: string,
): Attributes => ({
  customHostnameId: observed.id,
  zoneId,
  hostname: observed.hostname,
  status: observed.status,
  sslStatus: observed.ssl?.status,
  ownershipVerification:
    observed.ownershipVerification === undefined
      ? undefined
      : {
          name: observed.ownershipVerification.name,
          type: observed.ownershipVerification.type,
          value: observed.ownershipVerification.value,
        },
  ownershipVerificationHttp:
    observed.ownershipVerificationHttp === undefined
      ? undefined
      : {
          httpUrl: observed.ownershipVerificationHttp.httpUrl,
          httpBody: observed.ownershipVerificationHttp.httpBody,
        },
  validationRecords:
    observed.ssl?.validationRecords === undefined
      ? undefined
      : observed.ssl.validationRecords.map((r) => ({
          cname: r.cname,
          cnameTarget: r.cnameTarget,
          emails: r.emails,
          httpBody: r.httpBody,
          httpUrl: r.httpUrl,
          status: r.status,
          txtName: r.txtName,
          txtValue: r.txtValue,
        })),
});

// ---------------------------------------------------------------------------
// Body construction + drift detection
// ---------------------------------------------------------------------------

const buildSslBody = (ssl: Ssl | undefined) => ({
  method: ssl?.method ?? "txt",
  type: ssl?.type ?? ("dv" as const),
  certificateAuthority: ssl?.certificateAuthority,
  bundleMethod: ssl?.bundleMethod,
  cloudflareBranding: ssl?.cloudflareBranding,
  wildcard: ssl?.wildcard,
  customCertificate: ssl?.customCertificate,
  customKey: ssl?.customKey,
  customCsrId: ssl?.customCsrId,
  settings: ssl?.settings,
});

/**
 * Compare desired SSL config against observed cloud state, considering
 * only fields the user actually set (Cloudflare echoes more fields than
 * we manage, with defaults we should not fight). Returns `true` when no
 * patch is needed.
 */
const sslEqualsObserved = (
  desired: Ssl,
  observed: ObservedSsl | undefined,
): boolean => {
  if (observed === undefined) return false;
  if (desired.method !== undefined && desired.method !== observed.method) {
    return false;
  }
  if (desired.type !== undefined && desired.type !== observed.type) {
    return false;
  }
  if (
    desired.wildcard !== undefined &&
    desired.wildcard !== (observed.wildcard ?? false)
  ) {
    return false;
  }
  if (
    desired.bundleMethod !== undefined &&
    desired.bundleMethod !== observed.bundleMethod
  ) {
    return false;
  }
  if (
    desired.certificateAuthority !== undefined &&
    desired.certificateAuthority !== observed.certificateAuthority
  ) {
    return false;
  }
  const s = desired.settings;
  if (s !== undefined) {
    const o = observed.settings;
    if (s.ciphers !== undefined && !arrayEqualsUnordered(s.ciphers, o?.ciphers))
      return false;
    if (s.earlyHints !== undefined && s.earlyHints !== o?.earlyHints)
      return false;
    if (s.http2 !== undefined && s.http2 !== o?.http2) return false;
    if (s.minTlsVersion !== undefined && s.minTlsVersion !== o?.minTlsVersion)
      return false;
    if (s.tls_1_3 !== undefined && s.tls_1_3 !== o?.tls_1_3) return false;
  }
  return true;
};

const metadataEquals = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
): boolean => {
  const o = observed ?? {};
  const dKeys = Object.keys(desired);
  const oKeys = Object.keys(o);
  if (dKeys.length !== oKeys.length) return false;
  for (const k of dKeys) {
    if (JSON.stringify(desired[k]) !== JSON.stringify(o[k])) return false;
  }
  return true;
};
