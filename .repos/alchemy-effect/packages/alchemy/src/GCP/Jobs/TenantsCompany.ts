import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  companyNameOf,
  deleteCompany,
  encodeOwnershipLine,
  findOwnedCompany,
  getCompany,
  listOwnedCompanies,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EXTERNAL_ID_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseCompanyName,
  parseOwnership,
  replaceOnIdentity,
  sameBoolean,
  sameStringList,
  sameText,
  tenantNameOf,
  toGeneratedName,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type TenantsCompanyProps = {
  /**
   * Parent tenant resource name `projects/{project}/tenants/{tenant}`
   * or the tenant id. Immutable — changing it replaces the company.
   */
  parent: string;
  /**
   * Server-assigned company id. Leave blank on create. Immutable —
   * changing it replaces the company.
   */
  companyId?: string;
  /**
   * Client-side company identifier (max 255 characters). Ownership is
   * also stamped here for `list` / nuke.
   */
  externalId?: string;
  /**
   * Display name shown to job seekers, for example `"Google LLC"`.
   */
  displayName?: string;
  /**
   * Primary website URI, for example `"https://www.google.com"`.
   */
  websiteUri?: string;
  /**
   * Careers page URI, for example `"https://careers.google.com"`.
   */
  careerSiteUri?: string;
  /**
   * URI that hosts the employer logo.
   */
  imageUri?: string;
  /**
   * Street address of the company headquarters.
   */
  headquartersAddress?: string;
  /**
   * Employer company size.
   */
  size?: jobs.CompanySizeEnum | (string & {});
  /**
   * Whether this company posts jobs for other employers.
   * @default false
   */
  hiringAgency?: boolean;
  /**
   * Equal Employment Opportunity legal disclaimer (max 500 characters).
   */
  eeoText?: string;
  /**
   * Deprecated. Filterable custom attribute keys used in keyword search.
   */
  keywordSearchableJobCustomAttributes?: string[];
};

export type TenantsCompany = Resource<
  "GCP.Jobs.TenantsCompany",
  TenantsCompanyProps,
  {
    /**
     * Full resource name
     * `projects/{project}/tenants/{tenant}/companies/{company}`.
     */
    name: string;
    /** Server-assigned company id. */
    companyId: string;
    /** Parent tenant resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Client identifier with the Alchemy prefix stripped. */
    externalId: string | undefined;
    /** Display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** Primary website URI. */
    websiteUri: string | undefined;
    /** Careers page URI. */
    careerSiteUri: string | undefined;
    /** Logo URI. */
    imageUri: string | undefined;
    /** Headquarters street address. */
    headquartersAddress: string | undefined;
    /** Employer company size. */
    size: string | undefined;
    /** Whether this company is a hiring agency. */
    hiringAgency: boolean;
    /** EEO disclaimer text. */
    eeoText: string | undefined;
    /** Whether the company is suspended from public availability. */
    suspended: boolean | undefined;
    /** Derived headquarters location. */
    derivedInfo: jobs.CompanyDerivedInfo | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Talent Solution company — the hiring entity that owns job
 * postings.
 *
 * Companies have no labels field, so Alchemy stamps ownership into the
 * client-side `externalId` for `list` / nuke (never into the
 * seeker-visible display name). Parent tenant and
 * company id are identity — changing either replaces the company.
 * Display name, URIs, size, and related fields update in place.
 *
 * ### Creating a Company
 * **Example:** Company under a tenant
 * ```typescript
 * const tenant = yield* GCP.Jobs.Tenant("Acme", {});
 * const company = yield* GCP.Jobs.TenantsCompany("Labs", {
 *   parent: tenant.name,
 *   displayName: "Acme Labs",
 *   websiteUri: "https://www.example.com",
 * });
 * ```
 *
 * ### Updating a Company
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename and set headquarters
 * ```typescript
 * const company = yield* GCP.Jobs.TenantsCompany("Labs", {
 *   parent: tenant.name,
 *   displayName: "Acme Research",
 *   headquartersAddress: "Mountain View, CA",
 * });
 * ```
 *
 * @resource
 * @category Jobs
 */
export const TenantsCompany = Resource<TenantsCompany>(
  "GCP.Jobs.TenantsCompany",
);

export class TenantsCompanyNotResolved extends Data.TaggedError(
  "GCP.Jobs.TenantsCompanyNotResolved",
)<{
  name: string;
}> {}

const toParent = (project: string, parent: string) =>
  tenantNameOf(project, parent);

const toAttrs = (company: jobs.Company, project: string) => {
  const name = company.name ?? "";
  const parsed = parseCompanyName(name, project);
  return {
    name,
    companyId: parsed.companyId,
    parent: parsed.parent,
    project: parsed.project || project,
    externalId: parseOwnership(company.externalId).text,
    displayName: parseOwnership(company.displayName).text,
    websiteUri: company.websiteUri,
    careerSiteUri: company.careerSiteUri,
    imageUri: company.imageUri,
    headquartersAddress: company.headquartersAddress,
    size: company.size,
    hiringAgency: company.hiringAgency === true,
    eeoText: company.eeoText,
    suspended: company.suspended,
    derivedInfo: company.derivedInfo,
  };
};

export const TenantsCompanyProvider = () =>
  Provider.succeed(TenantsCompany, {
    stables: ["name", "companyId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.companyId ?? output?.companyId,
        nextId: news.companyId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: toParent(env.project, news.parent),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(
        env.project,
        olds?.parent ?? output?.parent ?? "",
      );
      const name =
        output?.name ??
        companyNameOf(parent, olds?.companyId ?? output?.companyId ?? "");
      let existing = yield* getCompany(name);
      if (existing === undefined) {
        existing = yield* findOwnedCompany(parent, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned =
        (yield* ownedByAlchemy(id, existing.displayName)) ||
        (yield* ownedByAlchemy(id, existing.externalId));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const companies = yield* listOwnedCompanies(env.project);
        return companies.map((company) => toAttrs(company, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(env.project, news.parent);
      const ownership = yield* ownershipLabels(id);
      const clientId = yield* toGeneratedName(
        id,
        news.externalId,
        output?.externalId,
      );
      const display = yield* toGeneratedName(
        id,
        news.displayName,
        output?.displayName,
      );
      const externalId = encodeOwnershipLine(
        ownership,
        clientId,
        MAX_EXTERNAL_ID_LENGTH,
      );
      // Shown to job seekers, so no ownership marker (externalId has it).
      const displayName = display.slice(0, MAX_DISPLAY_NAME_LENGTH);
      const name = output?.name ?? companyNameOf(parent, news.companyId ?? "");

      let current = yield* getCompany(name);
      if (current === undefined) {
        current = yield* findOwnedCompany(parent, id);
      }

      if (current === undefined) {
        const created = yield* jobs
          .createProjectsTenantsCompanies({
            parent,
            body: {
              externalId,
              displayName,
              websiteUri: news.websiteUri,
              careerSiteUri: news.careerSiteUri,
              imageUri: news.imageUri,
              headquartersAddress: news.headquartersAddress,
              size: news.size,
              hiringAgency: news.hiringAgency === true ? true : undefined,
              eeoText: news.eeoText,
              keywordSearchableJobCustomAttributes:
                news.keywordSearchableJobCustomAttributes,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedCompany(parent, id)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TenantsCompanyNotResolved({
          name: name || `${parent}/companies/${clientId}`,
        });
      }

      const currentName = current.name ?? name;
      const desiredHiring = news.hiringAgency === true;
      const optionalText = (
        currentValue: string | undefined,
        next: string | undefined,
        field: string,
      ) =>
        next === undefined || sameText(currentValue, next) ? undefined : field;
      const updateMask = updateMaskOf(
        sameText(current.externalId, externalId) ? undefined : "externalId",
        sameText(current.displayName, displayName) ? undefined : "displayName",
        optionalText(current.websiteUri, news.websiteUri, "websiteUri"),
        optionalText(
          current.careerSiteUri,
          news.careerSiteUri,
          "careerSiteUri",
        ),
        optionalText(current.imageUri, news.imageUri, "imageUri"),
        optionalText(
          current.headquartersAddress,
          news.headquartersAddress,
          "headquartersAddress",
        ),
        optionalText(current.size, news.size, "size"),
        news.hiringAgency !== undefined &&
          !sameBoolean(current.hiringAgency, desiredHiring)
          ? "hiringAgency"
          : undefined,
        optionalText(current.eeoText, news.eeoText, "eeoText"),
        news.keywordSearchableJobCustomAttributes !== undefined &&
          !sameStringList(
            current.keywordSearchableJobCustomAttributes,
            news.keywordSearchableJobCustomAttributes,
          )
          ? "keywordSearchableJobCustomAttributes"
          : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* jobs.patchProjectsTenantsCompanies({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            externalId,
            displayName,
            websiteUri: news.websiteUri ?? "",
            careerSiteUri: news.careerSiteUri ?? "",
            imageUri: news.imageUri ?? "",
            headquartersAddress: news.headquartersAddress ?? "",
            size: news.size,
            hiringAgency: desiredHiring,
            eeoText: news.eeoText ?? "",
            keywordSearchableJobCustomAttributes:
              news.keywordSearchableJobCustomAttributes ?? [],
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteCompany(output.name);
      yield* waitUntilGone(getCompany(output.name));
    }),
  });
