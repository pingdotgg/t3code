import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  locationParent,
  normalizeLocation,
  parseName,
  projectIdOf,
  projectNameOf,
  replaceOnIdentity,
} from "./internal.ts";

export type RuntimeProjectAttachmentProps = {
  /**
   * Runtime project to attach, as `projects/{project}` or a bare project
   * id. Immutable — changing it replaces the attachment. The attachment
   * id must equal this project's id. Defaults to the stack project.
   */
  runtimeProject?: string;
  /**
   * Attachment id. Must equal the project id of `runtimeProject`. If
   * omitted, that project id is used. Immutable — changing it replaces
   * the attachment.
   */
  runtimeProjectAttachmentId?: string;
  /**
   * Location of the API Hub host (`us-central1`, …). Immutable —
   * changing it replaces the attachment.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
};

export type RuntimeProjectAttachment = Resource<
  "GCP.ApiHub.RuntimeProjectAttachment",
  RuntimeProjectAttachmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Attachment id (last path segment, equal to the runtime project id). */
    runtimeProjectAttachmentId: string;
    /** Host project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Runtime project resource name (`projects/{number}` on output). */
    runtimeProject: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Hub runtime project attachment. Attaching a runtime project
 * lets API Hub discover deployments in that project.
 *
 * Attachments have no labels, description, or display name, and the id
 * is forced to the runtime project id, so `list` cannot stamp ownership.
 * The resource is existence-only: runtime project and location are
 * identity, and there is nothing mutable to sync.
 *
 * ### Creating a Runtime Project Attachment
 * **Example:** Attach the stack project
 * ```typescript
 * const attachment = yield* GCP.ApiHub.RuntimeProjectAttachment(
 *   "Runtime",
 *   {},
 * );
 * ```
 *
 * **Example:** Attach a specific runtime project
 * ```typescript
 * const attachment = yield* GCP.ApiHub.RuntimeProjectAttachment(
 *   "Runtime",
 *   {
 *     runtimeProject: "projects/my-runtime",
 *     location: "us-central1",
 *   },
 * );
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const RuntimeProjectAttachment = Resource<RuntimeProjectAttachment>(
  "GCP.ApiHub.RuntimeProjectAttachment",
);

const resourceName = (
  project: string,
  location: string,
  attachmentId: string,
) =>
  `${locationParent(project, location)}/runtimeProjectAttachments/${attachmentId}`;

const toAttrs = (
  attachment: apihub.GoogleCloudApihubV1RuntimeProjectAttachment,
  project: string,
  region: string,
) => {
  const name = attachment.name ?? "";
  const parsed = parseName(name, "runtimeProjectAttachments", region);
  return {
    name,
    runtimeProjectAttachmentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    runtimeProject: attachment.runtimeProject,
    createTime: attachment.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsRuntimeProjectAttachments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RuntimeProjectAttachmentProvider = () =>
  Provider.succeed(RuntimeProjectAttachment, {
    stables: [
      "name",
      "runtimeProjectAttachmentId",
      "project",
      "location",
      "runtimeProject",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = projectIdOf(
        olds?.runtimeProject ?? output?.runtimeProject,
        "",
      );
      const nextProject = projectIdOf(
        news.runtimeProject ?? olds?.runtimeProject ?? output?.runtimeProject,
        previousProject,
      );
      return replaceOnIdentity({
        previousId:
          olds?.runtimeProjectAttachmentId ??
          output?.runtimeProjectAttachmentId,
        nextId:
          news.runtimeProjectAttachmentId ??
          olds?.runtimeProjectAttachmentId ??
          output?.runtimeProjectAttachmentId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousProject.length > 0 &&
          nextProject.length > 0 &&
          previousProject !== nextProject,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const runtimeProjectId = projectIdOf(
        olds?.runtimeProject ?? output?.runtimeProject,
        env.project,
      );
      const attachmentId =
        olds?.runtimeProjectAttachmentId ??
        output?.runtimeProjectAttachmentId ??
        runtimeProjectId;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, attachmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // Attachments cannot carry ownership metadata. Adopt only when the
      // observed id matches the deterministic runtime project id we would
      // have created; anything else is foreign.
      return attrs.runtimeProjectAttachmentId === attachmentId
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        // No labels or description — return nothing so nuke does not
        // delete foreign attachments.
        return yield* apihub.listProjectsLocationsRuntimeProjectAttachments
          .pages({
            parent: locationParent(env.project, env.region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.runtimeProjectAttachments ?? []),
            ),
            Stream.filter(
              (item) =>
                projectIdOf(item.runtimeProject, "") === env.project ||
                parseName(
                  item.name ?? "",
                  "runtimeProjectAttachments",
                  env.region,
                ).id === env.project,
            ),
            Stream.map((item) => toAttrs(item, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const runtimeProject = projectNameOf(news.runtimeProject, env.project);
      const attachmentId =
        news.runtimeProjectAttachmentId ??
        output?.runtimeProjectAttachmentId ??
        projectIdOf(runtimeProject, env.project);
      const name = resourceName(env.project, location, attachmentId);
      const parent = locationParent(env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsRuntimeProjectAttachments({
            parent,
            runtimeProjectAttachmentId: attachmentId,
            body: {
              runtimeProject,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* getByName(name));
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsRuntimeProjectAttachments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
