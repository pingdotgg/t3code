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
  DEFAULT_SSL_MANAGEMENT,
  domainIsOwned,
  jsonEqual,
  listAuthorizedCertificates,
  listDomainMappings,
  ownedCertificateIds,
  parseDomainMappingName,
  resolveAppsId,
  sameText,
  updateMaskOf,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type AppsDomainMappingSslSettings = {
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

export type AppsDomainMappingResourceRecord = {
  /** Resource record type (`A`, `AAAA`, `CNAME`). */
  type?: appengine.ResourceRecordTypeEnum | (string & {});
  /** Relative name of the object affected (CNAME only). */
  name?: string;
  /** Record data. */
  rrdata?: string;
};

export type AppsDomainMappingProps = {
  /**
   * App Engine application id. Defaults to the current GCP project.
   * Immutable — changing it replaces the mapping.
   */
  appsId?: string;
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
  sslSettings?: AppsDomainMappingSslSettings;
  /**
   * Whether creating this mapping should override an existing mapping
   * for the domain. By default overrides are rejected.
   */
  overrideStrategy?:
    | appengine.CreateAppsDomainMappingsOverrideStrategyEnum
    | (string & {});
};

export type AppsDomainMapping = Resource<
  "GCP.AppEngine.AppsDomainMapping",
  AppsDomainMappingProps,
  {
    /** Full resource name `apps/{appsId}/domainMappings/{domain}`. */
    name: string;
    /** Domain name. */
    domain: string;
    /** App Engine application id. */
    appsId: string;
    /** Project id. */
    project: string;
    /** SSL management type. */
    sslManagementType: string | undefined;
    /** AuthorizedCertificate id currently serving SSL. */
    certificateId: string | undefined;
    /** Pending managed-certificate id, if provisioning. */
    pendingManagedCertificateId: string | undefined;
    /** DNS records that must be added at the domain registrar. */
    resourceRecords: AppsDomainMappingResourceRecord[];
  },
  never,
  Providers
>;

/**
 * A custom domain serving an App Engine application.
 *
 * Domain mappings have no labels field. `list` / nuke discover owned
 * mappings by joining `sslSettings.certificateId` to an Alchemy-owned
 * AuthorizedCertificate, or a domain that starts with `alchemy-`. The
 * application id and domain are identity — changing either replaces the
 * mapping. SSL settings update in place.
 *
 * ### Creating a Domain Mapping
 * **Example:** Automatic managed SSL
 * ```typescript
 * const mapping = yield* GCP.AppEngine.AppsDomainMapping("Www", {
 *   domain: "www.example.com",
 *   sslSettings: { sslManagementType: "AUTOMATIC" },
 * });
 * ```
 *
 * **Example:** Manual certificate
 * ```typescript
 * const mapping = yield* GCP.AppEngine.AppsDomainMapping("Www", {
 *   domain: "www.example.com",
 *   sslSettings: {
 *     sslManagementType: "MANUAL",
 *     certificateId: cert.certificateId,
 *   },
 * });
 * ```
 *
 * ### Updating SSL
 * **Example:** Point at a new certificate
 * ```typescript
 * const mapping = yield* GCP.AppEngine.AppsDomainMapping("Www", {
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
export const AppsDomainMapping = Resource<AppsDomainMapping>(
  "GCP.AppEngine.AppsDomainMapping",
);

export class AppsDomainMappingNotResolved extends Data.TaggedError(
  "GCP.AppEngine.AppsDomainMappingNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  mapping: appengine.DomainMapping,
  appsId: string,
  project: string,
) => {
  const parsed = parseDomainMappingName(mapping.name ?? "");
  const domain = mapping.id ?? parsed.domain;
  return {
    name: mapping.name ?? `apps/${appsId}/domainMappings/${domain}`,
    domain,
    appsId: parsed.appsId ?? appsId,
    project,
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

const getByDomain = (appsId: string, domain: string) =>
  domain.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        appengine.getAppsDomainMappings({
          appsId,
          domainMappingsId: domain,
        }),
      );

const desiredSsl = (news: AppsDomainMappingProps) => {
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

export const AppsDomainMappingProvider = () =>
  Provider.succeed(AppsDomainMapping, {
    stables: ["name", "domain", "appsId", "project"],

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
      const previousDomain = olds?.domain ?? output?.domain;
      if (previousDomain !== undefined && news.domain !== previousDomain) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(olds?.appsId, output?.appsId);
      const domain = olds?.domain ?? output?.domain ?? "";
      const existing = yield* getByDomain(appsId, domain);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, appsId, env.project);
      const ownedIds = ownedCertificateIds(
        yield* listAuthorizedCertificates(appsId),
      );
      return mappingOwned(existing, ownedIds) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const ownedIds = ownedCertificateIds(
          yield* listAuthorizedCertificates(env.project),
        );
        const mappings = yield* listDomainMappings(env.project);
        return mappings
          .filter((mapping) => mappingOwned(mapping, ownedIds))
          .map((mapping) => toAttrs(mapping, env.project, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(news.appsId, output?.appsId);
      const domain = news.domain;
      const sslSettings = desiredSsl(news);

      let current = yield* getByDomain(appsId, domain);

      if (current === undefined) {
        const operation = yield* appengine
          .createAppsDomainMappings({
            appsId,
            overrideStrategy: news.overrideStrategy,
            body: {
              id: domain,
              sslSettings,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByDomain(appsId, domain).pipe(
                Effect.flatMap((existing) =>
                  existing !== undefined
                    ? Effect.succeed<appengine.Operation>({
                        name: undefined,
                        done: true,
                      })
                    : Effect.fail(
                        new AppsDomainMappingNotResolved({
                          name: `apps/${appsId}/domainMappings/${domain}`,
                        }),
                      ),
                ),
              ),
            ),
          );
        if (operation.done !== true || operation.name !== undefined) {
          yield* waitForOperation(operation, { appsId });
        }
        current = yield* getByDomain(appsId, domain);
      }

      if (current === undefined) {
        return yield* new AppsDomainMappingNotResolved({
          name: `apps/${appsId}/domainMappings/${domain}`,
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
      const updateMask = updateMaskOf(
        typeChanged || certChanged ? "sslSettings" : undefined,
      );
      if (updateMask.length > 0 && !jsonEqual(observedSsl, sslSettings)) {
        const operation = yield* appengine.patchAppsDomainMappings({
          appsId,
          domainMappingsId: domain,
          updateMask,
          body: { sslSettings },
        });
        yield* waitForOperation(operation, { appsId });
        current = (yield* getByDomain(appsId, domain)) ?? current;
      }

      return toAttrs(current, appsId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.domain.length === 0) return;
      const operation = yield* appengine
        .deleteAppsDomainMappings({
          appsId: output.appsId,
          domainMappingsId: output.domain,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation === undefined) return;
      yield* waitForOperation(operation, {
        appsId: output.appsId,
        notFoundOk: true,
      });
    }),
  });
