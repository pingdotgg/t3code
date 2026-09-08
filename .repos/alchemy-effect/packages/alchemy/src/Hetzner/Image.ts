import { Services } from "@distilled.cloud/hetzner";
import type {
  GetImageResponseImage,
  ListImagesResponseImagesItem,
  UpdateImageResponseImage,
} from "@distilled.cloud/hetzner/images";
import type { CreateServerImageResponseImage } from "@distilled.cloud/hetzner/server_actions";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction } from "./actions.ts";
import {
  alchemyLabelKeys,
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

const MAX_DESCRIPTION_LENGTH = 64;

export type ImageType = "snapshot" | "backup";

export type ImageStatus = "available" | "creating" | "unavailable";

export type ImageArchitecture = "x86" | "arm";

export type ImageOsFlavor =
  | "ubuntu"
  | "centos"
  | "debian"
  | "fedora"
  | "rocky"
  | "alma"
  | "opensuse"
  | "unknown";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Server identity an Image is snapshotted from. Accepts a `Hetzner.Server`
 * resource or a `{ serverId }` stub. Stock (system/app) Images are not
 * managed here — look those up with `Hetzner.findImage`.
 */
export type ImageServer = {
  readonly serverId: number;
};

export interface ImageProps {
  /**
   * Server to snapshot. Required on create. Changing the source Server
   * replaces the Image (Hetzner cannot re-snapshot onto an existing Image).
   * Accepts a `Hetzner.Server` or `{ serverId }`.
   */
  server: Ref<ImageServer>;
  /**
   * Human-readable description. Snapshots have no unique `name` (that
   * field is only set on system Images). If omitted, a unique description
   * is generated from the stack, stage and logical ID.
   */
  description?: string;
  /**
   * Image type. Snapshots are independent of the source Server and billed
   * per GB. Backups are bound to the Server (and deleted with it) and
   * require backups to be enabled. Convert a backup to a snapshot in
   * place; snapshot → backup replaces.
   *
   * @default "snapshot"
   */
  type?: ImageType;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
  /**
   * Prevent the Image from being deleted via the API. Only valid on
   * snapshots.
   *
   * @default false
   */
  deleteProtection?: boolean;
}

export type Image = Resource<
  "Hetzner.Image",
  ImageProps,
  {
    /** Numeric Hetzner Image ID. */
    id: number;
    /** Image type (`snapshot` or `backup`). */
    type: ImageType;
    /** Image status. */
    status: ImageStatus;
    /**
     * Unique identifier. Only set for system Images — snapshots and
     * backups are `null`.
     */
    name: string | null;
    /** Human-readable description. */
    description: string;
    /**
     * Size of the Image file in Hetzner storage in GB. Relevant for
     * snapshot billing. `null` while the Image is still creating.
     */
    imageSize: number | null;
    /** Size of the disk contained in the Image in GB. */
    diskSize: number;
    /** RFC3339 creation timestamp. */
    created: string;
    /** ID of the Server this Image was created from, or `null`. */
    createdFromId: number | null;
    /** Server name at snapshot time, or `null`. */
    createdFromName: string | null;
    /**
     * Server ID this Image is bound to. Only set for `backup` Images.
     */
    boundTo: number | null;
    /** Flavor of operating system contained in the Image. */
    osFlavor: ImageOsFlavor;
    /** Operating system version, or `null`. */
    osVersion: string | null;
    /** Whether rapid deploy of the Image is available. */
    rapidDeploy: boolean | undefined;
    /** Whether delete protection is enabled. */
    deleteProtection: boolean;
    /** RFC3339 deprecation timestamp, or `null`. */
    deprecated: string | null;
    /** CPU architecture compatible with the Image. */
    architecture: ImageArchitecture;
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud custom Image — a snapshot (or backup) of a Server's
 * disk. Stock system/app Images (`ubuntu-24.04`, …) are Catalog lookups
 * via `Hetzner.findImage`, not this resource.
 *
 * Snapshots are created with `POST /servers/{id}/actions/create_image`
 * and billed per GB. Description, labels, delete protection, and
 * backup→snapshot conversion update in place. Changing the source Server
 * replaces the Image.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#images
 *
 * ### Creating a Snapshot
 * **Example:** Snapshot from a Server
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cx22",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 * const image = yield* Hetzner.Image("golden", {
 *   server,
 *   description: "golden-web",
 *   labels: { role: "golden" },
 * });
 * ```
 *
 * **Example:** Snapshot with generated description
 * ```typescript
 * const image = yield* Hetzner.Image("backup", {
 *   server: { serverId: 42 },
 * });
 * ```
 *
 * ### Updating a Snapshot
 * **Example:** Description, labels, and protection
 * ```typescript
 * const image = yield* Hetzner.Image("golden", {
 *   server,
 *   description: "golden-web-v2",
 *   labels: { role: "golden", env: "prod" },
 *   deleteProtection: true,
 * });
 * ```
 *
 * @resource
 */
export const Image = Resource<Image>("Hetzner.Image");

type CloudImage =
  | GetImageResponseImage
  | ListImagesResponseImagesItem
  | CreateServerImageResponseImage
  | UpdateImageResponseImage;

class ImagePending extends Data.TaggedError("ImagePending")<{
  imageId: number;
  status: string;
}> {}

class ImageTimeout extends Data.TaggedError("ImageTimeout")<{
  imageId: number;
  status: string;
}> {}

class ImageNotResolved extends Data.TaggedError("Hetzner.ImageNotResolved")<{
  serverId: number;
  description: string;
}> {}

class ImageServerRequired extends Data.TaggedError(
  "Hetzner.ImageServerRequired",
)<{
  description: string;
}> {}

const DEFAULT_TYPE: ImageType = "snapshot";

const asType = (type: string): ImageType =>
  type === "backup" ? "backup" : "snapshot";

const asStatus = (status: string): ImageStatus =>
  status === "creating" || status === "unavailable" ? status : "available";

const asArchitecture = (architecture: string): ImageArchitecture =>
  architecture === "arm" ? "arm" : "x86";

const asOsFlavor = (flavor: string): ImageOsFlavor => {
  switch (flavor) {
    case "ubuntu":
    case "centos":
    case "debian":
    case "fedora":
    case "rocky":
    case "alma":
    case "opensuse":
    case "unknown":
      return flavor;
    default:
      return "unknown";
  }
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (image: CloudImage): Image["Attributes"] => ({
  id: image.id,
  type: asType(image.type),
  status: asStatus(image.status),
  name: image.name,
  description: image.description,
  imageSize: image.image_size,
  diskSize: image.disk_size,
  created: image.created,
  createdFromId: image.created_from?.id ?? null,
  createdFromName: image.created_from?.name ?? null,
  boundTo: image.bound_to,
  osFlavor: asOsFlavor(image.os_flavor),
  osVersion: image.os_version,
  rapidDeploy: image.rapid_deploy,
  deleteProtection: image.protection.delete,
  deprecated: image.deprecated,
  architecture: asArchitecture(image.architecture),
  labels: userLabels(image.labels),
});

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "ImagePending" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "InternalServerError" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout" ||
  e._tag === "Locked";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const toDescription = (
  id: string,
  description: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      description ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: MAX_DESCRIPTION_LENGTH }))
    );
  });

const getById = (id: number) =>
  Services.images.getImage({ id }).pipe(
    Effect.map(({ image }) => image),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByLabels = (labels: Record<string, string>) =>
  Services.images
    .listImages({
      type: ["snapshot", "backup"],
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ images }) => images[0]));

const observe = Effect.fn(function* ({
  id,
  outputId,
}: {
  id: string;
  outputId?: number;
}) {
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  const internal = yield* createInternalLabels(id);
  return yield* getByLabels(internal);
});

const waitUntilAvailable = (imageId: number) =>
  getById(imageId).pipe(
    Effect.flatMap((image) =>
      image !== undefined && image.status === "available"
        ? Effect.succeed(image)
        : Effect.fail(
            new ImagePending({
              imageId,
              status: image?.status ?? "missing",
            }),
          ),
    ),
    Effect.retry({
      while: retryable,
      times: 10,
      schedule: Schedule.spaced(Duration.seconds(5)),
    }),
    Effect.catchTag(
      "ImagePending",
      (e) =>
        new ImageTimeout({
          imageId: e.imageId,
          status: e.status,
        }),
    ),
  );

const waitUntilGone = (imageId: number) =>
  Services.images.getImage({ id: imageId }).pipe(
    Effect.map(() => false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (gone) => gone,
      times: 10,
    }),
  );

const serverIdOf = (value: unknown): number | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const id = (value as { serverId?: unknown }).serverId;
  return typeof id === "number" ? id : undefined;
};

const disableProtection = (id: number) =>
  Services.imageActions
    .changeImageProtection({ id, delete: false })
    .pipe(Effect.flatMap(({ action }) => waitForAction(action)));

export const ImageProvider = () =>
  Provider.succeed(Image, {
    stables: [
      "id",
      "created",
      "createdFromId",
      "architecture",
      "diskSize",
      "osFlavor",
    ],
    list: Effect.fn(function* () {
      const items = yield* Services.images.listImages
        .items({
          type: ["snapshot", "backup"],
          label_selector: alchemyStackSelector,
          per_page: 50,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map(toAttrs);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        const nextServerId = serverIdOf(news.server);
        if (
          nextServerId !== undefined &&
          output.createdFromId !== null &&
          nextServerId !== output.createdFromId
        ) {
          return { action: "replace" } as const;
        }
        const nextType = news.type ?? DEFAULT_TYPE;
        if (nextType === "backup" && output.type === "snapshot") {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      const found = yield* observe({
        id,
        outputId: output?.id,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found);
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const description = yield* toDescription(
        id,
        news.description,
        output?.description,
      );
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const desiredType = news.type ?? DEFAULT_TYPE;
      const desiredProtection = news.deleteProtection ?? false;
      const desiredServerId = serverIdOf(news.server);

      // Observe by id only. Do not fall back to ownership labels — a
      // create-first replacement still has the old generation live under
      // the same logical id, and snapshots are not uniquely named.
      let current =
        output?.id !== undefined ? yield* getById(output.id) : undefined;

      if (current === undefined) {
        if (desiredServerId === undefined) {
          return yield* new ImageServerRequired({ description });
        }
        const created = yield* Services.serverActions.createServerImage({
          id: desiredServerId,
          description,
          type: desiredType,
          labels: desiredLabels,
        });
        const imageId =
          created.image?.id ??
          created.action?.resources.find(
            (resource) => resource.type === "image",
          )?.id;
        if (imageId === undefined) {
          return yield* new ImageNotResolved({
            serverId: desiredServerId,
            description,
          });
        }
        if (created.action) {
          yield* waitForAction(created.action).pipe(
            Effect.catchTag("ActionTimeout", () => Effect.void),
          );
        }
        current = yield* waitUntilAvailable(imageId);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const convertToSnapshot =
        current.type === "backup" && desiredType === "snapshot";
      const descriptionChanged = current.description !== description;
      if (descriptionChanged || labelsChanged || convertToSnapshot) {
        const updated = yield* Services.images.updateImage({
          id: current.id,
          description: descriptionChanged ? description : undefined,
          type: convertToSnapshot ? "snapshot" : undefined,
          labels: labelsChanged ? desiredLabels : undefined,
        });
        current = updated.image ?? (yield* waitUntilAvailable(current.id));
      }

      if (current.protection.delete !== desiredProtection) {
        const { action } = yield* Services.imageActions.changeImageProtection({
          id: current.id,
          delete: desiredProtection,
        });
        yield* waitForAction(action);
        current = (yield* getById(current.id)) ?? current;
      }

      return toAttrs(current);
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current === undefined) return;

      if (current.protection.delete) {
        yield* disableProtection(current.id);
      }

      yield* Services.images.deleteImage({ id: current.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: retryable,
          times: 8,
          schedule: backoff,
        }),
      );
      yield* waitUntilGone(current.id);
    }),
  });
