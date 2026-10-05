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

export type ImageRawDisk = {
  /** GCS URI of a gzip-compressed tarball (`gs://` or `https://storage.googleapis.com/`). */
  source: string;
  /** SHA-1 checksum of the tarball, if known. */
  sha1Checksum?: string;
  /**
   * Container type of the disk image.
   * @default "TAR"
   */
  containerType?: "TAR" | (string & {});
};

export type ImageProps = {
  /**
   * Image name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the image.
   */
  imageName?: string;
  /**
   * Optional description. Mutable in place via `images.patch`.
   */
  description?: string;
  /**
   * Image family. Disks can target the family to get the latest
   * non-deprecated image. Mutable in place via `images.patch`.
   */
  family?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `images.setLabels`.
   */
  labels?: Record<string, string>;
  /**
   * Source disk URL (`projects/{project}/zones/{zone}/disks/{disk}`).
   * Immutable — changing it replaces the image. Provide one of
   * `sourceDisk`, `sourceImage`, `sourceSnapshot`, or `rawDisk`.
   */
  sourceDisk?: string;
  /**
   * Source image URL (`projects/{project}/global/images/{image}` or
   * `.../images/family/{family}`). Immutable — changing it replaces
   * the image.
   */
  sourceImage?: string;
  /**
   * Source snapshot URL (`projects/{project}/global/snapshots/{snapshot}`).
   * Immutable — changing it replaces the image.
   */
  sourceSnapshot?: string;
  /**
   * Raw disk image stored in Cloud Storage. Immutable — changing it
   * replaces the image.
   */
  rawDisk?: ImageRawDisk;
  /**
   * Size of the image when restored onto a persistent disk, in GB.
   * Immutable — changing it replaces the image.
   */
  diskSizeGb?: number;
  /**
   * Cloud Storage locations for the image (`us-central1`, `us`, …).
   * Immutable — changing it replaces the image.
   */
  storageLocations?: string[];
  /**
   * CPU architecture (`ARM64` or `X86_64`). Immutable — changing it
   * replaces the image.
   */
  architecture?: compute.ImageArchitectureEnum | (string & {});
  /**
   * License URIs attached to the image. Immutable — changing it replaces
   * the image.
   */
  licenses?: string[];
};

export type Image = Resource<
  "GCP.Compute.Image",
  ImageProps,
  {
    /** Image name. */
    imageName: string;
    /** Server-assigned numeric id. */
    imageId: string | undefined;
    /** Project id. */
    project: string;
    /** Server-reported status (`PENDING`, `READY`, `FAILED`, …). */
    status: string | undefined;
    /** Image family, if set. */
    family: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Source disk URL, if any. */
    sourceDisk: string | undefined;
    /** Source image URL, if any. */
    sourceImage: string | undefined;
    /** Source snapshot URL, if any. */
    sourceSnapshot: string | undefined;
    /** Size in GB when restored onto a disk. */
    diskSizeGb: string | undefined;
    /** Architecture, if set. */
    architecture: string | undefined;
    /** Storage locations. */
    storageLocations: string[];
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Archive size in bytes, if reported. */
    archiveSizeBytes: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Compute Engine custom image used to create boot disks for VMs.
 *
 * Create from a disk, another image, a snapshot, or a GCS tarball.
 * `family` and `description` update in place; labels are synced via
 * `setLabels`. Source, size, architecture, licenses, and storage
 * locations replace the image.
 *
 * ### Creating an Image
 * **Example:** Image from a disk
 * ```typescript
 * const image = yield* GCP.Compute.Image("boot", {
 *   sourceDisk: "projects/my-project/zones/us-central1-a/disks/my-disk",
 *   family: "app-boot",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Clone a public image family
 * ```typescript
 * const image = yield* GCP.Compute.Image("debian", {
 *   sourceImage: "projects/debian-cloud/global/images/family/debian-12",
 *   storageLocations: ["us-central1"],
 * });
 * ```
 *
 * ### Updating an Image
 * **Example:** Family, description, and labels
 * ```typescript
 * const image = yield* GCP.Compute.Image("boot", {
 *   imageName: "app-boot-v2",
 *   sourceDisk: "projects/my-project/zones/us-central1-a/disks/my-disk",
 *   family: "app-boot",
 *   description: "golden image",
 *   labels: { env: "prod", role: "boot" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Image = Resource<Image>("GCP.Compute.Image");

export class ImageNotResolved extends Data.TaggedError(
  "GCP.Compute.ImageNotResolved",
)<{
  imageName: string;
}> {}

export class ImagePending extends Data.TaggedError("GCP.Compute.ImagePending")<{
  imageName: string;
  status: string;
}> {}

export class ImageFailed extends Data.TaggedError("GCP.Compute.ImageFailed")<{
  imageName: string;
  status: string;
}> {}

export class ImageStillExists extends Data.TaggedError(
  "GCP.Compute.ImageStillExists",
)<{
  imageName: string;
  status: string;
}> {}

export class ImageSourceRequired extends Data.TaggedError(
  "GCP.Compute.ImageSourceRequired",
)<{
  imageName: string;
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

const sameStrings = (left?: readonly string[], right?: readonly string[]) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

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
      : `i${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (image: compute.Image, project: string) => ({
  imageName: image.name ?? image.id ?? "",
  imageId: image.id,
  project,
  status: image.status,
  family: image.family,
  description: image.description,
  labels: userLabels(image.labels),
  sourceDisk: image.sourceDisk,
  sourceImage: image.sourceImage,
  sourceSnapshot: image.sourceSnapshot,
  diskSizeGb: image.diskSizeGb,
  architecture: image.architecture,
  storageLocations: image.storageLocations ?? [],
  selfLink: image.selfLink,
  creationTimestamp: image.creationTimestamp,
  archiveSizeBytes: image.archiveSizeBytes,
});

const getByName = (project: string, image: string) =>
  compute
    .getImages({ project, image })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (project: string, imageName: string) =>
  getByName(project, imageName).pipe(
    Effect.flatMap((image) =>
      image?.status === "FAILED"
        ? Effect.fail(new ImageFailed({ imageName, status: "FAILED" }))
        : Effect.succeed(image),
    ),
    Effect.filterOrFail(
      (image): image is compute.Image =>
        image !== undefined && image.status === "READY",
      (image) =>
        new ImagePending({
          imageName,
          status: image?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.ImagePending",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilGone = (project: string, imageName: string) =>
  getByName(project, imageName).pipe(
    Effect.flatMap((image) =>
      image === undefined
        ? Effect.void
        : Effect.fail(
            new ImageStillExists({
              imageName,
              status: image.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.ImageStillExists",
      times: 18,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const insertBody = (
  imageName: string,
  news: ImageProps,
  labels: Record<string, string>,
): compute.Image => ({
  name: imageName,
  description: news.description,
  family: news.family,
  labels,
  sourceDisk: news.sourceDisk,
  sourceImage: news.sourceImage,
  sourceSnapshot: news.sourceSnapshot,
  rawDisk: news.rawDisk
    ? {
        source: news.rawDisk.source,
        sha1Checksum: news.rawDisk.sha1Checksum,
        containerType: news.rawDisk.containerType ?? "TAR",
      }
    : undefined,
  diskSizeGb:
    news.diskSizeGb !== undefined ? String(news.diskSizeGb) : undefined,
  storageLocations: news.storageLocations,
  architecture: news.architecture,
  licenses: news.licenses,
});

const hasSource = (props: ImageProps) =>
  props.sourceDisk !== undefined ||
  props.sourceImage !== undefined ||
  props.sourceSnapshot !== undefined ||
  props.rawDisk?.source !== undefined;

const sourceIdentity = (props: ImageProps): string => {
  if (props.sourceDisk !== undefined) {
    return `disk:${lastSegment(props.sourceDisk)}`;
  }
  if (props.sourceImage !== undefined) {
    return `image:${lastSegment(props.sourceImage)}`;
  }
  if (props.sourceSnapshot !== undefined) {
    return `snapshot:${lastSegment(props.sourceSnapshot)}`;
  }
  if (props.rawDisk?.source !== undefined) {
    return `raw:${props.rawDisk.source}:${props.rawDisk.sha1Checksum ?? ""}:${props.rawDisk.containerType ?? "TAR"}`;
  }
  return "";
};

const sourceChanged = (olds: ImageProps, news: ImageProps) => {
  const previous = sourceIdentity(olds);
  const next = sourceIdentity(news);
  return previous.length > 0 && next.length > 0 && previous !== next;
};

export const ImageProvider = () =>
  Provider.succeed(Image, {
    stables: [
      "imageName",
      "imageId",
      "project",
      "selfLink",
      "creationTimestamp",
      "sourceDisk",
      "sourceImage",
      "sourceSnapshot",
      "architecture",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds.imageName ?? output?.imageName;
      const nextName = news.imageName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousSize = olds.diskSizeGb ?? Number(output?.diskSizeGb);
      const sizeChanged =
        news.diskSizeGb !== undefined &&
        previousSize !== undefined &&
        !Number.isNaN(previousSize) &&
        news.diskSizeGb !== previousSize;

      const architectureChanged =
        news.architecture !== undefined &&
        (olds.architecture ?? output?.architecture) !== undefined &&
        news.architecture !== (olds.architecture ?? output?.architecture);

      const storageChanged =
        news.storageLocations !== undefined &&
        !sameStrings(
          news.storageLocations,
          olds.storageLocations ?? output?.storageLocations,
        );

      const licensesChanged =
        news.licenses !== undefined &&
        olds.licenses !== undefined &&
        !sameStrings(news.licenses, olds.licenses);

      const replace =
        nameChanged ||
        sourceChanged(olds, news) ||
        sizeChanged ||
        architectureChanged ||
        storageChanged ||
        licensesChanged;

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
      const imageName = yield* toName(id, olds?.imageName, output?.imageName);
      const existing = yield* getByName(env.project, imageName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listImages
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
      const imageName = yield* toName(id, news.imageName, output?.imageName);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, imageName);
      if (current?.status === "DELETING") {
        yield* waitUntilGone(env.project, imageName);
        current = undefined;
      }

      if (current === undefined) {
        if (!hasSource(news)) {
          return yield* new ImageSourceRequired({ imageName });
        }
        const inserted = yield* compute
          .insertImages({
            project: env.project,
            body: insertBody(imageName, news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitGlobalOperation(env.project, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitUntilReady(env.project, imageName);
      }

      if (current === undefined) {
        return yield* new ImageNotResolved({ imageName });
      }

      if (current.status !== "READY") {
        current = yield* waitUntilReady(env.project, imageName);
      }

      if (current === undefined) {
        return yield* new ImageNotResolved({ imageName });
      }

      const familyChanged = (current.family ?? "") !== (news.family ?? "");
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      if (familyChanged || descriptionChanged) {
        yield* compute
          .patchImages({
            project: env.project,
            image: imageName,
            body: {
              family: news.family,
              description: news.description,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = (yield* getByName(env.project, imageName)) ?? current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* compute
          .setLabelsImages({
            project: env.project,
            resource: imageName,
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
        current = (yield* getByName(env.project, imageName)) ?? current;
      }

      if (current === undefined) {
        return yield* new ImageNotResolved({ imageName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteImages({
          project: env.project,
          image: output.imageName,
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
      yield* waitUntilGone(env.project, output.imageName);
    }),
  });
