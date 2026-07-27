import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.OriginTlsClientAuth.HostnameAssociation" as const;
type TypeId = typeof TypeId;

/**
 * Deployment status of the association or its pinned certificate. Changes
 * propagate asynchronously (`pending_deployment` → `active`), typically
 * settling within seconds.
 */
export type HostnameAssociationStatus =
  | "initializing"
  | "pending_deployment"
  | "pending_deletion"
  | "active"
  | "deleted"
  | "deployment_timed_out"
  | "deletion_timed_out"
  // Keep the union open so new Cloudflare statuses aren't blocked by stale types.
  | (string & {});

export type HostnameAssociationProps = {
  /**
   * Zone the hostname belongs to. Cannot be changed — updating this property
   * triggers a replacement.
   */
  zoneId: string;
  /**
   * The hostname on the origin for which the client certificate will be
   * presented. Must be a hostname of the zone. This is the association's
   * identity — updating it triggers a replacement (the old hostname's
   * association is voided).
   */
  hostname: string;
  /**
   * Identifier of the hostname client certificate
   * ({@link HostnameCertificate}) presented to the origin
   * for this hostname. Required by Cloudflare for every hostname AOP
   * configuration. Mutable — updated in place.
   */
  certId: string;
  /**
   * Whether hostname-level Authenticated Origin Pulls is enabled for this
   * hostname. Mutable — updated in place. On destroy the association is
   * voided (Cloudflare's `enabled: null`), restoring the hostname to
   * zone-level behavior.
   */
  enabled: boolean;
};

export type HostnameAssociationAttributes = {
  /** Zone the hostname belongs to. */
  zoneId: string;
  /** The hostname the association applies to. */
  hostname: string;
  /** Identifier of the pinned hostname client certificate. */
  certId: string;
  /** Whether hostname-level Authenticated Origin Pulls is enabled. */
  enabled: boolean;
  /** Deployment status of the association. */
  status: HostnameAssociationStatus | undefined;
  /** Deployment status of the pinned certificate. */
  certStatus: HostnameAssociationStatus | undefined;
};

export type HostnameAssociation = Resource<
  TypeId,
  HostnameAssociationProps,
  HostnameAssociationAttributes,
  never,
  Providers
>;

/**
 * A per-hostname Authenticated Origin Pulls (AOP) association
 * (`/zones/{zone_id}/origin_tls_client_auth/hostnames`).
 *
 * Pins a hostname client certificate
 * ({@link HostnameCertificate}) to a hostname and toggles
 * hostname-level AOP for it. Cloudflare's API is a bulk upsert keyed by
 * hostname; this resource manages exactly one hostname per instance, so
 * separate instances for different hostnames are safe to deploy
 * concurrently. On destroy the association is voided (`enabled: null`),
 * which restores the hostname to zone-level AOP behavior.
 * @resource
 * @product Origin TLS Client Auth
 * @category SSL/TLS & Certificates
 * @section Enabling AOP for a hostname
 * @example Associate a hostname with a client certificate
 * ```typescript
 * const cert = yield* Cloudflare.OriginTlsClientAuth.HostnameCertificate("AopHostCert", {
 *   zoneId: zone.zoneId,
 *   certificate: clientCertPem,
 *   privateKey: alchemy.secret.env.AOP_CLIENT_KEY,
 * });
 *
 * yield* Cloudflare.OriginTlsClientAuth.HostnameAssociation("AopHost", {
 *   zoneId: zone.zoneId,
 *   hostname: "api.example.com",
 *   certId: cert.certificateId,
 *   enabled: true,
 * });
 * ```
 *
 * @example Keep the certificate pinned but disable enforcement
 * ```typescript
 * yield* Cloudflare.OriginTlsClientAuth.HostnameAssociation("AopHost", {
 *   zoneId: zone.zoneId,
 *   hostname: "api.example.com",
 *   certId: cert.certificateId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/per-hostname/
 */
export const HostnameAssociation = Resource<HostnameAssociation>(TypeId);

/**
 * Returns true if the given value is an HostnameAssociation
 * resource.
 */
export const isHostnameAssociation = (
  value: unknown,
): value is HostnameAssociation =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HostnameAssociationProvider = () =>
  Provider.succeed(HostnameAssociation, {
    stables: ["zoneId", "hostname"],

    // Non-listable: an association is keyed entirely by {zoneId, hostname}
    // and the only read op is `getHostname({ zoneId, hostname })`. Cloudflare
    // exposes no endpoint that enumerates which hostnames in a zone have an
    // AOP association (`listHostnameCertificates` lists certificates, which
    // carry no hostname), so there is provably no way to discover the
    // hostnames to read. Return [] rather than throwing.
    list: () => Effect.succeed<HostnameAssociationAttributes[]>([]),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // zoneId is Input<string>; compare only once both sides are concrete.
      if (
        typeof olds.zoneId === "string" &&
        typeof news.zoneId === "string" &&
        olds.zoneId !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
      // The hostname is the association's identity in Cloudflare's bulk
      // upsert — changing it must void the old hostname's entry, so it is a
      // replacement.
      if (olds.hostname !== news.hostname) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const hostname = output?.hostname ?? olds?.hostname;
      if (!zoneId || !hostname) return undefined;
      const observed = yield* observeAssociation(zoneId, hostname);
      if (!observed) return undefined;
      const attrs = toAttributes(observed, zoneId, hostname);
      // Cold read (no prior output): an association for this hostname exists
      // but carries no ownership markers, so we cannot prove we created it —
      // brand it `Unowned` so the engine refuses to take it over unless
      // `adopt` is set.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const certId = news.certId as string;
      const hostname = news.hostname;

      // 1. Observe — the hostname is the deterministic identity; a voided
      //    (`enabled: null`) or missing entry reads as absent.
      const observed = yield* observeAssociation(zoneId, hostname);

      // 2. Sync — the PUT is a true upsert; skip it when the observed entry
      //    already matches the desired certificate and enablement.
      if (
        observed &&
        observed.certId === certId &&
        observed.enabled === news.enabled
      ) {
        return toAttributes(observed, zoneId, hostname);
      }
      const put = yield* originTls.putHostname({
        zoneId,
        config: [{ hostname, certId, enabled: news.enabled }],
      });
      const result = put.result.find((r) => r.hostname === hostname);

      // 3. Return — propagation is asynchronous (`pending_deployment` →
      //    `active`); we do not block on activation.
      return toAttributes(
        result ?? { certId, enabled: news.enabled },
        zoneId,
        hostname,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, hostname } = output;
      // Observe first — voiding an already-voided / never-created hostname
      // is a no-op, and the PUT needs the certificate id currently pinned to
      // the association.
      const observed = yield* observeAssociation(zoneId, hostname);
      if (!observed) return;
      yield* originTls
        .putHostname({
          zoneId,
          // `enabled: null` voids the association; Cloudflare still requires
          // the pinned certificate id in the payload.
          config: [
            {
              hostname,
              certId: observed.certId ?? output.certId,
              enabled: null,
            },
          ],
        })
        .pipe(
          // Code 1415: the pinned certificate was already deleted out from
          // under the association, which Cloudflare rejects even for a void.
          // The association is inert without its certificate — treat as done.
          Effect.catchTag("InvalidHostnameConfig", () => Effect.void),
        );
    }),
  });

// Observe a hostname's association, mapping "never configured" (HTTP 404 /
// code 1553) and "voided" (`enabled: null`) to `undefined`.
const observeAssociation = (zoneId: string, hostname: string) =>
  originTls.getHostname({ zoneId, hostname }).pipe(
    Effect.map((assoc) =>
      assoc.enabled === null || assoc.enabled === undefined ? undefined : assoc,
    ),
    Effect.catchTag("HostnameAssociationNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

type AssociationShape = {
  certId?: string | null;
  enabled?: boolean | null;
  status?: string | null;
  certStatus?: string | null;
};

const toAttributes = (
  assoc: AssociationShape,
  zoneId: string,
  hostname: string,
): HostnameAssociationAttributes => ({
  zoneId,
  hostname,
  certId: assoc.certId!,
  enabled: assoc.enabled ?? false,
  status: assoc.status ?? undefined,
  certStatus: assoc.certStatus ?? undefined,
});
