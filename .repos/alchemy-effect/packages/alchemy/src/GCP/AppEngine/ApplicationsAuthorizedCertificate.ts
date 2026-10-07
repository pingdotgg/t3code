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
  DEFAULT_LOCATION,
  encodeOwnership,
  findOwnedCertificate,
  hasOwnershipMarker,
  ignoreMissing,
  listApplicationsAuthorizedCertificates,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseCertificateName,
  parseOwnership,
  resolveAppsId,
  resolveLocation,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type ApplicationsAuthorizedCertificateRawData = {
  /** PEM-encoded x.509 public certificate, including header and footer. */
  publicCertificate?: string;
  /**
   * Unencrypted PEM-encoded RSA private key (2048 bits or fewer), including
   * header and footer. Input-only.
   */
  privateKey?: string;
};

export type ApplicationsAuthorizedCertificateProps = {
  /**
   * GCP project id. Defaults to the current project. Immutable —
   * changing it replaces the certificate.
   */
  project?: string;
  /**
   * App Engine location (`us-central`, `us-east1`, …). Defaults to the
   * application's `locationId`. Immutable — changing it replaces the
   * certificate.
   */
  location?: string;
  /**
   * Application id (usually the project id). Defaults to the current
   * project. Immutable — changing it replaces the certificate.
   */
  applicationsId?: string;
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
  certificateRawData?: ApplicationsAuthorizedCertificateRawData;
};

export type ApplicationsAuthorizedCertificate = Resource<
  "GCP.AppEngine.ApplicationsAuthorizedCertificate",
  ApplicationsAuthorizedCertificateProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned certificate id. */
    certificateId: string;
    /** Project id. */
    project: string;
    /** App Engine location id. */
    location: string;
    /** Application id. */
    applicationsId: string;
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
 * An SSL certificate uploaded to an App Engine application via the
 * `projects.locations.applications.authorizedCertificates` API.
 *
 * App Engine certificates have no labels field, so Alchemy stamps
 * ownership into `displayName` for `list` / nuke. Project, location,
 * application id, and server-assigned certificate id are identity.
 * Display name and PEM data update in place.
 *
 * ### Creating a Certificate
 * **Example:** Upload a self-managed certificate
 * ```typescript
 * const cert = yield* GCP.AppEngine.ApplicationsAuthorizedCertificate(
 *   "FrontendTls",
 *   {
 *     displayName: "frontend",
 *     publicCertificate,
 *     privateKey,
 *   },
 * );
 * ```
 *
 * ### Updating a Certificate
 * **Example:** Rename
 * ```typescript
 * const cert = yield* GCP.AppEngine.ApplicationsAuthorizedCertificate(
 *   "FrontendTls",
 *   {
 *     displayName: "frontend-prod",
 *     publicCertificate,
 *     privateKey,
 *   },
 * );
 * ```
 *
 * @resource
 * @category AppEngine
 */
export const ApplicationsAuthorizedCertificate =
  Resource<ApplicationsAuthorizedCertificate>(
    "GCP.AppEngine.ApplicationsAuthorizedCertificate",
  );

export class ApplicationsAuthorizedCertificateNotResolved extends Data.TaggedError(
  "GCP.AppEngine.ApplicationsAuthorizedCertificateNotResolved",
)<{
  name: string;
}> {}

const rawDataOf = (props: ApplicationsAuthorizedCertificateProps) => {
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
  project: string,
  location: string,
  applicationsId: string,
) => {
  const parsed = parseCertificateName(certificate.name ?? "");
  return {
    name:
      certificate.name ??
      `projects/${project}/locations/${location}/applications/${applicationsId}/authorizedCertificates/${certificate.id ?? ""}`,
    certificateId: certificate.id ?? parsed.certificateId,
    project,
    location: parsed.location ?? location,
    applicationsId: parsed.applicationsId ?? applicationsId,
    displayName: parseOwnership(certificate.displayName).text,
    domainNames: [...(certificate.domainNames ?? [])],
    expireTime: certificate.expireTime,
    domainMappingsCount: certificate.domainMappingsCount,
    managedStatus: certificate.managedCertificate?.status,
    lastRenewalTime: certificate.managedCertificate?.lastRenewalTime,
    visibleDomainMappings: [...(certificate.visibleDomainMappings ?? [])],
  };
};

const getById = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
  certificateId: string,
) =>
  certificateId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        appengine.getProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId,
          locationsId,
          applicationsId,
          authorizedCertificatesId: certificateId,
        }),
      );

export const ApplicationsAuthorizedCertificateProvider = () =>
  Provider.succeed(ApplicationsAuthorizedCertificate, {
    stables: ["name", "certificateId", "project", "location", "applicationsId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = olds?.project ?? output?.project;
      const nextProject = news.project ?? previousProject;
      if (
        previousProject !== undefined &&
        nextProject !== undefined &&
        nextProject !== previousProject
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        nextLocation !== previousLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousApp = olds?.applicationsId ?? output?.applicationsId;
      const nextApp = news.applicationsId ?? previousApp;
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
      const applicationsId = yield* resolveAppsId(
        olds?.applicationsId ?? olds?.project,
        output?.applicationsId ?? output?.project,
      );
      const project = olds?.project ?? output?.project ?? env.project;
      const location = yield* resolveLocation(
        olds?.location,
        output?.location,
        applicationsId,
      );
      let existing = yield* getById(
        project,
        location,
        applicationsId,
        olds?.certificateId ?? output?.certificateId ?? "",
      );
      if (existing === undefined) {
        existing = yield* findOwnedCertificate(
          id,
          yield* listApplicationsAuthorizedCertificates(
            project,
            location,
            applicationsId,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, location, applicationsId);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const location = yield* resolveLocation(
          undefined,
          undefined,
          env.project,
        );
        const certificates = yield* listApplicationsAuthorizedCertificates(
          env.project,
          location,
          env.project,
        );
        return certificates
          .filter((certificate) => hasOwnershipMarker(certificate.displayName))
          .map((certificate) =>
            toAttrs(certificate, env.project, location, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const applicationsId = yield* resolveAppsId(
        news.applicationsId ?? news.project,
        output?.applicationsId ?? output?.project,
      );
      const project = news.project ?? output?.project ?? env.project;
      const location = yield* resolveLocation(
        news.location,
        output?.location,
        applicationsId,
      );
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(
        ownership,
        yield* toDisplayName(id, news.displayName, output?.displayName),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const certificateRawData = rawDataOf(news);

      let current = yield* getById(
        project,
        location,
        applicationsId,
        news.certificateId ?? output?.certificateId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedCertificate(
          id,
          yield* listApplicationsAuthorizedCertificates(
            project,
            location,
            applicationsId,
          ),
        );
      }

      if (current === undefined) {
        const created = yield* appengine
          .createProjectsLocationsApplicationsAuthorizedCertificates({
            projectsId: project,
            locationsId: location,
            applicationsId,
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
                  yield* listApplicationsAuthorizedCertificates(
                    project,
                    location,
                    applicationsId,
                  ),
                );
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApplicationsAuthorizedCertificateNotResolved({
          name: `projects/${project}/locations/${location}/applications/${applicationsId}/authorizedCertificates/${news.certificateId ?? ""}`,
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
        current =
          yield* appengine.patchProjectsLocationsApplicationsAuthorizedCertificates(
            {
              projectsId: project,
              locationsId: location,
              applicationsId,
              authorizedCertificatesId: certificateId,
              updateMask,
              body: {
                displayName,
                certificateRawData,
              },
            },
          );
      }

      return toAttrs(current, project, location, applicationsId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.certificateId.length === 0) return;
      if (output.managedStatus !== undefined) return;
      yield* ignoreMissing(
        appengine.deleteProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId: output.project,
          locationsId: output.location || DEFAULT_LOCATION,
          applicationsId: output.applicationsId,
          authorizedCertificatesId: output.certificateId,
        }),
      );
    }),
  });
