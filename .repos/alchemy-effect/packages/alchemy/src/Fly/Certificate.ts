import type {
  CertificateCheckResponse,
  CertificateDetail,
  CertificateSummary,
  CertificateValidation as FlyCertificateValidation,
  DNSRequirements,
} from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listOwnedApps } from "./App.ts";
import type { App } from "./App.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type CertificateKind = "acme" | "custom";

export type CertificateSource = "custom" | "fly";

export type CertificateDnsRequirements = {
  a?: string[];
  aaaa?: string[];
  acmeChallenge?: { name?: string; target?: string };
  cname?: string;
  ownership?: { appValue?: string; name?: string; orgValue?: string };
};

export type CertificateValidationState = {
  alpnConfigured?: boolean;
  dnsConfigured?: boolean;
  httpConfigured?: boolean;
  ownershipTxtConfigured?: boolean;
};

export interface CertificateProps {
  /**
   * Parent Fly App. Accepts a `Fly.App` resource or an Effect that
   * produces one. Changing the App replaces the Certificate.
   */
  app: Ref<App>;
  /**
   * Hostname this Certificate covers. Identity of the resource.
   * Changing it replaces the Certificate.
   */
  hostname: string;
  /**
   * How the Certificate is issued. `"acme"` requests a Let's Encrypt
   * certificate (`createAppAcmeCertificate`). `"custom"` uploads a PEM
   * (`createAppCustomCertificate`). Changing kind replaces.
   *
   * @default "acme"
   */
  kind?: CertificateKind;
  /**
   * PEM-encoded certificate chain. Required when `kind` is `"custom"`.
   * Updating it re-uploads in place (custom create upsert, or
   * delete+create if the API conflicts).
   */
  fullchain?: string;
  /**
   * PEM-encoded private key. Required when `kind` is `"custom"`. Wrap
   * with `Redacted.make` to keep it out of logs. Never stored in
   * attributes.
   */
  privateKey?: Redacted.Redacted<string> | string;
}

export type Certificate = Resource<
  "Fly.Certificate",
  CertificateProps,
  {
    /** Physical Fly App name the Certificate is attached to. */
    appName: string;
    /** Hostname this Certificate covers. Identity of the resource. */
    hostname: string;
    /** Observed status (`active`, `pending_validation`, …). */
    status: string | undefined;
    /** Whether DNS/ownership validation has completed. */
    configured: boolean | undefined;
    /** Whether ACME issuance has been requested for this hostname. */
    acmeRequested: boolean | undefined;
    /** DNS records Fly expects for validation. */
    dnsRequirements: CertificateDnsRequirements | undefined;
    /** Per-challenge validation flags. */
    validation: CertificateValidationState | undefined;
    /** Observed source: `"custom"` for uploaded PEMs, `"fly"` for ACME. */
    source: CertificateSource;
  },
  never,
  Providers
>;

/**
 * A Fly.Certificate covers a hostname on an {@link App}. Default
 * `kind` is `"acme"` (Let's Encrypt). `"custom"` uploads a PEM.
 *
 * IPs and certificates attach to the App. A {@link Service} publishes
 * ports. Fly's proxy terminates TLS on 443 once the certificate is
 * `configured`.
 *
 * @see https://fly.io/docs/machines/api/certificates-resource/
 *
 * ### ACME certificates
 * Request Let's Encrypt for a hostname. The Service does not change.
 * Yield the certificate in the Stack. Point DNS at the App.
 *
 * **Example:** Let's Encrypt
 * ```typescript
 * export const Www = Fly.Certificate("Www", {
 *   app: Site,
 *   hostname: "www.example.com",
 * });
 * ```
 *
 * :::caution[Changing `hostname` replaces the Certificate]
 * Hostname is the identity. The old hostname is deleted, then the new
 * one is created.
 * :::
 *
 * :::caution[Changing `app` or `kind` replaces the Certificate]
 * The certificate is created on the new App or with the new issuer.
 * :::
 *
 * ### DNS
 * Point an A record at a `shared_v4` {@link IpAssignment} and an AAAA
 * at `v6`. Plus whatever `dnsRequirements` lists for the ACME
 * challenge. Alchemy re-checks via `checkAppCertificate` while
 * `configured` is false.
 *
 * Observed attrs include `status`, `configured`, `acmeRequested`,
 * `dnsRequirements`, and `validation`.
 *
 * **Example:** Yield next to a Service
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Fly.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     const ip = yield* PublicIp;
 *     const v6 = yield* V6;
 *     const www = yield* Www;
 *     return {
 *       url: api.url,
 *       ip: ip.ip,
 *       v6: v6.ip,
 *       dns: www.dnsRequirements,
 *     };
 *   }),
 * );
 * ```
 *
 * ### Custom certificates
 * `"custom"` uploads `fullchain` and `privateKey`. Wrap the key with
 * `Redacted.make` so it never logs. Never stored in attributes.
 * Updating the PEM re-uploads in place.
 *
 * **Example:** Upload a PEM
 * ```typescript
 * export const Www = Fly.Certificate("Www", {
 *   app: Site,
 *   hostname: "www.example.com",
 *   kind: "custom",
 *   fullchain: pem,
 *   privateKey: Redacted.make(key),
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>("Fly.Certificate");

export class CertificateNotCreated extends Data.TaggedError(
  "Fly.CertificateNotCreated",
)<{
  appName: string;
  hostname: string;
}> {}

export class CertificateAppMissing extends Data.TaggedError(
  "Fly.CertificateAppMissing",
)<{
  hostname: string;
}> {}

export class CertificateMaterialRequired extends Data.TaggedError(
  "Fly.CertificateMaterialRequired",
)<{
  hostname: string;
}> {}

type ObservedCert = CertificateDetail | CertificateCheckResponse;

const appNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { appName?: unknown; name?: unknown };
  if (typeof rec.appName === "string" && rec.appName.length > 0) {
    return rec.appName;
  }
  if (typeof rec.name === "string" && rec.name.length > 0) {
    return rec.name;
  }
  return undefined;
};

const unwrapSecret = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
};

const normalizePem = (pem: string | undefined): string =>
  (pem ?? "").replace(/\r\n/g, "\n").trim();

const desiredKind = (props: Pick<CertificateProps, "kind">): CertificateKind =>
  props.kind ?? "acme";

const kindOf = (source: CertificateSource): CertificateKind =>
  source === "custom" ? "custom" : "acme";

const sourceOf = (detail: ObservedCert): CertificateSource => {
  const entries = detail.certificates ?? [];
  if (entries.some((entry) => entry.source === "custom")) return "custom";
  if (entries.some((entry) => entry.source === "fly")) return "fly";
  return detail.acme_requested === true ? "fly" : "custom";
};

const sourceFromSummary = (summary: CertificateSummary): CertificateSource =>
  summary.has_custom_certificate === true ? "custom" : "fly";

const toDnsRequirements = (
  req: DNSRequirements | undefined,
): CertificateDnsRequirements | undefined => {
  if (req === undefined) return undefined;
  return {
    a: req.a,
    aaaa: req.aaaa,
    acmeChallenge:
      req.acme_challenge === undefined
        ? undefined
        : {
            name: req.acme_challenge.name,
            target: req.acme_challenge.target,
          },
    cname: req.cname,
    ownership:
      req.ownership === undefined
        ? undefined
        : {
            appValue: req.ownership.app_value,
            name: req.ownership.name,
            orgValue: req.ownership.org_value,
          },
  };
};

const toValidation = (
  validation: FlyCertificateValidation | undefined,
): CertificateValidationState | undefined => {
  if (validation === undefined) return undefined;
  return {
    alpnConfigured: validation.alpn_configured,
    dnsConfigured: validation.dns_configured,
    httpConfigured: validation.http_configured,
    ownershipTxtConfigured: validation.ownership_txt_configured,
  };
};

const toAttrs = (
  appName: string,
  detail: ObservedCert,
  fallbackHostname?: string,
): Certificate["Attributes"] => ({
  appName,
  hostname: detail.hostname ?? fallbackHostname ?? "",
  status: detail.status,
  configured: detail.configured,
  acmeRequested: detail.acme_requested,
  dnsRequirements: toDnsRequirements(detail.dns_requirements),
  validation: toValidation(detail.validation),
  source: sourceOf(detail),
});

const toAttrsFromSummary = (
  appName: string,
  summary: CertificateSummary,
): Certificate["Attributes"] | undefined => {
  const hostname = summary.hostname;
  if (hostname === undefined || hostname.length === 0) return undefined;
  return {
    appName,
    hostname,
    status: summary.status,
    configured: summary.configured,
    acmeRequested: summary.acme_requested,
    dnsRequirements: undefined,
    validation: {
      alpnConfigured: summary.acme_alpn_configured,
      dnsConfigured: summary.acme_dns_configured,
      httpConfigured: summary.acme_http_configured,
      ownershipTxtConfigured: summary.ownership_txt_configured,
    },
    source: sourceFromSummary(summary),
  };
};

const getByHostname = (appName: string, hostname: string) =>
  machines
    .getAppCertificate({ app_name: appName, hostname })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAppCertificates = (appName: string) =>
  Effect.gen(function* () {
    const all: CertificateSummary[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 8; i++) {
      const page = yield* machines
        .listAppCertificates({
          app_name: appName,
          cursor,
          limit: 100,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({
              certificates: [] as CertificateSummary[],
              next_cursor: undefined,
            }),
          ),
        );
      all.push(...(page.certificates ?? []));
      if (page.next_cursor === undefined || page.next_cursor.length === 0) {
        break;
      }
      cursor = page.next_cursor;
    }
    return all;
  });

const waitUntilGone = (appName: string, hostname: string) =>
  getByHostname(appName, hostname).pipe(
    Effect.map((found) => found === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const requireCustomMaterial = (
  hostname: string,
  fullchain: string | undefined,
  privateKey: string | undefined,
) =>
  fullchain === undefined ||
  fullchain.length === 0 ||
  privateKey === undefined ||
  privateKey.length === 0
    ? new CertificateMaterialRequired({ hostname })
    : undefined;

const createAcme = (appName: string, hostname: string) =>
  machines
    .createAppAcmeCertificate({
      app_name: appName,
      hostname,
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));

const createCustom = (
  appName: string,
  hostname: string,
  fullchain: string,
  privateKey: string,
) =>
  machines
    .createAppCustomCertificate({
      app_name: appName,
      hostname,
      fullchain,
      private_key: privateKey,
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));

const replaceCustom = (
  appName: string,
  hostname: string,
  fullchain: string,
  privateKey: string,
) =>
  Effect.gen(function* () {
    yield* machines
      .deleteAppCustomCertificate({
        app_name: appName,
        hostname,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* machines.createAppCustomCertificate({
      app_name: appName,
      hostname,
      fullchain,
      private_key: privateKey,
    });
  });

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["appName", "hostname", "source"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const appName = appNameOf(news.app);
      const appChanged = appName !== undefined && appName !== output.appName;
      const hostnameChanged = news.hostname !== output.hostname;
      const nextKind = desiredKind(news);
      const kindChanged = nextKind !== kindOf(output.source);
      if (appChanged || hostnameChanged || kindChanged) {
        return {
          action: "replace" as const,
          // Same hostname cannot exist twice — delete the old kind first.
          deleteFirst: !hostnameChanged && !appChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const appName = output?.appName ?? appNameOf(olds?.app);
      const hostname = output?.hostname ?? olds?.hostname;
      if (appName === undefined || hostname === undefined) return undefined;
      const found = yield* getByHostname(appName, hostname);
      if (found === undefined) return undefined;
      return toAttrs(appName, found, hostname);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          listAppCertificates(app.appName).pipe(
            Effect.map((certs) =>
              certs.flatMap((item) => {
                const attrs = toAttrsFromSummary(app.appName, item);
                return attrs === undefined ? [] : [attrs];
              }),
            ),
          ),
        { concurrency: 8 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const props = news ?? ({} as CertificateProps);
      const appName = appNameOf(props.app) ?? output?.appName;
      const hostname = props.hostname ?? output?.hostname;
      if (appName === undefined) {
        return yield* new CertificateAppMissing({
          hostname: hostname ?? "",
        });
      }
      if (hostname === undefined || hostname.length === 0) {
        return yield* new CertificateNotCreated({
          appName,
          hostname: "",
        });
      }

      const kind = desiredKind(props);

      // Observe by cached identity, then by desired hostname.
      let current =
        output?.hostname !== undefined
          ? yield* getByHostname(
              output.appName.length > 0 ? output.appName : appName,
              output.hostname,
            )
          : undefined;
      if (
        current === undefined &&
        (output?.hostname !== hostname || output?.appName !== appName)
      ) {
        current = yield* getByHostname(appName, hostname);
      }

      let createdThisPass = false;
      if (current === undefined) {
        if (kind === "custom") {
          const fullchain = props.fullchain;
          const privateKey = unwrapSecret(props.privateKey);
          const missing = requireCustomMaterial(
            hostname,
            fullchain,
            privateKey,
          );
          if (missing !== undefined) return yield* missing;
          const created = yield* createCustom(
            appName,
            hostname,
            fullchain!,
            privateKey!,
          );
          current = created ?? (yield* getByHostname(appName, hostname));
        } else {
          const created = yield* createAcme(appName, hostname);
          current = created ?? (yield* getByHostname(appName, hostname));
        }
        createdThisPass = true;
      }

      if (current === undefined) {
        return yield* new CertificateNotCreated({ appName, hostname });
      }

      if (kind === "custom") {
        const fullchain = props.fullchain;
        const privateKey = unwrapSecret(props.privateKey);
        const missing = requireCustomMaterial(hostname, fullchain, privateKey);
        if (missing !== undefined) return yield* missing;
        const previousChain = olds?.fullchain;
        const previousKey = unwrapSecret(olds?.privateKey);
        const materialChanged =
          olds === undefined ||
          normalizePem(fullchain) !== normalizePem(previousChain) ||
          normalizePem(privateKey) !== normalizePem(previousKey);
        if (!createdThisPass && materialChanged) {
          const upserted = yield* createCustom(
            appName,
            hostname,
            fullchain!,
            privateKey!,
          );
          if (upserted === undefined) {
            yield* replaceCustom(appName, hostname, fullchain!, privateKey!);
          }
          current =
            upserted ?? (yield* getByHostname(appName, hostname)) ?? current;
        }
      } else if (current.configured !== true) {
        const checked = yield* machines
          .checkAppCertificate({
            app_name: appName,
            hostname,
          })
          .pipe(
            Effect.catchTag(["NotFound", "BadRequest"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (checked !== undefined) {
          current = checked;
        }
      }

      return toAttrs(appName, current, hostname);
    }),

    delete: Effect.fn(function* ({ output }) {
      const appName = output.appName;
      const hostname = output.hostname;
      if (appName.length === 0 || hostname.length === 0) return;
      yield* machines
        .deleteAppCertificate({
          app_name: appName,
          hostname,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(appName, hostname);
    }),
  });
