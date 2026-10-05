import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import { lastSegment, locationOf, locationParent } from "./ownership.ts";
import type { EncryptionSpec } from "./shared.ts";

export type TensorboardProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * Tensorboard.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. If omitted, a unique name is generated from
   * the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Mark this Tensorboard as the default for the project and region.
   * @default false
   */
  isDefault?: boolean;
};

export type Tensorboard = Resource<
  "GCP.AIPlatform.Tensorboard",
  TensorboardProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/tensorboards/{tensorboard}`. */
    name: string;
    /** Tensorboard id (last path segment). */
    tensorboardId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** CMEK resource name, if any. */
    encryptionSpec: EncryptionSpec | undefined;
    /** Whether this is the default Tensorboard in the region. */
    isDefault: boolean;
    /** Cloud Storage prefix used for blob data. */
    blobStoragePathPrefix: string | undefined;
    /** Number of runs stored in this Tensorboard. */
    runCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Tensorboard, the physical store for training metrics.
 *
 * Location and encryption key are immutable. Display name, description,
 * labels, and the default flag update in place.
 *
 * ### Creating a Tensorboard
 * **Example:** Generated display name
 * ```typescript
 * const board = yield* GCP.AIPlatform.Tensorboard("Metrics", {});
 * ```
 *
 * **Example:** Named Tensorboard with labels
 * ```typescript
 * const board = yield* GCP.AIPlatform.Tensorboard("Metrics", {
 *   displayName: "training-metrics",
 *   description: "experiment store",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Tensorboard = Resource<Tensorboard>("GCP.AIPlatform.Tensorboard");

export class TensorboardNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TensorboardNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  board: aiplatform.GoogleCloudAiplatformV1Tensorboard,
  project: string,
) => {
  const name = board.name ?? "";
  return {
    name,
    tensorboardId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: board.displayName,
    description: board.description,
    labels: userLabels(board.labels),
    encryptionSpec: board.encryptionSpec?.kmsKeyName
      ? { kmsKeyName: board.encryptionSpec.kmsKeyName }
      : undefined,
    isDefault: board.isDefault === true,
    blobStoragePathPrefix: board.blobStoragePathPrefix,
    runCount: board.runCount,
    createTime: board.createTime,
    updateTime: board.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsTensorboards({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((board) =>
      board
        ? Effect.succeed(board)
        : Effect.fail(new TensorboardNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.TensorboardNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listAt = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsTensorboards
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tensorboards ?? [])),
      Stream.filter((board) =>
        Object.keys(board.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((board) => toAttrs(board, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (
  parent: string,
  displayName: string,
  project: string,
) =>
  aiplatform.listProjectsLocationsTensorboards
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tensorboards ?? [])),
      Stream.filter((board) => board.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? toAttrs(option.value, project) : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const TensorboardProvider = () =>
  Provider.succeed(Tensorboard, {
    stables: ["name", "tensorboardId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (previousLocation !== undefined && previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ?? output?.encryptionSpec?.kmsKeyName;
      const nextKey = news.encryptionSpec?.kmsKeyName;
      if (
        previousKey !== undefined &&
        nextKey !== undefined &&
        previousKey !== nextKey
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        if (output?.name !== undefined) return undefined;
        const location = olds?.location ?? output?.location ?? env.region;
        const parent = locationParent(env.project, location);
        const match = yield* findByDisplayName(
          parent,
          olds?.displayName ?? "",
          env.project,
        );
        if (match === undefined) return undefined;
        const fetched = yield* getByName(match.name);
        if (fetched === undefined) return undefined;
        const attrs = toAttrs(fetched, env.project);
        return (yield* hasAlchemyLabels(id, tagRecord(fetched.labels)))
          ? attrs
          : Unowned(attrs);
      }
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return (yield* Effect.forEach(listLocations(env.region), (location) =>
          listAt(locationParent(env.project, location), env.project),
        )).flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName =
        news.displayName ?? output?.displayName ?? lastSegment(id);
      const desiredDefault = news.isDefault === true;
      const encryptionSpec = news.encryptionSpec?.kmsKeyName
        ? { kmsKeyName: news.encryptionSpec.kmsKeyName }
        : undefined;

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTensorboards({
            parent,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              encryptionSpec,
              isDefault: desiredDefault ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created, {
            alreadyExistsOk: true,
          });
          const createdName =
            resourceNameFromOperation(done) ?? output?.name ?? "";
          if (createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          const match = yield* findByDisplayName(
            parent,
            displayName,
            env.project,
          );
          if (match !== undefined) {
            current = yield* getByName(match.name);
          }
        }
      }

      if (current === undefined) {
        return yield* new TensorboardNotResolved({
          name: output?.name ?? `${parent}/tensorboards/-`,
        });
      }

      const name = current.name ?? "";
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const defaultChanged = (current.isDefault === true) !== desiredDefault;

      if (
        labelsChanged ||
        displayChanged ||
        descriptionChanged ||
        defaultChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayChanged ? "displayName" : undefined,
          descriptionChanged ? "description" : undefined,
          defaultChanged ? "isDefault" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* aiplatform.patchProjectsLocationsTensorboards({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            displayName,
            description: news.description,
            labels: desiredLabels,
            isDefault: desiredDefault,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsTensorboards({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
