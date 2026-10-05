import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  lastSegment,
  normalizeRegion,
  runRegionOp,
  sameJson,
  toPhysicalName,
} from "./internal.ts";
import type {
  InstanceTemplateAccessConfig,
  InstanceTemplateDisk,
  InstanceTemplateNetworkInterface,
  InstanceTemplateScheduling,
  InstanceTemplateServiceAccount,
} from "./InstanceTemplate.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_MACHINE_TYPE = "e2-micro";
const DEFAULT_SOURCE_IMAGE =
  "projects/debian-cloud/global/images/family/debian-12";
const DEFAULT_DISK_SIZE_GB = "10";
const DEFAULT_NETWORK = "global/networks/default";

export type RegionInstanceTemplateAccessConfig = InstanceTemplateAccessConfig;
export type RegionInstanceTemplateDisk = InstanceTemplateDisk;
export type RegionInstanceTemplateNetworkInterface =
  InstanceTemplateNetworkInterface;
export type RegionInstanceTemplateServiceAccount =
  InstanceTemplateServiceAccount;
export type RegionInstanceTemplateScheduling = InstanceTemplateScheduling;

export type RegionInstanceTemplateProps = {
  /**
   * Template name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Changing it replaces the template.
   */
  templateName?: string;
  /**
   * Region the template lives in. Immutable — changing it replaces the
   * template. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Changing it replaces the template.
   */
  description?: string;
  /**
   * Machine type name (not a URL), e.g. `e2-micro`. Regional instance
   * templates are immutable — changing this replaces the template.
   * @default "e2-micro"
   */
  machineType?: string;
  /**
   * Allow sending/receiving packets with non-instance IPs.
   * @default false
   */
  canIpForward?: boolean;
  /**
   * Labels applied to instances created from this template. Alchemy
   * ownership labels are merged in automatically. Changing labels replaces
   * the template (no in-place update API).
   */
  labels?: Record<string, string>;
  /**
   * Network tags applied to instances created from this template.
   */
  networkTags?: string[];
  /**
   * Instance metadata key/value pairs.
   */
  metadata?: Record<string, string>;
  /**
   * Attached disks. If omitted, a 10 GB Debian 12 boot disk is used.
   */
  disks?: RegionInstanceTemplateDisk[];
  /**
   * Network interfaces.
   * @default [{ network: "global/networks/default" }]
   */
  networkInterfaces?: RegionInstanceTemplateNetworkInterface[];
  /**
   * Service accounts and scopes for created instances.
   */
  serviceAccounts?: RegionInstanceTemplateServiceAccount[];
  /**
   * Scheduling options for created instances.
   */
  scheduling?: RegionInstanceTemplateScheduling;
};

export type RegionInstanceTemplate = Resource<
  "GCP.Compute.RegionInstanceTemplate",
  RegionInstanceTemplateProps,
  {
    /** Template name. */
    templateName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Description. */
    description: string | undefined;
    /** Machine type name. */
    machineType: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Network tags. */
    networkTags: string[];
    /** Whether IP forwarding is enabled. */
    canIpForward: boolean;
    /** Boot-disk source image, if set. */
    sourceImage: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    templateId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine instance template.
 *
 * Regional instance templates are immutable. Changing machine type, disks,
 * labels, network interfaces, or other properties replaces the template.
 * Use the template to create regional managed instance groups.
 *
 * ### Creating a Regional Template
 * **Example:** Generated name with defaults
 * ```typescript
 * const template = yield* GCP.Compute.RegionInstanceTemplate("web", {});
 * ```
 *
 * **Example:** Explicit machine type, disk, and labels
 * ```typescript
 * const template = yield* GCP.Compute.RegionInstanceTemplate("web", {
 *   region: "us-central1",
 *   machineType: "e2-micro",
 *   labels: { env: "prod" },
 *   disks: [
 *     {
 *       boot: true,
 *       autoDelete: true,
 *       sourceImage:
 *         "projects/debian-cloud/global/images/family/debian-12",
 *       diskSizeGb: 10,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionInstanceTemplate = Resource<RegionInstanceTemplate>(
  "GCP.Compute.RegionInstanceTemplate",
);

export class RegionInstanceTemplateNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionInstanceTemplateNotResolved",
)<{
  templateName: string;
  region: string;
}> {}

const DEFAULT_DISKS: RegionInstanceTemplateDisk[] = [
  {
    boot: true,
    autoDelete: true,
    type: "PERSISTENT",
    sourceImage: DEFAULT_SOURCE_IMAGE,
    diskSizeGb: DEFAULT_DISK_SIZE_GB,
  },
];

const DEFAULT_NICS: RegionInstanceTemplateNetworkInterface[] = [
  { network: DEFAULT_NETWORK },
];

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const sortedRecord = (
  labels: Record<string, string> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

const resolvedDisks = (props: RegionInstanceTemplateProps) =>
  props.disks !== undefined && props.disks.length > 0
    ? props.disks
    : DEFAULT_DISKS;

const resolvedNics = (props: RegionInstanceTemplateProps) =>
  props.networkInterfaces !== undefined && props.networkInterfaces.length > 0
    ? props.networkInterfaces
    : DEFAULT_NICS;

const fingerprint = (props: RegionInstanceTemplateProps): string =>
  JSON.stringify({
    templateName: props.templateName ?? "",
    region: props.region ? lastSegment(props.region).toLowerCase() : "",
    description: props.description ?? "",
    machineType: props.machineType ?? DEFAULT_MACHINE_TYPE,
    canIpForward: props.canIpForward === true,
    labels: sortedRecord(props.labels),
    networkTags: [...(props.networkTags ?? [])].sort(),
    metadata: sortedRecord(props.metadata),
    disks: resolvedDisks(props).map((disk) => ({
      boot: disk.boot === true,
      autoDelete: disk.autoDelete,
      deviceName: disk.deviceName ?? "",
      type: disk.type ?? "",
      mode: disk.mode ?? "",
      diskInterface: disk.diskInterface ?? "",
      diskSizeGb: disk.diskSizeGb !== undefined ? String(disk.diskSizeGb) : "",
      diskType: disk.diskType ?? "",
      sourceImage: disk.sourceImage ?? "",
      sourceSnapshot: disk.sourceSnapshot ?? "",
      source: disk.source ?? "",
      diskName: disk.diskName ?? "",
      labels: sortedRecord(disk.labels),
    })),
    networkInterfaces: resolvedNics(props).map((nic) => ({
      network: nic.network ?? "",
      subnetwork: nic.subnetwork ?? "",
      networkIP: nic.networkIP ?? "",
      nicType: nic.nicType ?? "",
      stackType: nic.stackType ?? "",
      accessConfigs: nic.accessConfigs ?? [],
    })),
    serviceAccounts: props.serviceAccounts ?? [],
    scheduling: props.scheduling ?? {},
  });

const initializeParamsOf = (
  disk: RegionInstanceTemplateDisk,
): compute.AttachedDiskInitializeParams | undefined => {
  if (
    disk.sourceImage === undefined &&
    disk.sourceSnapshot === undefined &&
    disk.diskType === undefined &&
    disk.diskName === undefined &&
    disk.labels === undefined &&
    disk.diskSizeGb === undefined
  ) {
    return undefined;
  }
  return {
    sourceImage: disk.sourceImage,
    sourceSnapshot: disk.sourceSnapshot,
    diskType: disk.diskType,
    diskName: disk.diskName,
    labels: disk.labels,
    diskSizeGb:
      disk.diskSizeGb !== undefined ? String(disk.diskSizeGb) : undefined,
  };
};

const toDisks = (disks: RegionInstanceTemplateDisk[]): compute.AttachedDisk[] =>
  disks.map((disk) => ({
    boot: disk.boot,
    autoDelete: disk.autoDelete,
    deviceName: disk.deviceName,
    type: disk.type,
    mode: disk.mode,
    interface: disk.diskInterface,
    source: disk.source,
    initializeParams: disk.source ? undefined : initializeParamsOf(disk),
  }));

const toNics = (
  nics: RegionInstanceTemplateNetworkInterface[],
): compute.NetworkInterface[] =>
  nics.map((nic) => ({
    network: nic.network,
    subnetwork: nic.subnetwork,
    networkIP: nic.networkIP,
    nicType: nic.nicType,
    stackType: nic.stackType,
    accessConfigs: nic.accessConfigs,
  }));

const toProperties = (
  news: RegionInstanceTemplateProps,
  labels: Record<string, string>,
): compute.InstanceProperties => ({
  machineType: news.machineType ?? DEFAULT_MACHINE_TYPE,
  canIpForward: news.canIpForward,
  labels,
  tags:
    news.networkTags !== undefined ? { items: news.networkTags } : undefined,
  metadata:
    news.metadata !== undefined
      ? {
          items: Object.entries(news.metadata).map(([key, value]) => ({
            key,
            value,
          })),
        }
      : undefined,
  disks: toDisks(resolvedDisks(news)),
  networkInterfaces: toNics(resolvedNics(news)),
  serviceAccounts: news.serviceAccounts,
  scheduling: news.scheduling,
});

const bootSourceImage = (template: compute.InstanceTemplate) => {
  const boot = (template.properties?.disks ?? []).find(
    (disk) => disk.boot === true,
  );
  return boot?.initializeParams?.sourceImage;
};

const toAttrs = (
  template: compute.InstanceTemplate,
  project: string,
): RegionInstanceTemplate["Attributes"] => ({
  templateName: template.name ?? lastSegment(template.selfLink),
  project,
  region: lastSegment(template.region).toLowerCase(),
  description: template.description,
  machineType: template.properties?.machineType,
  labels: userLabels(template.properties?.labels),
  networkTags: template.properties?.tags?.items ?? [],
  canIpForward: template.properties?.canIpForward === true,
  sourceImage: bootSourceImage(template),
  selfLink: template.selfLink,
  templateId: template.id,
  creationTimestamp: template.creationTimestamp,
});

const getByName = (project: string, region: string, instanceTemplate: string) =>
  compute
    .getRegionInstanceTemplates({ project, region, instanceTemplate })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, templateName: string) =>
  getByName(project, region, templateName).pipe(
    Effect.flatMap((template) =>
      template !== undefined
        ? Effect.succeed(template)
        : Effect.fail(
            new RegionInstanceTemplateNotResolved({ templateName, region }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionInstanceTemplateNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RegionInstanceTemplateProvider = () =>
  Provider.succeed(RegionInstanceTemplate, {
    stables: [
      "templateName",
      "project",
      "region",
      "templateId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.templateName ?? output?.templateName;
      const nextName = news.templateName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      if (previousName === undefined && output === undefined) {
        return undefined;
      }
      const nameChanged =
        news.templateName !== undefined &&
        previousName !== undefined &&
        news.templateName !== previousName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const propsChanged =
        olds !== undefined && fingerprint(news) !== fingerprint(olds);
      const adoptedChanged =
        olds === undefined &&
        output !== undefined &&
        ((news.machineType ?? DEFAULT_MACHINE_TYPE) !==
          (output.machineType ?? DEFAULT_MACHINE_TYPE) ||
          (news.description ?? "") !== (output.description ?? "") ||
          (news.canIpForward === true) !== output.canIpForward ||
          !sameJson(sortedRecord(news.labels), sortedRecord(output.labels)));
      if (!nameChanged && !regionChanged && !propsChanged && !adoptedChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const templateName = yield* toPhysicalName(
        id,
        olds?.templateName,
        output?.templateName,
        "template",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, templateName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.properties?.labels),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstanceTemplates
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
          );
        return Array.from(
          pages as readonly compute.InstanceTemplateAggregatedList[],
        ).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("regions/")) return [];
            return (scoped?.instanceTemplates ?? [])
              .filter((template) =>
                Object.keys(template.properties?.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((template) => toAttrs(template, env.project));
          }),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const templateName = yield* toPhysicalName(
        id,
        news.templateName,
        output?.templateName,
        "template",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, templateName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionInstanceTemplates({
            project: env.project,
            region,
            body: {
              name: templateName,
              description: news.description,
              properties: toProperties(news, desiredLabels),
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, templateName);
      }

      if (current === undefined) {
        return yield* new RegionInstanceTemplateNotResolved({
          templateName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionInstanceTemplates({
          project: env.project,
          region,
          instanceTemplate: output.templateName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
