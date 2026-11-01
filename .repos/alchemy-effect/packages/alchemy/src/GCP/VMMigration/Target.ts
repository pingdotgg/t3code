import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  fieldMask,
  GLOBAL_LOCATION,
  globalParent,
  hasOwnershipMarker,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type TargetProps = {
  /**
   * Target project id (the `{targetProject}` segment of
   * `projects/{project}/locations/global/targetProjects/{targetProject}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the target.
   */
  targetProjectId?: string;
  /**
   * Compute Engine project id (or number) this target points at.
   * Defaults to the current Alchemy GCP project.
   */
  project?: string;
  /**
   * Free-text description. Target projects have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type Target = Resource<
  "GCP.VMMigration.Target",
  TargetProps,
  {
    /** Full resource name. */
    name: string;
    /** Target project id (last path segment). */
    targetProjectId: string;
    /** Host project id of the VM Migration resource. */
    hostProject: string;
    /** Compute Engine project this target points at. */
    project: string;
    /** Location id — always `global`. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration target project: the Compute Engine project clones and
 * cutovers land in.
 *
 * Target projects are global. They have no labels field — Alchemy stamps
 * ownership into the description so `list` / nuke can find them. The
 * resource id is immutable; `project` and `description` update in place.
 *
 * ### Creating a Target
 * **Example:** Point at the current project
 * ```typescript
 * const target = yield* GCP.VMMigration.Target("Default", {
 *   description: "this project",
 * });
 * ```
 *
 * **Example:** Explicit Compute Engine project
 * ```typescript
 * const target = yield* GCP.VMMigration.Target("Prod", {
 *   project: "prod-compute",
 *   description: "production landing zone",
 * });
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const Target = Resource<Target>("GCP.VMMigration.Target");

const resourceName = (hostProject: string, targetProjectId: string) =>
  `${globalParent(hostProject)}/targetProjects/${targetProjectId}`;

const toAttrs = (target: vm.TargetProject, hostProject: string) => {
  const name = target.name ?? "";
  const parsed = parseName(name, "targetProjects", "global");
  const ownership = parseOwnership(target.description);
  return {
    name,
    targetProjectId: parsed.id,
    hostProject: parsed.project || hostProject,
    project: target.project ?? parsed.project ?? hostProject,
    location: GLOBAL_LOCATION,
    description: ownership.text,
    createTime: target.createTime,
    updateTime: target.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsTargetProjects({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  vm.listProjectsLocationsTargetProjects
    .pages({
      parent: globalParent(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.targetProjects ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as vm.TargetProject[]),
      ),
    );

export const TargetProvider = () =>
  Provider.succeed(Target, {
    stables: [
      "name",
      "targetProjectId",
      "hostProject",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.targetProjectId ?? output?.targetProjectId,
        nextId:
          news?.targetProjectId ??
          olds?.targetProjectId ??
          output?.targetProjectId,
        previousLocation: GLOBAL_LOCATION,
        nextLocation: GLOBAL_LOCATION,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetProjectId = yield* toPhysicalId(
        id,
        olds?.targetProjectId,
        output?.targetProjectId,
        "target",
      );
      const name = output?.name ?? resourceName(env.project, targetProjectId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetProjectId = yield* toPhysicalId(
        id,
        news?.targetProjectId,
        output?.targetProjectId,
        "target",
      );
      const name = resourceName(env.project, targetProjectId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news?.description);
      const project = news?.project ?? env.project;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsTargetProjects({
            parent: globalParent(env.project),
            targetProjectId,
            body: {
              project,
              description,
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

      const descriptionChanged = (current.description ?? "") !== description;
      const projectChanged = (current.project ?? "") !== project;
      const mask = fieldMask([
        descriptionChanged && "description",
        projectChanged && "project",
      ]);

      if (mask.length > 0) {
        const operation = yield* vm.patchProjectsLocationsTargetProjects({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            project,
            description,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vm
        .deleteProjectsLocationsTargetProjects({ name: output.name })
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
