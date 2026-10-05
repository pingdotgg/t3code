import * as assuredworkloads from "@distilled.cloud/gcp/assuredworkloads_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type ApiWorkload,
  deleteChildResources,
  fieldMask,
  fingerprint,
  lastSegment,
  listOwnedWorkloads,
  listWorkloads,
  locationParent,
  normalizeLocation,
  organizationIdOf,
  organizationParent,
  parseName,
  replaceOnIdentity,
  resolveOrganization,
  resourceNameFromOperation,
  sameBool,
  sameText,
  toDisplayName,
  tryResolveOrganization,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ComplianceRegime =
  | assuredworkloads.GoogleCloudAssuredworkloadsV1WorkloadComplianceRegimeEnum
  | (string & {});

export type Partner =
  | assuredworkloads.GoogleCloudAssuredworkloadsV1WorkloadPartnerEnum
  | (string & {});

export type ResourceType =
  | assuredworkloads.GoogleCloudAssuredworkloadsV1WorkloadResourceSettingsResourceTypeEnum
  | (string & {});

export type ResourceSettings = {
  /**
   * Resource identifier. For a project this is `project_id`. For a
   * KeyRing this is the keyring id. Folders ignore this — Google assigns
   * the folder id.
   */
  resourceId?: string;
  /**
   * Resource kind this setting applies to (`CONSUMER_FOLDER`,
   * `CONSUMER_PROJECT`, `ENCRYPTION_KEYS_PROJECT`, `KEYRING`).
   */
  resourceType?: ResourceType;
  /**
   * User-assigned display name used when creating the resource.
   */
  displayName?: string;
};

export type ResourceInfo = {
  /**
   * Resource identifier. For a project this is the project number.
   */
  resourceId?: string;
  /**
   * Resource kind (`CONSUMER_FOLDER`, `CONSUMER_PROJECT`,
   * `ENCRYPTION_KEYS_PROJECT`, `KEYRING`).
   */
  resourceType?: ResourceType;
};

export type KmsSettings = {
  /**
   * Time at which KMS creates a new crypto-key version and marks it
   * primary. Input-only and immutable.
   */
  nextRotationTime?: string;
  /**
   * Period by which `nextRotationTime` advances on each rotation. At
   * least 24 hours and at most 876,000 hours. Input-only and immutable.
   */
  rotationPeriod?: string;
};

export type WorkloadOptions = {
  /**
   * Key Access Justifications enrollment type.
   */
  kajEnrollmentType?: string;
};

export type PartnerPermissions = {
  /**
   * Allow the partner to view inspectability logs and monitoring
   * violations.
   */
  dataLogsViewer?: boolean;
  /**
   * Allow the partner to view violation alerts.
   */
  assuredWorkloadsMonitoring?: boolean;
  /**
   * Allow the partner to view support-case details for an AXT log.
   */
  accessTransparencyLogsSupportCaseViewer?: boolean;
  /**
   * Allow the partner to view Access Approval logs.
   */
  serviceAccessApprover?: boolean;
};

export type WorkloadProps = {
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the workload.
   */
  organization?: string;
  /**
   * Location (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the workload. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-assigned display name (4-30 characters: letters, numbers,
   * hyphen, spaces). If omitted, a unique name is generated from the
   * stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Compliance regime. Immutable — changing it replaces the workload.
   */
  complianceRegime: ComplianceRegime;
  /**
   * Billing account for resources created as children of this workload.
   * Format `billingAccounts/{billing_account_id}`. Immutable — changing
   * it replaces the workload.
   */
  billingAccount?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * When true, email notifications for violations are enabled. Honored
   * only on update — create always enables notifications.
   * @default true
   */
  violationNotificationsEnabled?: boolean;
  /**
   * Partner regime associated with this workload. Immutable — changing
   * it replaces the workload.
   */
  partner?: Partner;
  /**
   * Billing account used to purchase services from sovereign partners.
   * Format `billingAccounts/{billing_account_id}`. Immutable — changing
   * it replaces the workload.
   */
  partnerServicesBillingAccount?: string;
  /**
   * Permissions granted to the Assured Workloads partner service
   * account. Updates use `mutatePartnerPermissions`.
   */
  partnerPermissions?: PartnerPermissions;
  /**
   * Enable sovereignty controls (Europe/Canada customers). Immutable —
   * changing it replaces the workload.
   */
  enableSovereignControls?: boolean;
  /**
   * Parent folder for provisioned resources, as `folders/{folder_id}`.
   * When omitted, resources are created under the organization.
   * Immutable — changing it replaces the workload.
   */
  provisionedResourcesParent?: string;
  /**
   * Custom settings for resources created with the workload. Input-only
   * and immutable — changing them replaces the workload.
   */
  resourceSettings?: ResourceSettings[];
  /**
   * CMEK crypto-key settings. Deprecated — prefer `ENCRYPTION_KEYS_PROJECT`
   * or `KEYRING` in `resourceSettings`. Immutable — changing them
   * replaces the workload.
   */
  kmsSettings?: KmsSettings;
  /**
   * Options applied at create time. Immutable — changing them replaces
   * the workload.
   */
  workloadOptions?: WorkloadOptions;
  /**
   * External id attached as a label on the workload and its projects so
   * billing can be broken down. Create-only.
   */
  externalId?: string;
};

export type Workload = Resource<
  "GCP.AssuredWorkloads.Workload",
  WorkloadProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/workloads/{workload}`. */
    name: string;
    /** Server-assigned workload id (last path segment). */
    workloadId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User-assigned display name. */
    displayName: string | undefined;
    /** Compliance regime. */
    complianceRegime: string | undefined;
    /** Billing account resource name. */
    billingAccount: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether violation email notifications are enabled. */
    violationNotificationsEnabled: boolean;
    /** Partner regime, if set. */
    partner: string | undefined;
    /** Partner services billing account, if set. */
    partnerServicesBillingAccount: string | undefined;
    /** Partner permissions. */
    partnerPermissions: PartnerPermissions | undefined;
    /** Whether sovereignty controls are enabled. */
    enableSovereignControls: boolean | undefined;
    /** Child resources created with the workload. */
    resources: ResourceInfo[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** KAJ enrollment state. */
    kajEnrollmentState: string | undefined;
    /** Whether resource monitoring is enabled. */
    resourceMonitoringEnabled: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Assured Workloads folder that applies a
 * compliance regime (FedRAMP, IL4, regional data boundary, …) to the
 * projects created under it.
 *
 * Workload ids are assigned by Google. Alchemy stamps ownership into
 * `labels` so `list` / `pnpm nuke:gcp` can find them. `organization`,
 * `location`, `complianceRegime`, billing accounts, partner settings,
 * and resource settings are identity — changing them replaces the
 * workload. `displayName`, `labels`, `violationNotificationsEnabled`,
 * and `partnerPermissions` update in place.
 *
 * Creating a workload provisions a folder (and optionally projects and
 * key rings) under the organization. Delete first marks those children
 * `DELETE_REQUESTED`, then deletes the workload.
 *
 * ### Creating a Workload
 * **Example:** US regional access with generated display name
 * ```typescript
 * const workload = yield* GCP.AssuredWorkloads.Workload("Regulated", {
 *   complianceRegime: "US_REGIONAL_ACCESS",
 *   billingAccount: "billingAccounts/000000-000000-000000",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named FedRAMP Moderate workload
 * ```typescript
 * const workload = yield* GCP.AssuredWorkloads.Workload("Fedramp", {
 *   organization: "organizations/123456789",
 *   location: "us-central1",
 *   displayName: "fedramp moderate",
 *   complianceRegime: "FEDRAMP_MODERATE",
 *   billingAccount: "billingAccounts/000000-000000-000000",
 * });
 * ```
 *
 * ### Updating a Workload
 * **Example:** Change display name and labels
 * ```typescript
 * const workload = yield* GCP.AssuredWorkloads.Workload("Regulated", {
 *   complianceRegime: "US_REGIONAL_ACCESS",
 *   displayName: "regulated prod",
 *   labels: { env: "prod" },
 *   violationNotificationsEnabled: false,
 * });
 * ```
 *
 * @resource
 * @category AssuredWorkloads
 */
export const Workload = Resource<Workload>("GCP.AssuredWorkloads.Workload");

export class WorkloadNotResolved extends Data.TaggedError(
  "GCP.AssuredWorkloads.WorkloadNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  workload: ApiWorkload,
  project: string,
  region: string,
): Workload["Attributes"] => {
  const name = workload.name ?? "";
  const parsed = parseName(name, region);
  const organization = parsed.organization
    ? organizationParent(parsed.organization)
    : "";
  return {
    name,
    workloadId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || region,
    project,
    displayName: workload.displayName,
    complianceRegime: workload.complianceRegime,
    billingAccount: workload.billingAccount,
    labels: userLabels(workload.labels),
    violationNotificationsEnabled:
      workload.violationNotificationsEnabled ?? true,
    partner: workload.partner,
    partnerServicesBillingAccount: workload.partnerServicesBillingAccount,
    partnerPermissions: workload.partnerPermissions,
    enableSovereignControls: workload.enableSovereignControls,
    resources: (workload.resources ?? []).map((resource) => ({
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
    })),
    createTime: workload.createTime,
    etag: workload.etag,
    kajEnrollmentState: workload.kajEnrollmentState,
    resourceMonitoringEnabled: workload.resourceMonitoringEnabled,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : assuredworkloads
        .getOrganizationsLocationsWorkloads({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, organization: string, location: string) =>
  Effect.gen(function* () {
    const workloads = yield* listWorkloads(organization, location);
    for (const workload of workloads) {
      if (yield* hasAlchemyLabels(id, tagRecord(workload.labels))) {
        return workload;
      }
    }
    return undefined;
  });

const observe = (
  id: string,
  name: string | undefined,
  organization: string,
  location: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const byName = yield* getByName(name);
      if (byName !== undefined) return byName;
    }
    return yield* findOwned(id, organization, location);
  });

const desiredBody = (
  news: WorkloadProps,
  displayName: string,
  labels: Record<string, string>,
): ApiWorkload => ({
  displayName,
  complianceRegime: news.complianceRegime,
  labels,
  billingAccount: news.billingAccount,
  partner: news.partner,
  partnerServicesBillingAccount: news.partnerServicesBillingAccount,
  partnerPermissions: news.partnerPermissions,
  enableSovereignControls: news.enableSovereignControls,
  provisionedResourcesParent: news.provisionedResourcesParent,
  resourceSettings: news.resourceSettings,
  kmsSettings: news.kmsSettings,
  workloadOptions: news.workloadOptions,
});

export const WorkloadProvider = () =>
  Provider.succeed(Workload, {
    stables: [
      "name",
      "workloadId",
      "organization",
      "organizationId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg =
        news.organization !== undefined
          ? organizationParent(news.organization)
          : previousOrg;
      const previousLocation = olds?.location ?? output?.location;
      const previousRegime = olds?.complianceRegime ?? output?.complianceRegime;
      const previousBilling = olds?.billingAccount ?? output?.billingAccount;
      const previousPartner = olds?.partner ?? output?.partner;
      const previousPartnerBilling =
        olds?.partnerServicesBillingAccount ??
        output?.partnerServicesBillingAccount;
      const previousParent = olds?.provisionedResourcesParent ?? undefined;
      const previousSovereign =
        olds?.enableSovereignControls ?? output?.enableSovereignControls;
      return replaceOnIdentity(
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          organizationParent(previousOrg) !== organizationParent(nextOrg)) ||
          (previousLocation !== undefined &&
            news.location !== undefined &&
            normalizeLocation(previousLocation) !==
              normalizeLocation(news.location)) ||
          (previousRegime !== undefined &&
            previousRegime !== news.complianceRegime) ||
          !sameText(previousBilling, news.billingAccount) ||
          !sameText(previousPartner, news.partner) ||
          !sameText(
            previousPartnerBilling,
            news.partnerServicesBillingAccount,
          ) ||
          !sameText(previousParent, news.provisionedResourcesParent) ||
          (news.enableSovereignControls !== undefined &&
            previousSovereign !== undefined &&
            previousSovereign !== news.enableSovereignControls) ||
          (news.resourceSettings !== undefined &&
            olds?.resourceSettings !== undefined &&
            fingerprint(olds.resourceSettings) !==
              fingerprint(news.resourceSettings)) ||
          (news.kmsSettings !== undefined &&
            olds?.kmsSettings !== undefined &&
            fingerprint(olds.kmsSettings) !== fingerprint(news.kmsSettings)) ||
          (news.workloadOptions !== undefined &&
            olds?.workloadOptions !== undefined &&
            fingerprint(olds.workloadOptions) !==
              fingerprint(news.workloadOptions)),
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.AssuredWorkloads.OrganizationNotResolved", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const existing = yield* observe(id, output?.name, organization, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const workloads = yield* listOwnedWorkloads(organization, env.region);
        return workloads.map((workload) =>
          toAttrs(workload, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(organization, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );

      let current = yield* observe(id, output?.name, organization, location);

      if (current === undefined) {
        const created = yield* assuredworkloads
          .createOrganizationsLocationsWorkloads({
            parent,
            externalId: news.externalId,
            body: desiredBody(news, displayName, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (code 6) is a create race: find the winner below.
          const settled = yield* waitForOperation(created).pipe(
            Effect.catchIf(
              (error) =>
                error._tag === "GCP.OperationFailed" && error.code === 6,
              () => Effect.succeed(created),
            ),
          );
          const createdName =
            resourceNameFromOperation(settled) ??
            resourceNameFromOperation(created);
          current =
            createdName !== undefined
              ? yield* waitUntilExists(getByName(createdName), createdName)
              : yield* waitUntilExists(
                  findOwned(id, organization, location),
                  parent,
                );
        } else {
          current = yield* waitUntilExists(
            findOwned(id, organization, location),
            parent,
          );
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new WorkloadNotResolved({
          name: output?.name ?? parent,
        });
      }

      const name = current.name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);
      const notifyChanged =
        news.violationNotificationsEnabled !== undefined &&
        !sameBool(
          current.violationNotificationsEnabled,
          news.violationNotificationsEnabled,
        );
      const mask = fieldMask([
        displayChanged && "display_name",
        labelsChanged && "labels",
        notifyChanged && "violation_notifications_enabled",
      ]);

      if (mask.length > 0) {
        current = yield* assuredworkloads.patchOrganizationsLocationsWorkloads({
          name,
          updateMask: mask,
          body: {
            name,
            displayName,
            labels: desiredLabels,
            violationNotificationsEnabled:
              news.violationNotificationsEnabled ??
              current.violationNotificationsEnabled,
            etag: current.etag,
          },
        });
      }

      const partnerChanged =
        news.partnerPermissions !== undefined &&
        fingerprint(current.partnerPermissions) !==
          fingerprint(news.partnerPermissions);
      if (partnerChanged) {
        current =
          yield* assuredworkloads.mutatePartnerPermissionsOrganizationsLocationsWorkloads(
            {
              name,
              body: {
                etag: current.etag,
                partnerPermissions: news.partnerPermissions,
                updateMask: "partner_permissions",
              },
            },
          );
      }

      if (current === undefined) {
        return yield* new WorkloadNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* Effect.gen(function* () {
        const existing = yield* getByName(output.name);
        if (existing !== undefined) {
          yield* deleteChildResources(existing);
        }
        yield* assuredworkloads.deleteOrganizationsLocationsWorkloads({
          name: output.name,
          etag: output.etag,
        });
      }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "BadRequest" || error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
