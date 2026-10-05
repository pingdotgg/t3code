import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "meshes";

export type MeshEnvoyHeaders =
  | networkservices.MeshEnvoyHeadersEnum
  | (string & {});

export type MeshProps = {
  /**
   * Mesh id (the `{mesh}` segment of
   * `projects/{project}/locations/{location}/meshes/{mesh}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Must be 1-63 characters and not start with a number. Immutable —
   * changing it replaces the mesh.
   */
  meshId?: string;
  /**
   * Location (`global`, `us-central1`, …). Meshes are typically
   * `global`. Immutable — changing it replaces the mesh. `US-CENTRAL1`
   * is accepted and normalized to `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Max 1024 characters.
   */
  description?: string;
  /**
   * Localhost port the sidecar proxy intercepts (1-65535). Unset uses
   * `15001`. Sidecar deployments only.
   */
  interceptionPort?: number;
  /**
   * Whether Envoy inserts debug headers on upstream requests.
   * `NONE` (default) or `DEBUG_HEADERS`.
   */
  envoyHeaders?: MeshEnvoyHeaders;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Mesh = Resource<
  "GCP.NetworkServices.Mesh",
  MeshProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/meshes/{mesh}`. */
    name: string;
    /** Mesh id (last path segment). */
    meshId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Sidecar interception port, if set. */
    interceptionPort: number | undefined;
    /** Envoy debug-header insertion mode. */
    envoyHeaders: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Service Mesh configuration grouping for workload-to-workload
 * traffic. Routes attached to the mesh decide how requests are routed
 * inside this logical boundary.
 *
 * Changing `meshId` or `location` replaces the mesh. Description,
 * labels, interception port, and Envoy header settings update in place.
 *
 * ### Creating a Mesh
 * **Example:** Generated name
 * ```typescript
 * const mesh = yield* GCP.NetworkServices.Mesh("Sidecar", {});
 * ```
 *
 * **Example:** Named mesh with interception port
 * ```typescript
 * const mesh = yield* GCP.NetworkServices.Mesh("Sidecar", {
 *   meshId: "app-mesh",
 *   description: "prod sidecar mesh",
 *   interceptionPort: 15001,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const Mesh = Resource<Mesh>("GCP.NetworkServices.Mesh");

const toAttrs = (mesh: networkservices.Mesh, project: string) => {
  const name = mesh.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    meshId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: mesh.description,
    interceptionPort: mesh.interceptionPort,
    envoyHeaders: mesh.envoyHeaders,
    labels: userLabels(mesh.labels),
    selfLink: mesh.selfLink,
    createTime: mesh.createTime,
    updateTime: mesh.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsMeshes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MeshProvider = () =>
  Provider.succeed(Mesh, {
    stables: [
      "name",
      "meshId",
      "project",
      "location",
      "createTime",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.meshId ?? output?.meshId;
      const nextId = news.meshId ? rfc1035(news.meshId, "mesh") : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const meshId = yield* toPhysicalId(
        id,
        olds?.meshId,
        output?.meshId,
        "mesh",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ?? resourceName(env.project, location, COLLECTION, meshId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsMeshes.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.meshes,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const meshId = yield* toPhysicalId(
        id,
        news.meshId,
        output?.meshId,
        "mesh",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, meshId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsMeshes({
            parent: parentOf(env.project, location),
            meshId,
            body: {
              description: news.description,
              labels: desiredLabels,
              interceptionPort: news.interceptionPort,
              envoyHeaders: news.envoyHeaders,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
        [
          "interceptionPort",
          (current.interceptionPort ?? 0) !== (news.interceptionPort ?? 0),
        ],
        [
          "envoyHeaders",
          (current.envoyHeaders ?? "") !== (news.envoyHeaders ?? ""),
        ],
      ]);

      if (updateMask.length > 0) {
        const operation = yield* networkservices.patchProjectsLocationsMeshes({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            interceptionPort: news.interceptionPort,
            envoyHeaders: news.envoyHeaders,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsMeshes({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
