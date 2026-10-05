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
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type MachineImageProps = {
  /**
   * Machine image name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the machine image.
   */
  machineImageName?: string;
  /**
   * Source instance URL used to create the machine image
   * (`projects/{project}/zones/{zone}/instances/{instance}` or a full
   * self-link). Immutable — changing it replaces the machine image.
   */
  sourceInstance: string;
  /**
   * Optional description. Immutable — changing it replaces the machine
   * image (the API has no patch).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `machineImages.setLabels`.
   */
  labels?: Record<string, string>;
  /**
   * Cloud Storage locations for the machine image (`us-central1`, `us`,
   * …). Immutable — changing it replaces the machine image.
   */
  storageLocations?: string[];
  /**
   * Attempt an application-consistent image by flushing the guest OS.
   * Input-only; not persisted on the resource.
   */
  guestFlush?: boolean;
};

export type MachineImage = Resource<
  "GCP.Compute.MachineImage",
  MachineImageProps,
  {
    /** Machine image name. */
    machineImageName: string;
    /** Server-assigned numeric id. */
    machineImageId: string | undefined;
    /** Project id. */
    project: string;
    /** Server-reported status (`CREATING`, `READY`, `DELETING`, …). */
    status: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Source instance URL. */
    sourceInstance: string | undefined;
    /** Cloud Storage locations. */
    storageLocations: string[];
    /** Total storage used by the machine image, in bytes. */
    totalStorageBytes: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Compute Engine machine image capturing a VM's disks, metadata, and
 * configuration so it can be used to create new instances.
 *
 * Create from a source instance. Name, source instance, description, and
 * storage locations replace the machine image. Labels are synced in place
 * via `setLabels`.
 *
 * ### Creating a Machine Image
 * **Example:** Machine image from an instance
 * ```typescript
 * const vm = yield* GCP.Compute.Instance("web", {
 *   zone: "us-central1-a",
 *   machineType: "e2-micro",
 * });
 * const image = yield* GCP.Compute.MachineImage("backup", {
 *   sourceInstance: vm.selfLink,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Explicit name and regional storage
 * ```typescript
 * const image = yield* GCP.Compute.MachineImage("backup", {
 *   machineImageName: "web-golden",
 *   sourceInstance:
 *     "projects/{project}/zones/us-central1-a/instances/web",
 *   description: "golden image of web",
 *   storageLocations: ["us-central1"],
 * });
 * ```
 *
 * ### Updating a Machine Image
 * **Example:** Labels
 * ```typescript
 * const image = yield* GCP.Compute.MachineImage("backup", {
 *   machineImageName: "web-golden",
 *   sourceInstance:
 *     "projects/{project}/zones/us-central1-a/instances/web",
 *   labels: { env: "prod", role: "golden" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const MachineImage = Resource<MachineImage>("GCP.Compute.MachineImage");

export class MachineImageNotResolved extends Data.TaggedError(
  "GCP.Compute.MachineImageNotResolved",
)<{
  machineImageName: string;
}> {}

export class MachineImagePending extends Data.TaggedError(
  "GCP.Compute.MachineImagePending",
)<{
  machineImageName: string;
  status: string;
}> {}

export class MachineImageFailed extends Data.TaggedError(
  "GCP.Compute.MachineImageFailed",
)<{
  machineImageName: string;
  status: string;
}> {}

export class MachineImageStillExists extends Data.TaggedError(
  "GCP.Compute.MachineImageStillExists",
)<{
  machineImageName: string;
  status: string;
}> {}

export class MachineImageSourceRequired extends Data.TaggedError(
  "GCP.Compute.MachineImageSourceRequired",
)<{
  machineImageName: string;
}> {}

const MAX_NAME_LENGTH = 63;

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const sameStrings = (left?: readonly string[], right?: readonly string[]) => {
  const a = [...(left ?? [])].map((value) => value.toLowerCase()).sort();
  const b = [...(right ?? [])].map((value) => value.toLowerCase()).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `m${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (image: compute.MachineImage, project: string) => ({
  machineImageName: image.name ?? image.id ?? "",
  machineImageId: image.id,
  project,
  status: image.status,
  description: image.description,
  labels: userLabels(image.labels),
  sourceInstance: image.sourceInstance,
  storageLocations: image.storageLocations ?? [],
  totalStorageBytes: image.totalStorageBytes,
  selfLink: image.selfLink,
  creationTimestamp: image.creationTimestamp,
});

const getByName = (project: string, machineImage: string) =>
  compute
    .getMachineImages({ project, machineImage })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const canonicalizeSourceInstance = (source: string | undefined): string => {
  if (source === undefined || source.length === 0) return "";
  const cleaned = source.split("?")[0] ?? source;
  const full = cleaned.match(
    /(projects\/[^/]+\/zones\/[^/]+\/instances\/[^/]+)$/,
  );
  if (full?.[1] !== undefined) return full[1];
  const zonal = cleaned.match(/(zones\/[^/]+\/instances\/[^/]+)$/);
  if (zonal?.[1] !== undefined) return zonal[1];
  return lastSegment(cleaned);
};

const waitUntilReady = (project: string, machineImageName: string) =>
  getByName(project, machineImageName).pipe(
    Effect.flatMap((image) =>
      image?.status === "INVALID" || image?.status === "FAILED"
        ? Effect.fail(
            new MachineImageFailed({
              machineImageName,
              status: image.status ?? "INVALID",
            }),
          )
        : Effect.succeed(image),
    ),
    Effect.filterOrFail(
      (image): image is compute.MachineImage =>
        image !== undefined && image.status === "READY",
      (image) =>
        new MachineImagePending({
          machineImageName,
          status: image?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.MachineImagePending",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilGone = (project: string, machineImageName: string) =>
  getByName(project, machineImageName).pipe(
    Effect.flatMap((image) =>
      image === undefined
        ? Effect.void
        : Effect.fail(
            new MachineImageStillExists({
              machineImageName,
              status: image.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.MachineImageStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const insertBody = (
  machineImageName: string,
  news: MachineImageProps,
  labels: Record<string, string>,
): compute.MachineImage => ({
  name: machineImageName,
  sourceInstance: news.sourceInstance,
  description: news.description,
  labels,
  storageLocations: news.storageLocations,
  guestFlush: news.guestFlush,
});

export const MachineImageProvider = () =>
  Provider.succeed(MachineImage, {
    stables: [
      "machineImageName",
      "machineImageId",
      "project",
      "selfLink",
      "creationTimestamp",
      "sourceInstance",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds.machineImageName ?? output?.machineImageName;
      const nextName = news.machineImageName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousSource = canonicalizeSourceInstance(
        olds.sourceInstance ?? output?.sourceInstance,
      );
      const nextSource = canonicalizeSourceInstance(news.sourceInstance);
      const sourceChanged =
        previousSource.length > 0 &&
        nextSource.length > 0 &&
        previousSource !== nextSource;

      const previousDescription = olds.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";
      const descriptionChanged = previousDescription !== nextDescription;

      const storageChanged =
        news.storageLocations !== undefined &&
        !sameStrings(
          news.storageLocations,
          olds.storageLocations ?? output?.storageLocations,
        );

      const replace =
        nameChanged || sourceChanged || descriptionChanged || storageChanged;

      if (!replace) return undefined;
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
      const machineImageName = yield* toName(
        id,
        olds?.machineImageName,
        output?.machineImageName,
      );
      const existing = yield* getByName(env.project, machineImageName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listMachineImages
          .items({
            project: env.project,
            maxResults: 500,
            filter: "labels.alchemy-id:*",
          })
          .pipe(
            Stream.filter((image) =>
              Object.keys(image.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((image) => toAttrs(image, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const machineImageName = yield* toName(
        id,
        news.machineImageName,
        output?.machineImageName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, machineImageName);
      if (current?.status === "DELETING") {
        yield* waitUntilGone(env.project, machineImageName);
        current = undefined;
      }

      if (current === undefined) {
        if (
          news.sourceInstance === undefined ||
          news.sourceInstance.length === 0
        ) {
          return yield* new MachineImageSourceRequired({ machineImageName });
        }
        const inserted = yield* compute
          .insertMachineImages({
            project: env.project,
            sourceInstance: news.sourceInstance,
            body: insertBody(machineImageName, news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitGlobalOperation(env.project, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitUntilReady(env.project, machineImageName);
      }

      if (current === undefined) {
        return yield* new MachineImageNotResolved({ machineImageName });
      }

      if (current.status !== "READY") {
        current = yield* waitUntilReady(env.project, machineImageName);
      }

      if (current === undefined) {
        return yield* new MachineImageNotResolved({ machineImageName });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* compute
          .setLabelsMachineImages({
            project: env.project,
            resource: machineImageName,
            body: {
              labels: desiredLabels,
              labelFingerprint: current.labelFingerprint,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = (yield* getByName(env.project, machineImageName)) ?? current;
      }

      if (current === undefined) {
        return yield* new MachineImageNotResolved({ machineImageName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteMachineImages({
          project: env.project,
          machineImage: output.machineImageName,
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
      yield* waitUntilGone(env.project, output.machineImageName);
    }),
  });
