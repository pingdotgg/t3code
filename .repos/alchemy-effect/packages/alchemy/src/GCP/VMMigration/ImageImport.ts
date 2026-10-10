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
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  fingerprint,
  hasAlchemyLabelMap,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DiskImageTargetDetails = vm.DiskImageTargetDetails;
export type MachineImageTargetDetails = vm.MachineImageTargetDetails;

export type ImageImportProps = {
  /**
   * Image import id (the `{imageImport}` segment of
   * `projects/{project}/locations/{location}/imageImports/{imageImport}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the import.
   */
  imageImportId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * import. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Cloud Storage URI of the image to import. Immutable — changing it
   * replaces the import.
   */
  cloudStorageUri: string;
  /**
   * Target details for a disk image. Mutually exclusive with
   * `machineImageTargetDefaults`. Alchemy ownership labels are merged
   * into `labels` (the import itself has no labels field). Immutable.
   */
  diskImageTargetDefaults?: DiskImageTargetDetails;
  /**
   * Target details for a machine image. Mutually exclusive with
   * `diskImageTargetDefaults`. Alchemy ownership labels are merged into
   * `labels`. Immutable.
   */
  machineImageTargetDefaults?: MachineImageTargetDetails;
  /**
   * Encryption used during image adaptation. Immutable — changing it
   * replaces the import.
   */
  encryption?: vm.Encryption;
};

export type ImageImport = Resource<
  "GCP.VMMigration.ImageImport",
  ImageImportProps,
  {
    /** Full resource name. */
    name: string;
    /** Image import id (last path segment). */
    imageImportId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Cloud Storage URI of the imported image. */
    cloudStorageUri: string | undefined;
    /** Disk image target details with Alchemy labels stripped. */
    diskImageTargetDefaults: DiskImageTargetDetails | undefined;
    /** Machine image target details with Alchemy labels stripped. */
    machineImageTargetDefaults: MachineImageTargetDetails | undefined;
    /** Encryption used during adaptation. */
    encryption: vm.Encryption | undefined;
    /** Most recent import jobs. */
    recentImageImportJobs: vm.ImageImportJobList | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration image import from a Cloud Storage file into a Compute
 * Engine disk or machine image.
 *
 * Image imports are immutable — every field is a replacement trigger.
 * The resource has no labels field; Alchemy stamps ownership into the
 * target details' `labels` and `description` so `list` / nuke can find
 * them.
 *
 * ### Creating an Image Import
 * **Example:** Disk image
 * ```typescript
 * const target = yield* GCP.VMMigration.Target("Landing");
 * const image = yield* GCP.VMMigration.ImageImport("Disk", {
 *   cloudStorageUri: "gs://bucket/disk.vmdk",
 *   diskImageTargetDefaults: {
 *     imageName: "imported-disk",
 *     targetProject: target.name,
 *   },
 * });
 * ```
 *
 * **Example:** Machine image
 * ```typescript
 * const image = yield* GCP.VMMigration.ImageImport("Machine", {
 *   cloudStorageUri: "gs://bucket/machine.ova",
 *   machineImageTargetDefaults: {
 *     machineImageName: "imported-machine",
 *     targetProject: target.name,
 *   },
 * });
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const ImageImport = Resource<ImageImport>("GCP.VMMigration.ImageImport");

const resourceName = (
  project: string,
  location: string,
  imageImportId: string,
) => `${locationParent(project, location)}/imageImports/${imageImportId}`;

const stripTarget = <T extends { labels?: vm.StringMap; description?: string }>(
  target: T | undefined,
): T | undefined => {
  if (target === undefined) return undefined;
  return {
    ...target,
    labels: userLabels(target.labels),
    description: parseOwnership(target.description).text,
  };
};

const toAttrs = (image: vm.ImageImport, project: string, region: string) => {
  const name = image.name ?? "";
  const parsed = parseName(name, "imageImports", region);
  return {
    name,
    imageImportId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    cloudStorageUri: image.cloudStorageUri,
    diskImageTargetDefaults: stripTarget(image.diskImageTargetDefaults),
    machineImageTargetDefaults: stripTarget(image.machineImageTargetDefaults),
    encryption: image.encryption,
    recentImageImportJobs: image.recentImageImportJobs,
    createTime: image.createTime,
  };
};

const isOwned = (image: vm.ImageImport) =>
  hasAlchemyLabelMap(image.diskImageTargetDefaults?.labels) ||
  hasAlchemyLabelMap(image.machineImageTargetDefaults?.labels) ||
  hasOwnershipMarker(image.diskImageTargetDefaults?.description) ||
  hasOwnershipMarker(image.machineImageTargetDefaults?.description);

const ownedById = (id: string, image: vm.ImageImport) =>
  Effect.gen(function* () {
    const disk = image.diskImageTargetDefaults;
    const machine = image.machineImageTargetDefaults;
    if (disk && (yield* hasAlchemyLabels(id, tagRecord(disk.labels)))) {
      return true;
    }
    if (machine && (yield* hasAlchemyLabels(id, tagRecord(machine.labels)))) {
      return true;
    }
    if (yield* ownedByAlchemy(id, disk?.description)) return true;
    if (yield* ownedByAlchemy(id, machine?.description)) return true;
    return false;
  });

const stampTarget = <T extends { labels?: vm.StringMap; description?: string }>(
  target: T | undefined,
  ownership: Record<string, string>,
): T | undefined => {
  if (target === undefined) return undefined;
  return {
    ...target,
    labels: { ...toLabels(tagRecord(target.labels)), ...ownership },
    description: encodeOwnership(ownership, target.description),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsImageImports({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  vm.listProjectsLocationsImageImports
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.imageImports ?? [])),
      Stream.filter(isOwned),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        vm.listProjectsLocationsImageImports
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.imageImports ?? []),
            ),
            Stream.filter(isOwned),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as vm.ImageImport[]),
            ),
          ),
      ),
    );

export const ImageImportProvider = () =>
  Provider.succeed(ImageImport, {
    stables: ["name", "imageImportId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const extra =
        (news.cloudStorageUri !== undefined &&
          (olds?.cloudStorageUri ?? output?.cloudStorageUri) !== undefined &&
          news.cloudStorageUri !==
            (olds?.cloudStorageUri ?? output?.cloudStorageUri)) ||
        fingerprint(news.encryption) !==
          fingerprint(olds?.encryption ?? output?.encryption) ||
        fingerprint(news.diskImageTargetDefaults) !==
          fingerprint(
            olds?.diskImageTargetDefaults ?? output?.diskImageTargetDefaults,
          ) ||
        fingerprint(news.machineImageTargetDefaults) !==
          fingerprint(
            olds?.machineImageTargetDefaults ??
              output?.machineImageTargetDefaults,
          );
      return replaceOnIdentity({
        previousId: olds?.imageImportId ?? output?.imageImportId,
        nextId:
          news.imageImportId ?? olds?.imageImportId ?? output?.imageImportId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const imageImportId = yield* toPhysicalId(
        id,
        olds?.imageImportId,
        output?.imageImportId,
        "imageimport",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, imageImportId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedById(id, existing)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const imageImportId = yield* toPhysicalId(
        id,
        news.imageImportId,
        output?.imageImportId,
        "imageimport",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, imageImportId);
      const ownership = yield* createInternalLabels(id);
      const diskImageTargetDefaults = stampTarget(
        news.diskImageTargetDefaults,
        ownership,
      );
      const machineImageTargetDefaults = stampTarget(
        news.machineImageTargetDefaults,
        ownership,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsImageImports({
            parent: locationParent(env.project, location),
            imageImportId,
            body: {
              cloudStorageUri: news.cloudStorageUri,
              diskImageTargetDefaults,
              machineImageTargetDefaults,
              encryption: news.encryption,
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

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vm
        .deleteProjectsLocationsImageImports({ name: output.name })
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
