import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
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
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AwsSourceDetails = vm.AwsSourceDetails;
export type AzureSourceDetails = vm.AzureSourceDetails;
export type VmwareSourceDetails = vm.VmwareSourceDetails;
export type Encryption = vm.Encryption;

export type SourceProps = {
  /**
   * Source id (the `{source}` segment of
   * `projects/{project}/locations/{location}/sources/{source}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the source.
   */
  sourceId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * source. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User-provided description of the source.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Encryption of source data stored by the service. Immutable —
   * changing it replaces the source.
   */
  encryption?: Encryption;
  /**
   * AWS source environment. Mutually exclusive with `azure` and
   * `vmware`. Switching source kinds replaces the source.
   */
  aws?: AwsSourceDetails;
  /**
   * Azure source environment. Mutually exclusive with `aws` and
   * `vmware`. Switching source kinds replaces the source.
   */
  azure?: AzureSourceDetails;
  /**
   * VMware vCenter source environment. Mutually exclusive with `aws`
   * and `azure`. Switching source kinds replaces the source.
   */
  vmware?: VmwareSourceDetails;
};

export type Source = Resource<
  "GCP.VMMigration.Source",
  SourceProps,
  {
    /** Full resource name. */
    name: string;
    /** Source id (last path segment). */
    sourceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Encryption of stored source data. */
    encryption: Encryption | undefined;
    /** AWS source details as reported by the API. */
    aws: AwsSourceDetails | undefined;
    /** Azure source details as reported by the API. */
    azure: AzureSourceDetails | undefined;
    /** VMware source details as reported by the API. */
    vmware: VmwareSourceDetails | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration source environment (AWS, Azure, or VMware vCenter)
 * that inventories VMs and disks for migration.
 *
 * `sourceId`, `location`, `encryption`, and the source kind
 * (`aws` / `azure` / `vmware`) plus immutable region/subscription
 * fields are replacement triggers. Description, labels, and credential
 * fields update in place.
 *
 * ### Creating a Source
 * **Example:** AWS source
 * ```typescript
 * const source = yield* GCP.VMMigration.Source("Aws", {
 *   aws: {
 *     awsRegion: "us-east-1",
 *     accessKeyCreds: {
 *       accessKeyId: process.env.AWS_ACCESS_KEY_ID,
 *       secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
 *     },
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** VMware source
 * ```typescript
 * const source = yield* GCP.VMMigration.Source("Vcenter", {
 *   vmware: {
 *     vcenterIp: "10.0.0.4",
 *     username: "admin",
 *     password: process.env.VCENTER_PASSWORD,
 *     thumbprint: process.env.VCENTER_THUMBPRINT,
 *   },
 * });
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const Source = Resource<Source>("GCP.VMMigration.Source");

const resourceName = (project: string, location: string, sourceId: string) =>
  `${locationParent(project, location)}/sources/${sourceId}`;

const kindOf = (value: { aws?: unknown; azure?: unknown; vmware?: unknown }) =>
  value.aws ? "aws" : value.azure ? "azure" : value.vmware ? "vmware" : "";

const toAttrs = (source: vm.Source, project: string, region: string) => {
  const name = source.name ?? "";
  const parsed = parseName(name, "sources", region);
  return {
    name,
    sourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: source.description,
    labels: userLabels(source.labels),
    encryption: source.encryption,
    aws: source.aws,
    azure: source.azure,
    vmware: source.vmware,
    createTime: source.createTime,
    updateTime: source.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsSources({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  vm.listProjectsLocationsSources
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sources ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        vm.listProjectsLocationsSources
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sources ?? [])),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as vm.Source[]),
            ),
          ),
      ),
    );

const publicAws = (aws: AwsSourceDetails | undefined) =>
  aws === undefined
    ? undefined
    : {
        awsRegion: aws.awsRegion,
        inventorySecurityGroupNames: aws.inventorySecurityGroupNames,
        inventoryTagList: aws.inventoryTagList,
        migrationResourcesUserTags: aws.migrationResourcesUserTags,
        accessKeyCreds: aws.accessKeyCreds
          ? { accessKeyId: aws.accessKeyCreds.accessKeyId }
          : undefined,
      };

const publicAzure = (azure: AzureSourceDetails | undefined) =>
  azure === undefined
    ? undefined
    : {
        azureLocation: azure.azureLocation,
        subscriptionId: azure.subscriptionId,
        migrationResourcesUserTags: azure.migrationResourcesUserTags,
        clientSecretCreds: azure.clientSecretCreds
          ? {
              tenantId: azure.clientSecretCreds.tenantId,
              clientId: azure.clientSecretCreds.clientId,
            }
          : undefined,
      };

const publicVmware = (vmware: VmwareSourceDetails | undefined) =>
  vmware === undefined
    ? undefined
    : {
        vcenterIp: vmware.vcenterIp,
        username: vmware.username,
        thumbprint: vmware.thumbprint,
        resolvedVcenterHost: vmware.resolvedVcenterHost,
      };

export const SourceProvider = () =>
  Provider.succeed(Source, {
    stables: ["name", "sourceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = kindOf({
        aws: olds?.aws ?? output?.aws,
        azure: olds?.azure ?? output?.azure,
        vmware: olds?.vmware ?? output?.vmware,
      });
      const nextKind = kindOf(news) || previousKind;
      const previousEncryption =
        olds?.encryption?.kmsKey ?? output?.encryption?.kmsKey;
      const nextEncryption = news.encryption?.kmsKey ?? previousEncryption;
      const previousAwsRegion = olds?.aws?.awsRegion ?? output?.aws?.awsRegion;
      const nextAwsRegion = news.aws?.awsRegion ?? previousAwsRegion;
      const previousAzureLocation =
        olds?.azure?.azureLocation ?? output?.azure?.azureLocation;
      const nextAzureLocation =
        news.azure?.azureLocation ?? previousAzureLocation;
      const previousSubscription =
        olds?.azure?.subscriptionId ?? output?.azure?.subscriptionId;
      const nextSubscription =
        news.azure?.subscriptionId ?? previousSubscription;
      return replaceOnIdentity({
        previousId: olds?.sourceId ?? output?.sourceId,
        nextId: news.sourceId ?? olds?.sourceId ?? output?.sourceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousKind !== nextKind ||
          previousEncryption !== nextEncryption ||
          previousAwsRegion !== nextAwsRegion ||
          previousAzureLocation !== nextAzureLocation ||
          previousSubscription !== nextSubscription,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sourceId = yield* toPhysicalId(
        id,
        olds?.sourceId,
        output?.sourceId,
        "source",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, sourceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sourceId = yield* toPhysicalId(
        id,
        news.sourceId,
        output?.sourceId,
        "source",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, sourceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsSources({
            parent: locationParent(env.project, location),
            sourceId,
            body: {
              description: news.description,
              labels: desiredLabels,
              encryption: news.encryption,
              aws: news.aws,
              azure: news.azure,
              vmware: news.vmware,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const awsChanged =
        news.aws !== undefined &&
        (fingerprint(publicAws(current.aws)) !==
          fingerprint(publicAws(news.aws)) ||
          news.aws.accessKeyCreds?.secretAccessKey !== undefined);
      const azureChanged =
        news.azure !== undefined &&
        (fingerprint(publicAzure(current.azure)) !==
          fingerprint(publicAzure(news.azure)) ||
          news.azure.clientSecretCreds?.clientSecret !== undefined);
      const vmwareChanged =
        news.vmware !== undefined &&
        (fingerprint(publicVmware(current.vmware)) !==
          fingerprint(publicVmware(news.vmware)) ||
          news.vmware.password !== undefined);
      const mask = fieldMask([
        labelsChanged && "labels",
        descriptionChanged && "description",
        awsChanged && "aws",
        azureChanged && "azure",
        vmwareChanged && "vmware",
      ]);

      if (mask.length > 0) {
        const operation = yield* vm.patchProjectsLocationsSources({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            description: news.description,
            labels: desiredLabels,
            aws: news.aws,
            azure: news.azure,
            vmware: news.vmware,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vm
        .deleteProjectsLocationsSources({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
