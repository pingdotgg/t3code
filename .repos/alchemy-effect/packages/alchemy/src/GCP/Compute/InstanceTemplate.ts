import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
const MAX_NAME_LENGTH = 63;

export type InstanceTemplateAccessConfig = {
  /** Access config type. @default "ONE_TO_ONE_NAT" */
  type?: string;
  /** Access config name. */
  name?: string;
  /** Network tier (`PREMIUM` or `STANDARD`). */
  networkTier?: string;
  /** External IPv4 address. */
  natIP?: string;
};

export type InstanceTemplateNetworkInterface = {
  /**
   * VPC network URL or name.
   * @default "global/networks/default"
   */
  network?: string;
  /** Subnetwork URL. */
  subnetwork?: string;
  /** Internal IPv4 address. */
  networkIP?: string;
  /** NIC type (`GVNIC` or `VIRTIO_NET`). */
  nicType?: string;
  /** Stack type (`IPV4_ONLY` or `IPV4_IPV6`). */
  stackType?: string;
  /** External access configs. Omit for no external IP. */
  accessConfigs?: InstanceTemplateAccessConfig[];
};

export type InstanceTemplateDisk = {
  /** Whether this is the boot disk. */
  boot?: boolean;
  /** Delete the disk when the instance is deleted. */
  autoDelete?: boolean;
  /** Device name visible to the guest OS. */
  deviceName?: string;
  /** Disk type (`PERSISTENT` or `SCRATCH`). @default "PERSISTENT" */
  type?: string;
  /** Attach mode (`READ_WRITE` or `READ_ONLY`). */
  mode?: string;
  /** Disk interface (`SCSI` or `NVME`). */
  diskInterface?: string;
  /** Disk size in GB. */
  diskSizeGb?: string | number;
  /** Persistent disk type (`pd-standard`, `pd-balanced`, `pd-ssd`). */
  diskType?: string;
  /** Source image URL or family. */
  sourceImage?: string;
  /** Source snapshot URL. */
  sourceSnapshot?: string;
  /** Existing disk to attach (name for zonal, URL for regional). */
  source?: string;
  /** Disk resource name. */
  diskName?: string;
  /** Disk labels. */
  labels?: Record<string, string>;
};

export type InstanceTemplateServiceAccount = {
  /** Service account email. */
  email?: string;
  /** OAuth scopes granted to the service account. */
  scopes?: string[];
};

export type InstanceTemplateScheduling = {
  /** Restart the VM if Compute Engine terminates it. */
  automaticRestart?: boolean;
  /** Host maintenance behavior (`MIGRATE` or `TERMINATE`). */
  onHostMaintenance?: string;
  /** Whether the VM is preemptible. */
  preemptible?: boolean;
  /** Provisioning model (`STANDARD` or `SPOT`). */
  provisioningModel?: string;
};

export type InstanceTemplateProps = {
  /**
   * Template name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Must be 1-63 characters matching
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Changing it replaces the template.
   */
  templateName?: string;
  /**
   * Optional description. Changing it replaces the template.
   */
  description?: string;
  /**
   * Machine type name (not a URL), e.g. `e2-micro`. Instance templates are
   * immutable — changing this replaces the template.
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
  disks?: InstanceTemplateDisk[];
  /**
   * Network interfaces.
   * @default [{ network: "global/networks/default" }]
   */
  networkInterfaces?: InstanceTemplateNetworkInterface[];
  /**
   * Service accounts and scopes for created instances.
   */
  serviceAccounts?: InstanceTemplateServiceAccount[];
  /**
   * Scheduling options for created instances.
   */
  scheduling?: InstanceTemplateScheduling;
};

export type InstanceTemplate = Resource<
  "GCP.Compute.InstanceTemplate",
  InstanceTemplateProps,
  {
    /** Template name. */
    templateName: string;
    /** Project id. */
    project: string;
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
 * A global Compute Engine instance template.
 *
 * Instance templates are immutable. Changing machine type, disks, labels,
 * network interfaces, or other properties replaces the template. Use the
 * template to create VMs, managed instance groups, and reservations.
 *
 * ### Creating a Template
 * **Example:** Generated name with defaults
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {});
 * ```
 *
 * **Example:** Explicit machine type, disk, and labels
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {
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
 *   networkInterfaces: [{ network: "global/networks/default" }],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstanceTemplate = Resource<InstanceTemplate>(
  "GCP.Compute.InstanceTemplate",
);

export class InstanceTemplateNotResolved extends Data.TaggedError(
  "GCP.Compute.InstanceTemplateNotResolved",
)<{
  templateName: string;
}> {}

export class InstanceTemplateStillExists extends Data.TaggedError(
  "GCP.Compute.InstanceTemplateStillExists",
)<{
  templateName: string;
}> {}

const DEFAULT_DISKS: InstanceTemplateDisk[] = [
  {
    boot: true,
    autoDelete: true,
    type: "PERSISTENT",
    sourceImage: DEFAULT_SOURCE_IMAGE,
    diskSizeGb: DEFAULT_DISK_SIZE_GB,
  },
];

const DEFAULT_NICS: InstanceTemplateNetworkInterface[] = [
  { network: DEFAULT_NETWORK },
];

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const rfc1035Name = (name: string) => {
  let next = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "template";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035Name(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const sortedRecord = (
  labels: Record<string, string> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

const resolvedDisks = (props: InstanceTemplateProps) =>
  props.disks !== undefined && props.disks.length > 0
    ? props.disks
    : DEFAULT_DISKS;

const resolvedNics = (props: InstanceTemplateProps) =>
  props.networkInterfaces !== undefined && props.networkInterfaces.length > 0
    ? props.networkInterfaces
    : DEFAULT_NICS;

const fingerprint = (props: InstanceTemplateProps): string =>
  JSON.stringify({
    templateName: props.templateName ?? "",
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
  disk: InstanceTemplateDisk,
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

const toDisks = (disks: InstanceTemplateDisk[]): compute.AttachedDisk[] =>
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
  nics: InstanceTemplateNetworkInterface[],
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
  news: InstanceTemplateProps,
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

const toAttrs = (template: compute.InstanceTemplate, project: string) => ({
  templateName: template.name ?? "",
  project,
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

const getByName = (project: string, instanceTemplate: string) =>
  compute
    .getInstanceTemplates({ project, instanceTemplate })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilPresent = (project: string, templateName: string) =>
  getByName(project, templateName).pipe(
    Effect.flatMap((template) =>
      template !== undefined
        ? Effect.succeed(template)
        : Effect.fail(new InstanceTemplateNotResolved({ templateName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstanceTemplateNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.InstanceTemplateNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

const waitUntilGone = (project: string, templateName: string) =>
  getByName(project, templateName).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(new InstanceTemplateStillExists({ templateName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstanceTemplateStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.InstanceTemplateStillExists",
      () => Effect.void,
    ),
  );

export const InstanceTemplateProvider = () =>
  Provider.succeed(InstanceTemplate, {
    stables: [
      "templateName",
      "project",
      "templateId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.templateName ?? output?.templateName;
      const nextName = news.templateName ?? previousName;
      if (previousName === undefined && output === undefined) {
        return undefined;
      }
      const nameChanged =
        news.templateName !== undefined &&
        previousName !== undefined &&
        news.templateName !== previousName;
      const propsChanged =
        olds !== undefined && fingerprint(news) !== fingerprint(olds);
      const adoptedChanged =
        olds === undefined &&
        output !== undefined &&
        ((news.machineType ?? DEFAULT_MACHINE_TYPE) !==
          (output.machineType ?? DEFAULT_MACHINE_TYPE) ||
          (news.description ?? "") !== (output.description ?? "") ||
          (news.canIpForward === true) !== output.canIpForward ||
          JSON.stringify(sortedRecord(news.labels)) !==
            JSON.stringify(sortedRecord(output.labels)));
      if (!nameChanged && !propsChanged && !adoptedChanged) {
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
      const templateName = yield* toName(
        id,
        olds?.templateName,
        output?.templateName,
      );
      const existing = yield* getByName(env.project, templateName);
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
        return yield* compute.listInstanceTemplates
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((template) =>
              Object.keys(template.properties?.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((template) => toAttrs(template, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const templateName = yield* toName(
        id,
        news.templateName,
        output?.templateName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, templateName);

      if (current === undefined) {
        yield* compute
          .insertInstanceTemplates({
            project: env.project,
            body: {
              name: templateName,
              description: news.description,
              properties: toProperties(news, desiredLabels),
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* waitUntilPresent(env.project, templateName);
      }

      if (current === undefined) {
        return yield* new InstanceTemplateNotResolved({ templateName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteInstanceTemplates({
          project: env.project,
          instanceTemplate: output.templateName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation, {
          ignore: ["RESOURCE_NOT_FOUND"],
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitUntilGone(env.project, output.templateName);
    }),
  });
