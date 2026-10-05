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
  DEFAULT_SSL_MANAGEMENT,
  domainIsOwned,
  jsonEqual,
  listApplicationsAuthorizedCertificates,
  listApplicationsDomainMappings,
  ownedCertificateIds,
  parseDomainMappingName,
  resolveAppsId,
  resolveLocation,
  sameText,
  updateMaskOf,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type ApplicationsDomainMappingSslSettings = {
  /**
   * SSL management type. `AUTOMATIC` provisions a Google-managed
   * certificate. `MANUAL` requires `certificateId`.
   * @default "AUTOMATIC"
   */
  sslManagementType?:
    | appengine.SslSettingsSslManagementTypeEnum
    | (string & {});
  /**
   * AuthorizedCertificate id to serve for `MANUAL` SSL. Clearing it
   * removes SSL support.
   */
  certificateId?: string;
};

export type ApplicationsDomainMappingResourceRecord = {
  /** Resource record type (`A`, `AAAA`, `CNAME`). */
  type?: appengine.ResourceRecordTypeEnum | (string & {});
  /** Relative name of the object affected (CNAME only). */
  name?: string;
  /** Record data. */
  rrdata?: string;
};

export type ApplicationsDomainMappingProps = {
  /**
   * GCP project id. Defaults to the current project. Immutable —
   * changing it replaces the mapping.
   */
  project?: string;
  /**
   * App Engine location (`us-central`, `us-east1`, …). Defaults to the
   * application's `locationId`. Immutable — changing it replaces the
   * mapping.
   */
  location?: string;
  /**
   * Application id (usually the project id). Defaults to the current
   * project. Immutable — changing it replaces the mapping.
   */
  applicationsId?: string;
  /**
   * Domain name served by the application (for example `www.example.com`).
   * Immutable — changing it replaces the mapping. Domain mappings have
   * no labels field; `list` / nuke discover owned mappings by joining
   * `sslSettings.certificateId` to an Alchemy-owned AuthorizedCertificate,
   * or a domain that starts with `alchemy-`.
   */
  domain: string;
  /**
   * SSL configuration. Defaults to Google-managed certificates.
   */
  sslSettings?: ApplicationsDomainMappingSslSettings;
  /**
   * Whether creating this mapping should override an existing mapping
   * for the domain. By default overrides are rejected.
   */
  overrideStrategy?:
    | appengine.CreateProjectsLocationsApplicationsDomainMappingsOverrideStrategyEnum
    | (string & {});
};

export type ApplicationsDomainMapping = Resource<
  "GCP.AppEngine.ApplicationsDomainMapping",
  ApplicationsDomainMappingProps,
  {
    /** Full resource name. */
    name: string;
    /** Domain name. */
    domain: string;
    /** Project id. */
    project: string;
    /** App Engine location id. */
    location: string;
    /** Application id. */
    applicationsId: string;
    /** SSL management type. */
    sslManagementType: string | undefined;
    /** AuthorizedCertificate id currently serving SSL. */
    certificateId: string | undefined;
    /** Pending managed-certificate id, if provisioning. */
    pendingManagedCertificateId: string | undefined;
    /** DNS records that must be added at the domain registrar. */
    resourceRecords: ApplicationsDomainMappingResourceRecord[];
  },
  never,
  Providers
>;

/**
 * A custom domain serving an App Engine application via the
 * `projects.locations.applications.domainMappings` API.
 *
 * Domain mappings have no labels field. `list` / nuke discover owned
 * mappings by joining `sslSettings.certificateId` to an Alchemy-owned
 * AuthorizedCertificate, or a domain that starts with `alchemy-`.
 * Project, location, application id, and domain are identity. SSL
 * settings update in place.
 *
 * ### Creating a Domain Mapping
 * **Example:** Automatic managed SSL
 * ```typescript
 * const mapping = yield* GCP.AppEngine.ApplicationsDomainMapping("Www", {
 *   domain: "www.example.com",
 *   sslSettings: { sslManagementType: "AUTOMATIC" },
 * });
 * ```
 *
 * ### Updating SSL
 * **Example:** Point at a new certificate
 * ```typescript
 * const mapping = yield* GCP.AppEngine.ApplicationsDomainMapping("Www", {
 *   sslSettings: {
 *     sslManagementType: "MANUAL",
 *     certificateId: cert.certificateId,
 *   },
 * });
 * ```
 *
 * @resource
 * @category AppEngine
 */
export const ApplicationsDomainMapping = Resource<ApplicationsDomainMapping>(
  "GCP.AppEngine.ApplicationsDomainMapping",
);

export class ApplicationsDomainMappingNotResolved extends Data.TaggedError(
  "GCP.AppEngine.ApplicationsDomainMappingNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  mapping: appengine.DomainMapping,
  project: string,
  location: string,
  applicationsId: string,
) => {
  const parsed = parseDomainMappingName(mapping.name ?? "");
  const domain = mapping.id ?? parsed.domain;
  return {
    name:
      mapping.name ??
      `projects/${project}/locations/${location}/applications/${applicationsId}/domainMappings/${domain}`,
    domain,
    project,
    location: parsed.location ?? location,
    applicationsId: parsed.applicationsId ?? applicationsId,
    sslManagementType: mapping.sslSettings?.sslManagementType,
    certificateId: mapping.sslSettings?.certificateId,
    pendingManagedCertificateId:
      mapping.sslSettings?.pendingManagedCertificateId,
    resourceRecords: (mapping.resourceRecords ?? []).map((record) => ({
      type: record.type,
      name: record.name,
      rrdata: record.rrdata,
    })),
  };
};

const getByDomain = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
  domain: string,
) =>
  domain.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        appengine.getProjectsLocationsApplicationsDomainMappings({
          projectsId,
          locationsId,
          applicationsId,
          domainMappingsId: domain,
        }),
      );

const desiredSsl = (news: ApplicationsDomainMappingProps) => {
  const ssl = news.sslSettings;
  if (ssl === undefined) {
    return {
      sslManagementType: DEFAULT_SSL_MANAGEMENT,
    } satisfies appengine.SslSettings;
  }
  return {
    sslManagementType: ssl.sslManagementType ?? DEFAULT_SSL_MANAGEMENT,
    certificateId: ssl.certificateId,
  } satisfies appengine.SslSettings;
};

const mappingOwned = (
  mapping: appengine.DomainMapping,
  ownedIds: ReadonlySet<string>,
) => domainIsOwned(mapping.id, ownedIds, mapping);

export const ApplicationsDomainMappingProvider = () =>
  Provider.succeed(ApplicationsDomainMapping, {
    stables: ["name", "domain", "project", "location", "applicationsId"],

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
      const previousDomain = olds?.domain ?? output?.domain;
      if (previousDomain !== undefined && news.domain !== previousDomain) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
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
      const domain = olds?.domain ?? output?.domain ?? "";
      const existing = yield* getByDomain(
        project,
        location,
        applicationsId,
        domain,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, location, applicationsId);
      const ownedIds = ownedCertificateIds(
        yield* listApplicationsAuthorizedCertificates(
          project,
          location,
          applicationsId,
        ),
      );
      return mappingOwned(existing, ownedIds) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const location = yield* resolveLocation(
          undefined,
          undefined,
          env.project,
        );
        const ownedIds = ownedCertificateIds(
          yield* listApplicationsAuthorizedCertificates(
            env.project,
            location,
            env.project,
          ),
        );
        const mappings = yield* listApplicationsDomainMappings(
          env.project,
          location,
          env.project,
        );
        return mappings
          .filter((mapping) => mappingOwned(mapping, ownedIds))
          .map((mapping) =>
            toAttrs(mapping, env.project, location, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
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
      const domain = news.domain;
      const sslSettings = desiredSsl(news);

      let current = yield* getByDomain(
        project,
        location,
        applicationsId,
        domain,
      );

      if (current === undefined) {
        const operation = yield* appengine
          .createProjectsLocationsApplicationsDomainMappings({
            projectsId: project,
            locationsId: location,
            applicationsId,
            overrideStrategy: news.overrideStrategy,
            body: {
              id: domain,
              sslSettings,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<appengine.Operation>({ done: true }),
            ),
          );
        if (operation.done !== true || operation.name !== undefined) {
          yield* waitForOperation(operation, { appsId: applicationsId });
        }
        current = yield* getByDomain(project, location, applicationsId, domain);
      }

      if (current === undefined) {
        return yield* new ApplicationsDomainMappingNotResolved({
          name: `projects/${project}/locations/${location}/applications/${applicationsId}/domainMappings/${domain}`,
        });
      }

      const observedSsl = current.sslSettings;
      const typeChanged = !sameText(
        observedSsl?.sslManagementType,
        sslSettings.sslManagementType,
      );
      const certChanged = !sameText(
        observedSsl?.certificateId,
        sslSettings.certificateId,
      );
      if (
        (typeChanged || certChanged) &&
        !jsonEqual(observedSsl, sslSettings)
      ) {
        const operation =
          yield* appengine.patchProjectsLocationsApplicationsDomainMappings({
            projectsId: project,
            locationsId: location,
            applicationsId,
            domainMappingsId: domain,
            updateMask: updateMaskOf("sslSettings"),
            body: { sslSettings },
          });
        yield* waitForOperation(operation, { appsId: applicationsId });
        current =
          (yield* getByDomain(project, location, applicationsId, domain)) ??
          current;
      }

      return toAttrs(current, project, location, applicationsId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.domain.length === 0) return;
      const operation = yield* appengine
        .deleteProjectsLocationsApplicationsDomainMappings({
          projectsId: output.project,
          locationsId: output.location || DEFAULT_LOCATION,
          applicationsId: output.applicationsId,
          domainMappingsId: output.domain,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation === undefined) return;
      yield* waitForOperation(operation, {
        appsId: output.applicationsId,
        notFoundOk: true,
      });
    }),
  });
