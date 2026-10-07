import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  sameJson,
  sameStringList,
  toResourceId,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseOwnership,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 32;

export type AccessLoggingConfig = {
  /**
   * Whether access logging is enabled for this instance.
   * @default false
   */
  enabled?: boolean;
  /**
   * CEL filter on `status_code` (for example
   * `status_code >= 200 && status_code < 300`).
   */
  filter?: string;
};

export type MaintenanceWindow = {
  /**
   * Preferred day of week for maintenance.
   */
  day?:
    | apigee.GoogleCloudApigeeV1MaintenanceUpdatePolicyMaintenanceWindowDayEnum
    | (string & {});
  /**
   * UTC start time of the window.
   */
  startTime?: {
    hours?: number;
    minutes?: number;
    seconds?: number;
    nanos?: number;
  };
};

export type MaintenanceUpdatePolicy = {
  /**
   * Preferred maintenance windows. The API currently accepts at most one.
   */
  maintenanceWindows?: MaintenanceWindow[];
  /**
   * Relative scheduling channel (`WEEK1` or `WEEK2`).
   */
  maintenanceChannel?:
    | apigee.GoogleCloudApigeeV1MaintenanceUpdatePolicyMaintenanceChannelEnum
    | (string & {});
};

export type InstanceProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the instance.
   */
  organization?: string;
  /**
   * Instance id (the `{instance}` segment of
   * `organizations/{org}/instances/{instance}`). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * 2–32 characters, lowercase letters, digits, and hyphens; must start
   * with a letter. Immutable — changing it replaces the instance.
   */
  instanceId?: string;
  /**
   * Compute Engine location where the instance resides (region, for
   * example `us-central1`). Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. Apigee instances have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Display name for the instance.
   */
  displayName?: string;
  /**
   * Size of the CIDR block reserved by the instance. Paid orgs support
   * `SLASH_16`–`SLASH_20` (default `SLASH_16`); evaluation orgs support
   * only `SLASH_23`. Immutable.
   */
  peeringCidrRange?:
    | apigee.GoogleCloudApigeeV1InstancePeeringCidrRangeEnum
    | (string & {});
  /**
   * Comma-separated `/22` and/or `/28` CIDR blocks used to create the
   * instance. Immutable. Omit to let Apigee allocate ranges from Service
   * Networking.
   */
  ipRange?: string;
  /**
   * Customer-managed encryption key for disk and volume encryption
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable. Omit for a Google-managed key.
   */
  diskEncryptionKeyName?: string;
  /**
   * Projects (id or number) allowed to privately connect to the service
   * attachment. The Apigee org project is always included.
   */
  consumerAcceptList?: string[];
  /**
   * Access logging configuration. Disabled by default.
   */
  accessLoggingConfig?: AccessLoggingConfig;
  /**
   * Preferred maintenance window.
   */
  maintenanceUpdatePolicy?: MaintenanceUpdatePolicy;
};

export type Instance = Resource<
  "GCP.Apigee.Instance",
  InstanceProps,
  {
    /** Full resource name `organizations/{org}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Apigee organization id. */
    organization: string;
    /** Compute Engine location. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Peering CIDR range size. */
    peeringCidrRange: string | undefined;
    /** Configured IP ranges. */
    ipRange: string | undefined;
    /** CMEK resource name, if any. */
    diskEncryptionKeyName: string | undefined;
    /** Consumer accept list. */
    consumerAcceptList: string[];
    /** Access logging configuration. */
    accessLoggingConfig: AccessLoggingConfig | undefined;
    /** Maintenance update policy. */
    maintenanceUpdatePolicy: MaintenanceUpdatePolicy | undefined;
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** Runtime system version. */
    runtimeVersion: string | undefined;
    /** Exposed Apigee endpoint hostname. */
    host: string | undefined;
    /** Exposed Apigee endpoint port. */
    port: string | undefined;
    /** PSC service attachment resource name. */
    serviceAttachment: string | undefined;
    /** Whether the instance is version-locked. */
    isVersionLocked: boolean | undefined;
    /** Scheduled maintenance start time, if any. */
    scheduledMaintenance: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee runtime instance.
 *
 * Apigee instances have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name, organization, location,
 * peering CIDR, IP range, and CMEK are identity — changing them replaces
 * the instance. Description, display name, consumer accept list, access
 * logging, and maintenance policy update in place.
 *
 * Provisioning typically takes 20–40 minutes. Live lifecycle tests are
 * skipIf-gated (`GCP_TEST_APIGEE_INSTANCE`).
 *
 * ### Creating an Instance
 * **Example:** Generated name in us-central1
 * ```typescript
 * const runtime = yield* GCP.Apigee.Instance("Runtime", {});
 * ```
 *
 * **Example:** Explicit id, description, and access logging
 * ```typescript
 * const runtime = yield* GCP.Apigee.Instance("Runtime", {
 *   instanceId: "app-runtime",
 *   location: "us-central1",
 *   description: "production runtime",
 *   accessLoggingConfig: {
 *     enabled: true,
 *     filter: "status_code >= 400",
 *   },
 * });
 * ```
 *
 * ### Updating an Instance
 * **Example:** Change display name and maintenance window
 * ```typescript
 * const runtime = yield* GCP.Apigee.Instance("Runtime", {
 *   displayName: "app-runtime-prod",
 *   maintenanceUpdatePolicy: {
 *     maintenanceWindows: [{
 *       day: "SUNDAY",
 *       startTime: { hours: 2, minutes: 0 },
 *     }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Instance = Resource<Instance>("GCP.Apigee.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Apigee.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Apigee.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Apigee.InstanceStillExists",
)<{
  name: string;
}> {}

const resourceName = (organization: string, instanceId: string) =>
  `${orgParent(organization)}/instances/${instanceId}`;

const instanceIdOf = (instance: apigee.GoogleCloudApigeeV1Instance) =>
  lastSegment(instance.name ?? "");

const locationOf = (location: string | undefined, defaultLocation: string) =>
  (location ?? defaultLocation).toLowerCase();

const accessLoggingOf = (
  config:
    | apigee.GoogleCloudApigeeV1AccessLoggingConfig
    | AccessLoggingConfig
    | undefined,
): AccessLoggingConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    enabled: config.enabled === true,
    filter: config.filter,
  };
};

const maintenanceOf = (
  policy:
    | apigee.GoogleCloudApigeeV1MaintenanceUpdatePolicy
    | MaintenanceUpdatePolicy
    | undefined,
): MaintenanceUpdatePolicy | undefined => {
  if (policy === undefined) return undefined;
  return {
    maintenanceChannel: policy.maintenanceChannel,
    maintenanceWindows: policy.maintenanceWindows?.map((window) => ({
      day: window.day,
      startTime: window.startTime
        ? {
            hours: window.startTime.hours,
            minutes: window.startTime.minutes,
            seconds: window.startTime.seconds,
            nanos: window.startTime.nanos,
          }
        : undefined,
    })),
  };
};

const toAttrs = (
  instance: apigee.GoogleCloudApigeeV1Instance,
  organization: string,
  region: string,
) => {
  const instanceId = instanceIdOf(instance);
  const parsed = parseOwnership(instance.description);
  const name = instance.name?.includes("/")
    ? instance.name
    : resourceName(organization, instanceId);
  return {
    name,
    instanceId,
    organization: organizationFromName(name) ?? organization,
    location: instance.location ?? region,
    description: parsed.text,
    displayName: instance.displayName,
    peeringCidrRange: instance.peeringCidrRange,
    ipRange: instance.ipRange,
    diskEncryptionKeyName: instance.diskEncryptionKeyName,
    consumerAcceptList: [...(instance.consumerAcceptList ?? [])],
    accessLoggingConfig: accessLoggingOf(instance.accessLoggingConfig),
    maintenanceUpdatePolicy: maintenanceOf(instance.maintenanceUpdatePolicy),
    state: instance.state,
    runtimeVersion: instance.runtimeVersion,
    host: instance.host,
    port: instance.port,
    serviceAttachment: instance.serviceAttachment,
    isVersionLocked: instance.isVersionLocked,
    scheduledMaintenance: instance.scheduledMaintenance?.startTime,
    createdAt: instance.createdAt,
    lastModifiedAt: instance.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsInstances({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

/** Instance provisioning and deletion take 30–60 minutes. */
const INSTANCE_BUDGET = "75 minutes";

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Apigee.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilActive = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is apigee.GoogleCloudApigeeV1Instance =>
        instance !== undefined,
      () => new InstanceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (instance) => (instance.state ?? "STATE_UNSPECIFIED") === "ACTIVE",
      (instance) =>
        new InstanceNotReady({
          name,
          state: instance.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Apigee.InstanceNotReady" ||
        error._tag === "GCP.Apigee.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(new InstanceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Apigee.InstanceStillExists",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const toBody = (
  news: InstanceProps,
  instanceId: string,
  description: string,
  location: string,
): apigee.GoogleCloudApigeeV1Instance => ({
  name: instanceId,
  location,
  description,
  displayName: news.displayName,
  peeringCidrRange: news.peeringCidrRange,
  ipRange: news.ipRange,
  diskEncryptionKeyName: news.diskEncryptionKeyName,
  consumerAcceptList: news.consumerAcceptList,
  accessLoggingConfig: news.accessLoggingConfig
    ? {
        enabled: news.accessLoggingConfig.enabled === true,
        filter: news.accessLoggingConfig.filter,
      }
    : undefined,
  maintenanceUpdatePolicy: news.maintenanceUpdatePolicy
    ? {
        maintenanceChannel: news.maintenanceUpdatePolicy.maintenanceChannel,
        maintenanceWindows: news.maintenanceUpdatePolicy.maintenanceWindows,
      }
    : undefined,
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "organization", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.instanceId ?? output?.instanceId;
      const previousOrg = olds?.organization ?? output?.organization;
      const previousLocation = olds?.location ?? output?.location;
      const previousPeering =
        olds?.peeringCidrRange ?? output?.peeringCidrRange;
      const previousIpRange = olds?.ipRange ?? output?.ipRange;
      const previousCmek =
        olds?.diskEncryptionKeyName ?? output?.diskEncryptionKeyName;
      if (
        (previousId !== undefined &&
          news.instanceId !== undefined &&
          news.instanceId !== previousId) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg) ||
        (previousLocation !== undefined &&
          news.location !== undefined &&
          news.location.toLowerCase() !== previousLocation.toLowerCase()) ||
        (news.peeringCidrRange !== undefined &&
          previousPeering !== undefined &&
          news.peeringCidrRange !== previousPeering) ||
        (news.ipRange !== undefined &&
          previousIpRange !== undefined &&
          news.ipRange !== previousIpRange) ||
        (news.diskEncryptionKeyName !== undefined &&
          previousCmek !== undefined &&
          news.diskEncryptionKeyName !== previousCmek)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const instanceId = yield* toResourceId(
        id,
        olds?.instanceId,
        output?.instanceId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organization, instanceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apigee.listOrganizationsInstances
          .pages({
            parent: orgParent(env.project),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
            Stream.filter((instance) =>
              hasOwnershipMarker(instance.description),
            ),
            Stream.map((instance) =>
              toAttrs(instance, env.project, env.region),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as Instance["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const instanceId = yield* toResourceId(
        id,
        news.instanceId,
        output?.instanceId,
        MAX_NAME_LENGTH,
      );
      const location = locationOf(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(organization, instanceId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && (current.state ?? "") === "DELETING") {
        yield* waitUntilGone(current.name?.includes("/") ? current.name : name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsInstances({
            parent: orgParent(organization),
            body: toBody(news, instanceId, desiredDescription, location),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, {
            alreadyExistsOk: true,
            budget: INSTANCE_BUDGET,
          });
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({ name });
      }

      if ((current.state ?? "") === "CREATING") {
        current = (yield* waitUntilActive(name)) ?? current;
      }

      const desiredLogging = accessLoggingOf(news.accessLoggingConfig);
      const desiredMaintenance = maintenanceOf(news.maintenanceUpdatePolicy);
      const desiredAccept = news.consumerAcceptList;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const loggingChanged = !sameJson(
        accessLoggingOf(current.accessLoggingConfig),
        desiredLogging,
      );
      const maintenanceChanged = !sameJson(
        maintenanceOf(current.maintenanceUpdatePolicy),
        desiredMaintenance,
      );
      const acceptChanged =
        desiredAccept !== undefined &&
        !sameStringList(current.consumerAcceptList, desiredAccept);

      const updateMask = [
        descriptionChanged ? "description" : undefined,
        displayChanged ? "displayName" : undefined,
        loggingChanged ? "accessLoggingConfig" : undefined,
        maintenanceChanged ? "maintenanceUpdatePolicy" : undefined,
        acceptChanged ? "consumerAcceptList" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const patched = yield* apigee.patchOrganizationsInstances({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: {
            description: desiredDescription,
            displayName: news.displayName,
            accessLoggingConfig: news.accessLoggingConfig
              ? {
                  enabled: news.accessLoggingConfig.enabled === true,
                  filter: news.accessLoggingConfig.filter,
                }
              : undefined,
            maintenanceUpdatePolicy: news.maintenanceUpdatePolicy
              ? {
                  maintenanceChannel:
                    news.maintenanceUpdatePolicy.maintenanceChannel,
                  maintenanceWindows:
                    news.maintenanceUpdatePolicy.maintenanceWindows,
                }
              : undefined,
            consumerAcceptList: desiredAccept,
          },
        });
        yield* waitForOperation(patched, { budget: INSTANCE_BUDGET });
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, organization, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* apigee
        .deleteOrganizationsInstances({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, {
          notFoundOk: true,
          budget: INSTANCE_BUDGET,
        });
      }
      yield* waitUntilGone(output.name);
    }),
  });
