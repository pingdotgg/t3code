import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  encodeOwnership,
  findOwnedCertificate,
  hasOwnershipMarker,
  ignoreMissing,
  listAuthorizedCertificates,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseCertificateName,
  parseOwnership,
  resolveAppsId,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type AppsAuthorizedCertificateRawData = {
  /** PEM-encoded x.509 public certificate, including header and footer. */
  publicCertificate?: string;
  /**
   * Unencrypted PEM-encoded RSA private key (2048 bits or fewer), including
   * header and footer. Input-only.
   */
  privateKey?: string;
};

export type AppsAuthorizedCertificateProps = {
  /**
   * App Engine application id (the `{appsId}` segment of
   * `apps/{appsId}/authorizedCertificates/{id}`). Defaults to the current
   * GCP project. Immutable — changing it replaces the certificate.
   */
  appsId?: string;
  /**
   * Server-assigned certificate id. Immutable — changing it replaces
   * the certificate.
   */
  certificateId?: string;
  /**
   * User-specified display name. App Engine certificates have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
  /**
   * PEM-encoded x.509 public certificate. Input-only. Updating it renews
   * the certificate in place for the same domains.
   */
  publicCertificate?: string;
  /**
   * Unencrypted PEM-encoded RSA private key. Input-only.
   */
  privateKey?: string;
  /**
   * Nested certificate payload. Top-level `publicCertificate` /
   * `privateKey` take precedence when both are set.
   */
  certificateRawData?: AppsAuthorizedCertificateRawData;
};

export type AppsAuthorizedCertificate = Resource<
  "GCP.AppEngine.AppsAuthorizedCertificate",
  AppsAuthorizedCertificateProps,
  {
    /** Full resource name `apps/{appsId}/authorizedCertificates/{id}`. */
    name: string;
    /** Server-assigned certificate id. */
    certificateId: string;
    /** App Engine application id. */
    appsId: string;
    /** Project id. */
    project: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Topmost domains this certificate applies to. */
    domainNames: string[];
    /** RFC3339 expiry. */
    expireTime: string | undefined;
    /** Count of domain mappings using this certificate. */
    domainMappingsCount: number | undefined;
    /** Managed-certificate status, if App Engine manages this cert. */
    managedStatus: string | undefined;
    /** Last managed-certificate renewal time. */
    lastRenewalTime: string | undefined;
    /** Domain mapping resource names visible to the caller. */
    visibleDomainMappings: string[];
  },
  never,
  Providers
>;

/**
 * An SSL certificate uploaded to an App Engine application.
 *
 * App Engine certificates have no labels field, so Alchemy stamps
 * ownership into `displayName` for `list` / nuke. The application id and
 * server-assigned certificate id are identity — changing either replaces
 * the certificate. Display name and PEM data update in place.
 *
 * ### Creating a Certificate
 * **Example:** Upload a self-managed certificate
 * ```typescript
 * const cert = yield* GCP.AppEngine.AppsAuthorizedCertificate("FrontendTls", {
 *   displayName: "frontend",
 *   publicCertificate,
 *   privateKey,
 * });
 * ```
 *
 * **Example:** Nested raw-data payload
 * ```typescript
 * const cert = yield* GCP.AppEngine.AppsAuthorizedCertificate("FrontendTls", {
 *   certificateRawData: {
 *     publicCertificate,
 *     privateKey,
 *   },
 * });
 * ```
 *
 * ### Updating a Certificate
 * **Example:** Rename
 * ```typescript
 * const cert = yield* GCP.AppEngine.AppsAuthorizedCertificate("FrontendTls", {
 *   displayName: "frontend-prod",
 *   publicCertificate,
 *   privateKey,
 * });
 * ```
 *
 * @resource
 * @category AppEngine
 */
export const AppsAuthorizedCertificate = Resource<AppsAuthorizedCertificate>(
  "GCP.AppEngine.AppsAuthorizedCertificate",
);

export class AppsAuthorizedCertificateNotResolved extends Data.TaggedError(
  "GCP.AppEngine.AppsAuthorizedCertificateNotResolved",
)<{
  name: string;
}> {}

const rawDataOf = (props: AppsAuthorizedCertificateProps) => {
  const publicCertificate =
    props.publicCertificate ?? props.certificateRawData?.publicCertificate;
  const privateKey = props.privateKey ?? props.certificateRawData?.privateKey;
  if (publicCertificate === undefined && privateKey === undefined) {
    return undefined;
  }
  return { publicCertificate, privateKey };
};

const toAttrs = (
  certificate: appengine.AuthorizedCertificate,
  appsId: string,
  project: string,
) => {
  const parsed = parseCertificateName(certificate.name ?? "");
  return {
    name:
      certificate.name ??
      `apps/${appsId}/authorizedCertificates/${certificate.id ?? ""}`,
    certificateId: certificate.id ?? parsed.certificateId,
    appsId: parsed.appsId ?? appsId,
    project,
    displayName: parseOwnership(certificate.displayName).text,
    domainNames: [...(certificate.domainNames ?? [])],
    expireTime: certificate.expireTime,
    domainMappingsCount: certificate.domainMappingsCount,
    managedStatus: certificate.managedCertificate?.status,
    lastRenewalTime: certificate.managedCertificate?.lastRenewalTime,
    visibleDomainMappings: [...(certificate.visibleDomainMappings ?? [])],
  };
};

const getById = (appsId: string, certificateId: string) =>
  certificateId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        appengine.getAppsAuthorizedCertificates({
          appsId,
          authorizedCertificatesId: certificateId,
        }),
      );

export const AppsAuthorizedCertificateProvider = () =>
  Provider.succeed(AppsAuthorizedCertificate, {
    stables: ["name", "certificateId", "appsId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousApp = olds?.appsId ?? output?.appsId;
      const nextApp = news.appsId ?? previousApp;
      if (
        previousApp !== undefined &&
        nextApp !== undefined &&
        nextApp !== previousApp
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.certificateId ?? output?.certificateId;
      if (
        previousId !== undefined &&
        news.certificateId !== undefined &&
        news.certificateId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(olds?.appsId, output?.appsId);
      let existing = yield* getById(
        appsId,
        olds?.certificateId ?? output?.certificateId ?? "",
      );
      if (existing === undefined) {
        existing = yield* findOwnedCertificate(
          id,
          yield* listAuthorizedCertificates(appsId),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, appsId, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const certificates = yield* listAuthorizedCertificates(env.project);
        return certificates
          .filter((certificate) => hasOwnershipMarker(certificate.displayName))
          .map((certificate) => toAttrs(certificate, env.project, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(news.appsId, output?.appsId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(
        ownership,
        yield* toDisplayName(id, news.displayName, output?.displayName),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const certificateRawData = rawDataOf(news);

      let current = yield* getById(
        appsId,
        news.certificateId ?? output?.certificateId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedCertificate(
          id,
          yield* listAuthorizedCertificates(appsId),
        );
      }

      if (current === undefined) {
        const created = yield* appengine
          .createAppsAuthorizedCertificates({
            appsId,
            body: {
              displayName,
              certificateRawData,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.gen(function* () {
                return yield* findOwnedCertificate(
                  id,
                  yield* listAuthorizedCertificates(appsId),
                );
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsAuthorizedCertificateNotResolved({
          name: `apps/${appsId}/authorizedCertificates/${news.certificateId ?? ""}`,
        });
      }

      const certificateId = current.id ?? output?.certificateId ?? "";
      const nameChanged = !sameText(current.displayName, displayName);
      const pemChanged = certificateRawData !== undefined;
      const updateMask = updateMaskOf(
        nameChanged ? "displayName" : undefined,
        pemChanged ? "certificateRawData" : undefined,
      );
      if (updateMask.length > 0) {
        current = yield* appengine.patchAppsAuthorizedCertificates({
          appsId,
          authorizedCertificatesId: certificateId,
          updateMask,
          body: {
            displayName,
            certificateRawData,
          },
        });
      }

      return toAttrs(current, appsId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.certificateId.length === 0) return;
      if (output.managedStatus !== undefined) return;
      yield* ignoreMissing(
        appengine.deleteAppsAuthorizedCertificates({
          appsId: output.appsId,
          authorizedCertificatesId: output.certificateId,
        }),
      );
    }),
  });
