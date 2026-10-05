import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  parseDescription,
} from "./ownership.ts";
import {
  lastSegment,
  orgName,
  sameJson,
  waitForOperation,
} from "./operations.ts";

const DEFAULT_RUNTIME_TYPE = "CLOUD";
const DEFAULT_BILLING_TYPE = "EVALUATION";
/** Organization provisioning and deletion take tens of minutes. */
const ORGANIZATION_BUDGET = "60 minutes";

export type OrganizationAddonsConfig = {
  /** API Security add-on. */
  apiSecurityConfig?: { enabled?: boolean };
  /** Monetization add-on. */
  monetizationConfig?: { enabled?: boolean };
  /** Connectors Platform add-on. */
  connectorsPlatformConfig?: { enabled?: boolean };
  /** Analytics add-on. */
  analyticsConfig?: { enabled?: boolean };
  /** Integration add-on. */
  integrationConfig?: { enabled?: boolean };
  /** Advanced API Ops add-on. */
  advancedApiOpsConfig?: { enabled?: boolean };
};

export type OrganizationProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id —
   * Apigee X organizations are 1:1 with a Google Cloud project.
   * Immutable.
   */
  organizationId?: string;
  /**
   * Primary Google Cloud region for analytics data storage.
   * Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  analyticsRegion?: string;
  /**
   * Runtime type purchased for this organization (`CLOUD` or `HYBRID`).
   * Immutable.
   * @default "CLOUD"
   */
  runtimeType?:
    | apigee.GoogleCloudApigeeV1OrganizationRuntimeTypeEnum
    | (string & {});
  /**
   * Billing type. See Apigee pricing. Immutable after create.
   * @default "EVALUATION"
   */
  billingType?:
    | apigee.GoogleCloudApigeeV1OrganizationBillingTypeEnum
    | (string & {});
  /**
   * Human-readable description. Apigee organizations have no labels, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Display name. Unused by Apigee today; reserved for future use.
   */
  displayName?: string;
  /**
   * Disable VPC peering through Private Google Access. Required when
   * `authorizedNetwork` is omitted for `CLOUD` runtime.
   * @default true
   */
  disableVpcPeering?: boolean;
  /**
   * Compute Engine network peered with Apigee runtime instances.
   */
  authorizedNetwork?: string;
  /**
   * Restrict internet egress for VPC Service Controls. Valid only when
   * `runtimeType` is `CLOUD` and `disableVpcPeering` is true.
   */
  networkEgressRestricted?: boolean;
  /**
   * Cloud KMS key for runtime database encryption. Immutable.
   */
  runtimeDatabaseEncryptionKeyName?: string;
  /**
   * Cloud KMS key for control-plane data. Immutable.
   */
  controlPlaneEncryptionKeyName?: string;
  /**
   * Cloud KMS key for API consumer data. Immutable.
   */
  apiConsumerDataEncryptionKeyName?: string;
  /**
   * Single-region location for control-plane data (data residency).
   */
  apiConsumerDataLocation?: string;
  /**
   * Disable the integrated developer portal.
   */
  portalDisabled?: boolean;
  /**
   * Add-on configurations.
   */
  addonsConfig?: OrganizationAddonsConfig;
};

export type Organization = Resource<
  "GCP.Apigee.Organization",
  OrganizationProps,
  {
    /** Full resource name `organizations/{org}`. */
    name: string;
    /** Organization id (last path segment). */
    organizationId: string;
    /** Project id associated with the organization. */
    project: string;
    /** Analytics region. */
    analyticsRegion: string | undefined;
    /** Runtime type. */
    runtimeType: string | undefined;
    /** Billing type. */
    billingType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Whether VPC peering is disabled. */
    disableVpcPeering: boolean;
    /** Authorized VPC network, if any. */
    authorizedNetwork: string | undefined;
    /** Whether internet egress is restricted. */
    networkEgressRestricted: boolean;
    /** Runtime database CMEK, if any. */
    runtimeDatabaseEncryptionKeyName: string | undefined;
    /** Control-plane CMEK, if any. */
    controlPlaneEncryptionKeyName: string | undefined;
    /** API consumer data CMEK, if any. */
    apiConsumerDataEncryptionKeyName: string | undefined;
    /** Control-plane data location. */
    apiConsumerDataLocation: string | undefined;
    /** Whether the portal is disabled. */
    portalDisabled: boolean;
    /** Add-on configurations. */
    addonsConfig: OrganizationAddonsConfig | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Apigee project id used for PSC allowlisting. */
    apigeeProjectId: string | undefined;
    /** Subscription plan. */
    subscriptionPlan: string | undefined;
    /** Subscription type. */
    subscriptionType: string | undefined;
    /** Environments in the organization. */
    environments: string[];
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee X organization, 1:1 with a Google Cloud project.
 *
 * Organizations have no labels field — Alchemy stamps ownership into
 * the description so `list` / nuke can find them. Creating an
 * organization is slow and entitlement-gated; live tests skip unless
 * `GCP_TEST_APIGEE=1`.
 *
 * Changing `organizationId`, `analyticsRegion`, `runtimeType`,
 * `billingType`, or CMEK keys replaces the organization.
 *
 * ### Creating an Organization
 * **Example:** Evaluation org in us-central1
 * ```typescript
 * const org = yield* GCP.Apigee.Organization("Org", {
 *   analyticsRegion: "us-central1",
 *   runtimeType: "CLOUD",
 *   billingType: "EVALUATION",
 *   disableVpcPeering: true,
 * });
 * ```
 *
 * **Example:** Description and add-ons
 * ```typescript
 * const org = yield* GCP.Apigee.Organization("Org", {
 *   description: "api platform",
 *   addonsConfig: { monetizationConfig: { enabled: true } },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Organization = Resource<Organization>("GCP.Apigee.Organization");

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.Apigee.OrganizationNotResolved",
)<{
  name: string;
}> {}

const toOrgId = (
  project: string,
  organizationId: string | undefined,
  existing?: string,
) => organizationId ?? existing ?? project;

const toAttrs = (
  organization: apigee.GoogleCloudApigeeV1Organization,
  project: string,
) => {
  const organizationId = lastSegment(organization.name ?? project);
  const parsed = parseDescription(organization.description);
  const addons = organization.addonsConfig;
  return {
    name: orgName(organizationId),
    organizationId,
    project: organization.projectId ?? project,
    analyticsRegion: organization.analyticsRegion,
    runtimeType: organization.runtimeType,
    billingType: organization.billingType,
    description: parsed.description,
    displayName: organization.displayName,
    disableVpcPeering: organization.disableVpcPeering === true,
    authorizedNetwork: organization.authorizedNetwork,
    networkEgressRestricted: organization.networkEgressRestricted === true,
    runtimeDatabaseEncryptionKeyName:
      organization.runtimeDatabaseEncryptionKeyName,
    controlPlaneEncryptionKeyName: organization.controlPlaneEncryptionKeyName,
    apiConsumerDataEncryptionKeyName:
      organization.apiConsumerDataEncryptionKeyName,
    apiConsumerDataLocation: organization.apiConsumerDataLocation,
    portalDisabled: organization.portalDisabled === true,
    addonsConfig: addons,
    state: organization.state,
    apigeeProjectId: organization.apigeeProjectId,
    subscriptionPlan: organization.subscriptionPlan,
    subscriptionType: organization.subscriptionType,
    environments: [...(organization.environments ?? [])],
    createdAt: organization.createdAt,
    lastModifiedAt: organization.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizations({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  props: OrganizationProps,
  description: string,
  analyticsRegion: string,
): apigee.GoogleCloudApigeeV1Organization => ({
  analyticsRegion,
  runtimeType: props.runtimeType ?? DEFAULT_RUNTIME_TYPE,
  billingType: props.billingType ?? DEFAULT_BILLING_TYPE,
  description,
  displayName: props.displayName,
  disableVpcPeering: props.disableVpcPeering ?? true,
  authorizedNetwork: props.authorizedNetwork,
  networkEgressRestricted: props.networkEgressRestricted,
  runtimeDatabaseEncryptionKeyName: props.runtimeDatabaseEncryptionKeyName,
  controlPlaneEncryptionKeyName: props.controlPlaneEncryptionKeyName,
  apiConsumerDataEncryptionKeyName: props.apiConsumerDataEncryptionKeyName,
  apiConsumerDataLocation: props.apiConsumerDataLocation,
  portalDisabled: props.portalDisabled,
  addonsConfig: props.addonsConfig,
});

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: [
      "name",
      "organizationId",
      "project",
      "createdAt",
      "apigeeProjectId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.organizationId ?? output?.organizationId;
      const previousRegion = olds?.analyticsRegion ?? output?.analyticsRegion;
      const previousRuntime = olds?.runtimeType ?? output?.runtimeType;
      const previousBilling = olds?.billingType ?? output?.billingType;
      const nextId = news.organizationId ?? previousId;
      const nextRegion = news.analyticsRegion ?? previousRegion ?? env.region;
      const nextRuntime = news.runtimeType ?? DEFAULT_RUNTIME_TYPE;
      const nextBilling = news.billingType ?? DEFAULT_BILLING_TYPE;
      if (
        (previousId !== undefined && nextId !== previousId) ||
        (previousRegion !== undefined &&
          previousRegion.toLowerCase() !== nextRegion.toLowerCase()) ||
        (previousRuntime !== undefined && previousRuntime !== nextRuntime) ||
        (previousBilling !== undefined && previousBilling !== nextBilling)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId = toOrgId(
        env.project,
        olds?.organizationId,
        output?.organizationId,
      );
      const name = output?.name ?? orgName(organizationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* apigee
          .listOrganizations({ parent: "organizations" })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ organizations: [] }),
            ),
          );
        const mapped = (page.organizations ?? []).filter(
          (item) =>
            item.projectId === env.project ||
            (item.projectIds ?? []).includes(env.project),
        );
        const attrs = [];
        for (const mapping of mapped) {
          const organizationId = lastSegment(
            mapping.organization ?? env.project,
          );
          const existing = yield* getByName(orgName(organizationId));
          if (
            existing !== undefined &&
            hasOwnershipMarker(existing.description)
          ) {
            attrs.push(toAttrs(existing, env.project));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId = toOrgId(
        env.project,
        news.organizationId,
        output?.organizationId,
      );
      const name = orgName(organizationId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const analyticsRegion =
        news.analyticsRegion ?? output?.analyticsRegion ?? env.region;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizations({
            parent: `projects/${env.project}`,
            body: toBody(news, desiredDescription, analyticsRegion),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(operation, { budget: ORGANIZATION_BUDGET }),
            ),
            Effect.flatMap(() => getByName(name)),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationNotResolved({ name });
      }

      const desired = toBody(news, desiredDescription, analyticsRegion);
      const needsUpdate =
        (current.description ?? "") !== desiredDescription ||
        (current.displayName ?? "") !== (news.displayName ?? "") ||
        (current.disableVpcPeering === true) !==
          (desired.disableVpcPeering === true) ||
        (current.authorizedNetwork ?? "") !== (news.authorizedNetwork ?? "") ||
        (current.networkEgressRestricted === true) !==
          (news.networkEgressRestricted === true) ||
        (current.portalDisabled === true) !== (news.portalDisabled === true) ||
        (current.apiConsumerDataLocation ?? "") !==
          (news.apiConsumerDataLocation ?? "") ||
        !sameJson(current.addonsConfig ?? {}, news.addonsConfig ?? {});

      if (needsUpdate) {
        current = yield* apigee.updateOrganizations({
          name,
          body: {
            ...current,
            ...desired,
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizations({
          name: output.name,
          retention: "MINIMUM",
        })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, {
          notFoundOk: true,
          budget: ORGANIZATION_BUDGET,
        });
      }
    }),
  });
