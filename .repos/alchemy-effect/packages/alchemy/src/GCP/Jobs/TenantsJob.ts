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
  deleteJob,
  encodeOwnershipLine,
  findOwnedJob,
  getJob,
  jobNameOf,
  jsonEqual,
  listOwnedJobs,
  MAX_DESCRIPTION_LENGTH,
  MAX_REQUISITION_ID_LENGTH,
  MAX_TITLE_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseJobName,
  parseOwnership,
  replaceOnIdentity,
  sameStringList,
  sameText,
  tenantNameOf,
  toGeneratedName,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type ApplicationInfo = {
  /** Email addresses that receive applications (max 255 chars each). */
  emails?: string[];
  /** URIs for an online application form (max 2000 chars each). */
  uris?: string[];
  /** Free-text instructions a candidate can follow (max 3000 chars). */
  instruction?: string;
};

export type CompensationRange = {
  /** Inclusive range maximum. */
  maxCompensation?: jobs.Money;
  /** Inclusive range minimum. */
  minCompensation?: jobs.Money;
};

export type CompensationEntry = {
  /** Compensation description, for example equity terms. */
  description?: string;
  /** Compensation range when amount is not a single value. */
  range?: CompensationRange;
  /** Expected units paid each year. */
  expectedUnitsPerYear?: number;
  /** Compensation amount. */
  amount?: jobs.Money;
  /** Compensation type (`BASE`, `BONUS`, …). */
  type?: jobs.CompensationEntryTypeEnum | (string & {});
  /** Frequency (`HOURLY`, `ANNUAL`, …). */
  unit?: jobs.CompensationEntryUnitEnum | (string & {});
};

export type CompensationInfo = {
  /** Compensation entries. At most one entry may have type `BASE`. */
  entries?: CompensationEntry[];
};

export type ProcessingOptions = {
  /** HTML sanitization applied to description and related fields. */
  htmlSanitization?: jobs.ProcessingOptionsHtmlSanitizationEnum | (string & {});
  /** Skip resolving a more precise street address. */
  disableStreetAddressResolution?: boolean;
};

export type TenantsJobProps = {
  /**
   * Parent tenant resource name `projects/{project}/tenants/{tenant}`
   * or the tenant id. Immutable — changing it replaces the job.
   */
  parent: string;
  /**
   * Company resource name
   * `projects/{project}/tenants/{tenant}/companies/{company}`. Immutable
   * — changing it replaces the job.
   */
  company: string;
  /**
   * Server-assigned job id. Leave blank on create. Immutable — changing
   * it replaces the job.
   */
  jobId?: string;
  /**
   * Job title, for example `"Software Engineer"` (max 500 characters).
   */
  title?: string;
  /**
   * Job description (max 100,000 characters), shown to job seekers as
   * given. Defaults to the title.
   */
  description?: string;
  /**
   * Client requisition / posting id (max 255 characters). Unique per
   * company and language. Ownership is also stamped here.
   */
  requisitionId?: string;
  /**
   * Hiring addresses. Full street addresses improve commute search.
   */
  addresses?: string[];
  /**
   * Posting language as a BCP-47 code, for example `"en-US"`.
   */
  languageCode?: string;
  /**
   * Department or functional area (max 255 characters).
   */
  department?: string;
  /**
   * Experience level, for example `"ENTRY_LEVEL"`.
   */
  jobLevel?: jobs.JobJobLevelEnum | (string & {});
  /**
   * Employment types, for example `["FULL_TIME"]`.
   */
  employmentTypes?: jobs.JobEmploymentTypesItemEnumList;
  /**
   * Region throughout which the job is available.
   */
  postingRegion?: jobs.JobPostingRegionEnum | (string & {});
  /**
   * Qualifications required to perform the job (max 10,000 characters).
   */
  qualifications?: string;
  /**
   * Job responsibilities (max 10,000 characters).
   */
  responsibilities?: string;
  /**
   * Bonus, commission, and other incentives (max 10,000 characters).
   */
  incentives?: string;
  /**
   * Benefits included with the job.
   */
  jobBenefits?: jobs.JobJobBenefitsItemEnumList;
  /**
   * Desired education degrees.
   */
  degreeTypes?: jobs.JobDegreeTypesItemEnumList;
  /**
   * Promotion value used to sort featured jobs.
   */
  promotionValue?: number;
  /**
   * Job application emails, URIs, or instructions.
   */
  applicationInfo?: ApplicationInfo;
  /**
   * Compensation / pay rate.
   */
  compensationInfo?: CompensationInfo;
  /**
   * Expiration timestamp. Expired jobs drop out of search.
   */
  postingExpireTime?: string;
  /**
   * Job start timestamp (UTC).
   */
  jobStartTime?: string;
  /**
   * Job end timestamp (UTC).
   */
  jobEndTime?: string;
  /**
   * Filterable and unfilterable custom attributes.
   */
  customAttributes?: jobs.CustomAttributeMap;
  /**
   * HTML sanitization and address-resolution options.
   */
  processingOptions?: ProcessingOptions;
  /**
   * Deprecated visibility. Defaults to account-only.
   */
  visibility?: jobs.JobVisibilityEnum | (string & {});
};

export type TenantsJob = Resource<
  "GCP.Jobs.TenantsJob",
  TenantsJobProps,
  {
    /**
     * Full resource name
     * `projects/{project}/tenants/{tenant}/jobs/{job}`.
     */
    name: string;
    /** Server-assigned job id. */
    jobId: string;
    /** Parent tenant resource name. */
    parent: string;
    /** Company resource name. */
    company: string;
    /** Company display name. */
    companyDisplayName: string | undefined;
    /** Project id. */
    project: string;
    /** Job title. */
    title: string | undefined;
    /** Description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Requisition id with the Alchemy prefix stripped. */
    requisitionId: string | undefined;
    /** Hiring addresses. */
    addresses: string[] | undefined;
    /** Posting language. */
    languageCode: string | undefined;
    /** Department. */
    department: string | undefined;
    /** Experience level. */
    jobLevel: string | undefined;
    /** Employment types. */
    employmentTypes: string[] | undefined;
    /** Posting region. */
    postingRegion: string | undefined;
    /** Qualifications. */
    qualifications: string | undefined;
    /** Responsibilities. */
    responsibilities: string | undefined;
    /** Incentives. */
    incentives: string | undefined;
    /** Benefits. */
    jobBenefits: string[] | undefined;
    /** Degree types. */
    degreeTypes: string[] | undefined;
    /** Promotion value. */
    promotionValue: number | undefined;
    /** Application info. */
    applicationInfo: ApplicationInfo | undefined;
    /** Compensation info including annualized ranges. */
    compensationInfo: jobs.CompensationInfo | undefined;
    /** Expiration timestamp. */
    postingExpireTime: string | undefined;
    /** Job start timestamp. */
    jobStartTime: string | undefined;
    /** Job end timestamp. */
    jobEndTime: string | undefined;
    /** Custom attributes. */
    customAttributes: jobs.CustomAttributeMap | undefined;
    /** Derived job locations and categories. */
    derivedInfo: jobs.JobDerivedInfo | undefined;
    /** RFC3339 creation timestamp. */
    postingCreateTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    postingUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Talent Solution job posting.
 *
 * Jobs have no labels field, so Alchemy stamps ownership into the
 * client-side `requisitionId` for `list` / nuke (never into the
 * seeker-visible title or description). Parent tenant,
 * company, and job id are identity — changing any of them replaces the
 * job. Title, description, addresses, and related fields update in
 * place. A company cannot be deleted while it still has jobs.
 *
 * ### Creating a Job
 * **Example:** Software engineer posting
 * ```typescript
 * const job = yield* GCP.Jobs.TenantsJob("Engineer", {
 *   parent: tenant.name,
 *   company: company.name,
 *   title: "Software Engineer",
 *   description: "Build Cloud Talent integrations.",
 *   addresses: ["Mountain View, CA"],
 *   applicationInfo: { uris: ["https://www.example.com/apply"] },
 * });
 * ```
 *
 * ### Updating a Job
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Promote the posting
 * ```typescript
 * const job = yield* GCP.Jobs.TenantsJob("Engineer", {
 *   parent: tenant.name,
 *   company: company.name,
 *   title: "Staff Software Engineer",
 *   description: "Build Cloud Talent integrations.",
 *   promotionValue: 1,
 * });
 * ```
 *
 * @resource
 * @category Jobs
 */
export const TenantsJob = Resource<TenantsJob>("GCP.Jobs.TenantsJob");

export class TenantsJobNotResolved extends Data.TaggedError(
  "GCP.Jobs.TenantsJobNotResolved",
)<{
  name: string;
}> {}

const toParent = (project: string, parent: string) =>
  tenantNameOf(project, parent);

const applicationOf = (
  info: jobs.ApplicationInfo | undefined,
): ApplicationInfo | undefined => {
  if (info === undefined) return undefined;
  return {
    emails: info.emails,
    uris: info.uris,
    instruction: info.instruction,
  };
};

const toAttrs = (job: jobs.Job, project: string) => {
  const name = job.name ?? "";
  const parsed = parseJobName(name, project);
  return {
    name,
    jobId: parsed.jobId,
    parent: parsed.parent,
    company: job.company ?? "",
    companyDisplayName: job.companyDisplayName,
    project: parsed.project || project,
    title: job.title,
    description: parseOwnership(job.description).text,
    requisitionId: parseOwnership(job.requisitionId).text,
    addresses: job.addresses,
    languageCode: job.languageCode,
    department: job.department,
    jobLevel: job.jobLevel,
    employmentTypes: job.employmentTypes,
    postingRegion: job.postingRegion,
    qualifications: job.qualifications,
    responsibilities: job.responsibilities,
    incentives: job.incentives,
    jobBenefits: job.jobBenefits,
    degreeTypes: job.degreeTypes,
    promotionValue: job.promotionValue,
    applicationInfo: applicationOf(job.applicationInfo),
    compensationInfo: job.compensationInfo,
    postingExpireTime: job.postingExpireTime,
    jobStartTime: job.jobStartTime,
    jobEndTime: job.jobEndTime,
    customAttributes: job.customAttributes,
    derivedInfo: job.derivedInfo,
    postingCreateTime: job.postingCreateTime,
    postingUpdateTime: job.postingUpdateTime,
  };
};

const toBody = (
  news: TenantsJobProps,
  description: string,
  requisitionId: string,
  title: string,
): jobs.Job => ({
  title,
  description,
  requisitionId,
  company: news.company,
  addresses: news.addresses,
  languageCode: news.languageCode,
  department: news.department,
  jobLevel: news.jobLevel,
  employmentTypes: news.employmentTypes,
  postingRegion: news.postingRegion,
  qualifications: news.qualifications,
  responsibilities: news.responsibilities,
  incentives: news.incentives,
  jobBenefits: news.jobBenefits,
  degreeTypes: news.degreeTypes,
  promotionValue: news.promotionValue,
  applicationInfo: news.applicationInfo,
  compensationInfo: news.compensationInfo,
  postingExpireTime: news.postingExpireTime,
  jobStartTime: news.jobStartTime,
  jobEndTime: news.jobEndTime,
  customAttributes: news.customAttributes,
  processingOptions: news.processingOptions,
  visibility: news.visibility,
});

export const TenantsJobProvider = () =>
  Provider.succeed(TenantsJob, {
    stables: ["name", "jobId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.jobId ?? output?.jobId,
        nextId: news.jobId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: toParent(env.project, news.parent),
        extra:
          (olds?.company ?? output?.company) !== undefined &&
          news.company !== (olds?.company ?? output?.company),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(
        env.project,
        olds?.parent ?? output?.parent ?? "",
      );
      const name =
        output?.name ?? jobNameOf(parent, olds?.jobId ?? output?.jobId ?? "");
      let existing = yield* getJob(name);
      if (existing === undefined) {
        existing = yield* findOwnedJob(parent, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned =
        (yield* ownedByAlchemy(id, existing.description)) ||
        (yield* ownedByAlchemy(id, existing.requisitionId));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const listed = yield* listOwnedJobs(env.project);
        return listed.map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(env.project, news.parent);
      const ownership = yield* ownershipLabels(id);
      const title = yield* toGeneratedName(
        id,
        news.title,
        output?.title,
        MAX_TITLE_LENGTH,
      );
      const requisition = yield* toGeneratedName(
        id,
        news.requisitionId,
        output?.requisitionId,
      );
      const requisitionId = encodeOwnershipLine(
        ownership,
        requisition,
        MAX_REQUISITION_ID_LENGTH,
      );
      // Shown to job seekers, so no ownership marker (requisitionId has it).
      const description = (
        news.description ??
        output?.description ??
        title
      ).slice(0, MAX_DESCRIPTION_LENGTH);
      const name = output?.name ?? jobNameOf(parent, news.jobId ?? "");

      let current = yield* getJob(name);
      if (current === undefined) {
        current = yield* findOwnedJob(parent, id);
      }

      if (current === undefined) {
        const created = yield* jobs
          .createProjectsTenantsJobs({
            parent,
            body: toBody(news, description, requisitionId, title),
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedJob(parent, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TenantsJobNotResolved({
          name: name || `${parent}/jobs/${requisition}`,
        });
      }

      const currentName = current.name ?? name;
      const optionalText = (
        currentValue: string | undefined,
        next: string | undefined,
        field: string,
      ) =>
        next === undefined || sameText(currentValue, next) ? undefined : field;
      const optionalJson = (
        currentValue: unknown,
        next: unknown,
        field: string,
      ) =>
        next === undefined || jsonEqual(currentValue, next) ? undefined : field;
      const updateMask = updateMaskOf(
        sameText(current.title, title) ? undefined : "title",
        sameText(current.description, description) ? undefined : "description",
        sameText(current.requisitionId, requisitionId)
          ? undefined
          : "requisitionId",
        sameText(current.company, news.company) ? undefined : "company",
        optionalJson(current.addresses, news.addresses, "addresses"),
        optionalText(current.languageCode, news.languageCode, "languageCode"),
        optionalText(current.department, news.department, "department"),
        optionalText(current.jobLevel, news.jobLevel, "jobLevel"),
        optionalJson(
          current.employmentTypes,
          news.employmentTypes,
          "employmentTypes",
        ),
        optionalText(
          current.postingRegion,
          news.postingRegion,
          "postingRegion",
        ),
        optionalText(
          current.qualifications,
          news.qualifications,
          "qualifications",
        ),
        optionalText(
          current.responsibilities,
          news.responsibilities,
          "responsibilities",
        ),
        optionalText(current.incentives, news.incentives, "incentives"),
        optionalJson(current.jobBenefits, news.jobBenefits, "jobBenefits"),
        optionalJson(current.degreeTypes, news.degreeTypes, "degreeTypes"),
        news.promotionValue !== undefined &&
          (current.promotionValue ?? 0) !== news.promotionValue
          ? "promotionValue"
          : undefined,
        optionalJson(
          applicationOf(current.applicationInfo),
          news.applicationInfo,
          "applicationInfo",
        ),
        optionalJson(
          current.compensationInfo?.entries,
          news.compensationInfo?.entries,
          "compensationInfo",
        ),
        optionalText(
          current.postingExpireTime,
          news.postingExpireTime,
          "postingExpireTime",
        ),
        optionalText(current.jobStartTime, news.jobStartTime, "jobStartTime"),
        optionalText(current.jobEndTime, news.jobEndTime, "jobEndTime"),
        optionalJson(
          current.customAttributes,
          news.customAttributes,
          "customAttributes",
        ),
        optionalJson(
          current.processingOptions,
          news.processingOptions,
          "processingOptions",
        ),
        optionalText(current.visibility, news.visibility, "visibility"),
      );

      if (updateMask.length > 0) {
        current = yield* jobs.patchProjectsTenantsJobs({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            ...toBody(news, description, requisitionId, title),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteJob(output.name);
      yield* waitUntilGone(getJob(output.name));
    }),
  });
