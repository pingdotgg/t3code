import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
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
  ContactCenterNotResolved,
  DEFAULT_INSTANCE_SIZE,
  fingerprint,
  isTerminated,
  listOwnedContactCenters,
  locationParent,
  normalizeLocation,
  parseName,
  releaseChannelOf,
  replaceOnIdentity,
  retryTransient,
  sameBool,
  sameJson,
  sameText,
  toDomainPrefix,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

export type ContactCenterProps = {
  /**
   * Contact Center id (the `{contactCenter}` segment of
   * `projects/{project}/locations/{location}/contactCenters/{contactCenter}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the instance.
   */
  contactCenterId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * instance. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Required by the API; Alchemy falls back to
   * the generated contact center id.
   */
  displayName?: string;
  /**
   * Customer domain prefix (2–16 RFC1035 characters). Used as the
   * instance subdomain. Immutable — changing it replaces the instance.
   * If omitted, a unique prefix is generated.
   */
  customerDomainPrefix?: string;
  /**
   * Instance size (`DEV_SMALL`, `STANDARD_SMALL`, `TRIAL_SMALL`, …).
   * Immutable — changing it replaces the instance.
   * @default "DEV_SMALL"
   */
  instanceSize?: ccaip.InstanceConfigInstanceSizeEnum | (string & {});
  /**
   * Full instance configuration. Wins over `instanceSize` when set.
   * Immutable — changing it replaces the instance.
   */
  instanceConfig?: ccaip.InstanceConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Email of the first admin user.
   */
  userEmail?: string;
  /**
   * First admin given/family name.
   */
  adminUser?: ccaip.AdminUser;
  /**
   * Customer-managed KMS key that encrypts user input. Immutable —
   * changing it replaces the instance.
   */
  kmsKey?: string;
  /**
   * When true, users can be created in the CCAIP instance in addition to
   * Cloud Identity.
   * @default false
   */
  ccaipManagedUsers?: boolean;
  /**
   * SAML parameters that set up Google as IdP.
   */
  samlParams?: ccaip.SAMLParams;
  /**
   * Feature flags (for example agent desktop).
   */
  featureConfig?: ccaip.FeatureConfig;
  /**
   * VPC-SC private ingress/egress settings.
   */
  privateAccess?: ccaip.PrivateAccess;
  /**
   * Whether advanced reporting is enabled.
   * @default false
   */
  advancedReportingEnabled?: boolean;
  /**
   * Release channel. `early` is for test instances, `normal` lags early
   * by two days, `critical` only updates outside `critical.peakHours`.
   */
  releaseChannel?: "early" | "normal" | "critical";
  /**
   * Peak hours used when `releaseChannel` is `critical`.
   */
  critical?: ccaip.Critical;
};

export type ContactCenter = Resource<
  "GCP.ContactCenterAIPlatform.ContactCenter",
  ContactCenterProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/contactCenters/{contactCenter}`. */
    name: string;
    /** Contact Center id (last path segment). */
    contactCenterId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Customer domain prefix. */
    customerDomainPrefix: string | undefined;
    /** Instance size. */
    instanceSize: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** First admin email. */
    userEmail: string | undefined;
    /** First admin given/family name. */
    adminUser: ccaip.AdminUser | undefined;
    /** Customer-managed KMS key. */
    kmsKey: string | undefined;
    /** Whether CCAIP-managed users are enabled. */
    ccaipManagedUsers: boolean;
    /** SAML IdP parameters. */
    samlParams: ccaip.SAMLParams | undefined;
    /** Feature flags. */
    featureConfig: ccaip.FeatureConfig | undefined;
    /** Private networking settings. */
    privateAccess: ccaip.PrivateAccess | undefined;
    /** Whether advanced reporting is enabled. */
    advancedReportingEnabled: boolean;
    /** Release channel currently applied. */
    releaseChannel: "early" | "normal" | "critical" | undefined;
    /** Peak hours for the critical channel. */
    critical: ccaip.Critical | undefined;
    /** Server-reported state (`STATE_DEPLOYED`, …). */
    state: string | undefined;
    /** UJET release version. */
    releaseVersion: string | undefined;
    /** Access URIs for the deployed instance. */
    uris: ccaip.URIs | undefined;
    /** Private-path component names. */
    privateComponents: string[] | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 soft-delete timestamp. */
    deleteTime: string | undefined;
    /** RFC3339 expiry timestamp. */
    expireTime: string | undefined;
    /** RFC3339 hard-delete timestamp. */
    purgeTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Platform (CCAIP) instance.
 *
 * Create, update, and delete are long-running operations. Location,
 * contact center id, `customerDomainPrefix`, `instanceConfig`, and
 * `kmsKey` are immutable. Display name, labels, admin user, SAML, feature
 * flags, private access, advanced reporting, and release channel update
 * in place.
 *
 * Provisioning is entitlement-gated and typically takes several minutes.
 *
 * ### Creating a Contact Center
 * **Example:** Generated name
 * ```typescript
 * const center = yield* GCP.ContactCenterAIPlatform.ContactCenter("Support", {
 *   displayName: "support",
 *   instanceSize: "DEV_SMALL",
 * });
 * ```
 *
 * **Example:** Explicit id, domain prefix, and labels
 * ```typescript
 * const center = yield* GCP.ContactCenterAIPlatform.ContactCenter("Support", {
 *   contactCenterId: "support-desk",
 *   location: "us-central1",
 *   displayName: "Support desk",
 *   customerDomainPrefix: "supdesk",
 *   instanceSize: "DEV_SMALL",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Contact Center
 * **Example:** Display name and labels
 * ```typescript
 * const center = yield* GCP.ContactCenterAIPlatform.ContactCenter("Support", {
 *   customerDomainPrefix: "supdesk",
 *   displayName: "Support desk v2",
 *   labels: { env: "prod", team: "cx" },
 * });
 * ```
 *
 * @resource
 * @category ContactCenterAIPlatform
 */
export const ContactCenter = Resource<ContactCenter>(
  "GCP.ContactCenterAIPlatform.ContactCenter",
);

const resourceName = (
  project: string,
  location: string,
  contactCenterId: string,
) => `${locationParent(project, location)}/contactCenters/${contactCenterId}`;

const instanceConfigOf = (news: ContactCenterProps): ccaip.InstanceConfig =>
  news.instanceConfig ?? {
    instanceSize: news.instanceSize ?? DEFAULT_INSTANCE_SIZE,
  };

const channelBody = (news: ContactCenterProps) => {
  const channel =
    news.releaseChannel ??
    (news.critical !== undefined ? "critical" : undefined);
  return {
    early: channel === "early" ? {} : undefined,
    normal: channel === "normal" ? {} : undefined,
    critical: channel === "critical" ? (news.critical ?? {}) : news.critical,
  };
};

const toAttrs = (
  item: ccaip.ContactCenter,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    contactCenterId: parsed.id,
    location: parsed.location,
    project: parsed.project || project,
    displayName: item.displayName,
    customerDomainPrefix: item.customerDomainPrefix,
    instanceSize: item.instanceConfig?.instanceSize,
    labels: userLabels(item.labels),
    userEmail: item.userEmail,
    adminUser: item.adminUser,
    kmsKey: item.kmsKey,
    ccaipManagedUsers: item.ccaipManagedUsers === true,
    samlParams: item.samlParams,
    featureConfig: item.featureConfig,
    privateAccess: item.privateAccess,
    advancedReportingEnabled: item.advancedReportingEnabled === true,
    releaseChannel: releaseChannelOf(item),
    critical: item.critical,
    state: item.state,
    releaseVersion: item.releaseVersion,
    uris: item.uris,
    privateComponents: item.privateComponents,
    createTime: item.createTime,
    updateTime: item.updateTime,
    deleteTime: item.deleteTime,
    expireTime: item.expireTime,
    purgeTime: item.purgeTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ccaip
        .getProjectsLocationsContactCenters({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getLive = (name: string) =>
  getByName(name).pipe(
    Effect.map((item) =>
      item === undefined || isTerminated(item.state) ? undefined : item,
    ),
  );

export const ContactCenterProvider = () =>
  Provider.succeed(ContactCenter, {
    stables: [
      "name",
      "contactCenterId",
      "location",
      "project",
      "customerDomainPrefix",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousSize =
        olds?.instanceConfig?.instanceSize ??
        olds?.instanceSize ??
        output?.instanceSize;
      const nextSize = news.instanceConfig?.instanceSize ?? news.instanceSize;
      const previousPrefix =
        olds?.customerDomainPrefix ?? output?.customerDomainPrefix;
      const previousKms = olds?.kmsKey ?? output?.kmsKey;
      return replaceOnIdentity({
        previousId: olds?.contactCenterId ?? output?.contactCenterId,
        nextId: news.contactCenterId,
        previousLocation,
        nextLocation,
        extra:
          (previousPrefix !== undefined &&
            news.customerDomainPrefix !== undefined &&
            previousPrefix !== news.customerDomainPrefix) ||
          (previousSize !== undefined &&
            nextSize !== undefined &&
            previousSize !== nextSize) ||
          (previousKms !== undefined &&
            news.kmsKey !== undefined &&
            previousKms !== news.kmsKey) ||
          (olds?.instanceConfig !== undefined &&
            news.instanceConfig !== undefined &&
            fingerprint(olds.instanceConfig) !==
              fingerprint(news.instanceConfig)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const contactCenterId = yield* toPhysicalId(
        id,
        olds?.contactCenterId,
        output?.contactCenterId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, contactCenterId);
      const existing = yield* getLive(name);
      if (existing === undefined) {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items: ccaip.ContactCenter[] = yield* listOwnedContactCenters(
          env.project,
          env.region,
        );
        return items
          .filter((item) => !isTerminated(item.state))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const contactCenterId = yield* toPhysicalId(
        id,
        news.contactCenterId,
        output?.contactCenterId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, contactCenterId);
      const parent = locationParent(env.project, location);
      const customerDomainPrefix = yield* toDomainPrefix(
        news.customerDomainPrefix,
        output?.customerDomainPrefix,
        id,
      );
      const displayName = news.displayName ?? contactCenterId;
      const instanceConfig = instanceConfigOf(news);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const channel = channelBody(news);

      let current = yield* getLive(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ccaip.createProjectsLocationsContactCenters({
            parent,
            contactCenterId,
            body: {
              displayName,
              customerDomainPrefix,
              instanceConfig,
              labels: desiredLabels,
              userEmail: news.userEmail,
              adminUser: news.adminUser,
              kmsKey: news.kmsKey,
              ccaipManagedUsers: news.ccaipManagedUsers,
              samlParams: news.samlParams,
              featureConfig: news.featureConfig,
              privateAccess: news.privateAccess,
              advancedReportingEnabled: news.advancedReportingEnabled,
              early: channel.early,
              normal: channel.normal,
              critical: channel.critical,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getLive(name), name);
      }

      if (current === undefined) {
        return yield* new ContactCenterNotResolved({ name });
      }

      const currentName = current.name ?? name;
      let live: ccaip.ContactCenter = yield* waitUntilReady(
        getLive(currentName),
        currentName,
        (item) => item.state,
      ).pipe(
        Effect.catchIf(
          (error) =>
            error._tag === "GCP.ContactCenterAIPlatform.ContactCenterNotReady",
          () => waitUntilExists(getLive(currentName), currentName),
        ),
      );

      const observedLabels = tagRecord(live.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(live.displayName, displayName);
      const emailChanged = !sameText(live.userEmail, news.userEmail);
      const adminChanged = !sameJson(live.adminUser, news.adminUser);
      const managedChanged = !sameBool(
        live.ccaipManagedUsers,
        news.ccaipManagedUsers,
      );
      const samlChanged =
        news.samlParams !== undefined &&
        !sameJson(live.samlParams, news.samlParams);
      const featureChanged =
        news.featureConfig !== undefined &&
        !sameJson(live.featureConfig, news.featureConfig);
      const privateChanged =
        news.privateAccess !== undefined &&
        !sameJson(live.privateAccess, news.privateAccess);
      const reportingChanged = !sameBool(
        live.advancedReportingEnabled,
        news.advancedReportingEnabled,
      );
      const desiredChannel =
        news.releaseChannel ??
        (news.critical !== undefined ? "critical" : undefined);
      const channelChanged =
        desiredChannel !== undefined &&
        releaseChannelOf(live) !== desiredChannel;
      const criticalChanged =
        news.critical !== undefined && !sameJson(live.critical, news.critical);

      const mask = updateMaskOf(
        labelsChanged && "labels",
        displayChanged && "displayName",
        emailChanged && "userEmail",
        adminChanged && "adminUser",
        managedChanged && "ccaipManagedUsers",
        samlChanged && "samlParams",
        featureChanged && "featureConfig",
        privateChanged && "privateAccess",
        reportingChanged && "advancedReportingEnabled",
        channelChanged && desiredChannel === "early" && "early",
        channelChanged && desiredChannel === "normal" && "normal",
        (channelChanged && desiredChannel === "critical") || criticalChanged
          ? "critical"
          : undefined,
      );

      if (mask.length > 0) {
        const patched = yield* retryTransient(
          ccaip.patchProjectsLocationsContactCenters({
            name: currentName,
            updateMask: mask,
            body: {
              labels: desiredLabels,
              displayName,
              userEmail: news.userEmail,
              adminUser: news.adminUser,
              ccaipManagedUsers: news.ccaipManagedUsers,
              samlParams: news.samlParams,
              featureConfig: news.featureConfig,
              privateAccess: news.privateAccess,
              advancedReportingEnabled: news.advancedReportingEnabled,
              early: channel.early,
              normal: channel.normal,
              critical: channel.critical,
            },
          }),
        ).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
        yield* waitForOperation(patched);
        live = yield* waitUntilExists(getLive(currentName), currentName);
      }

      return toAttrs(live, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const deleted = yield* retryTransient(
        ccaip.deleteProjectsLocationsContactCenters({ name: output.name }),
      ).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
      if (deleted !== undefined) {
        yield* waitForDeleteOperation(deleted);
      }
      yield* waitUntilGone(getLive(output.name), output.name);
    }),
  });

export { ContactCenterFailed, ContactCenterNotResolved } from "./internal.ts";
