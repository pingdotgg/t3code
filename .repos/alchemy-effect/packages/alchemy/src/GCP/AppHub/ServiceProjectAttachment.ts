import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  GLOBAL_LOCATION,
  locationParent,
  parseName,
  projectIdOf,
  projectNameOf,
  replaceOnIdentity,
  ResourceNotResolved,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ServiceProjectAttachmentProps = {
  /**
   * Service project to attach, as `projects/{project}` or a bare project
   * id. Immutable — changing it replaces the attachment. The attachment
   * id must equal this project's id. Defaults to the stack project.
   */
  serviceProject?: string;
  /**
   * Attachment id. Must equal the project id of `serviceProject`. If
   * omitted, that project id is used. Immutable — changing it replaces
   * the attachment.
   */
  serviceProjectAttachmentId?: string;
  /**
   * Location of the host project. App Hub only supports `global`.
   * @default "global"
   */
  location?: string;
};

export type ServiceProjectAttachment = Resource<
  "GCP.AppHub.ServiceProjectAttachment",
  ServiceProjectAttachmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Attachment id (last path segment, equal to the service project id). */
    serviceProjectAttachmentId: string;
    /** Host project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** Service project resource name (`projects/{number}` on output). */
    serviceProject: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Hub service project attachment. Service projects hold the
 * underlying cloud resources and expose them to a host project so App
 * Hub can provide an aggregated view.
 *
 * Attachments have no labels, description, or display name, and the id
 * is forced to the service project id, so `list` cannot stamp ownership.
 * Location is always `global`. The resource is existence-only: service
 * project is identity, and there is nothing mutable to sync.
 *
 * ### Creating a Service Project Attachment
 * **Example:** Attach the stack project
 * ```typescript
 * const attachment = yield* GCP.AppHub.ServiceProjectAttachment(
 *   "Host",
 *   {},
 * );
 * ```
 *
 * **Example:** Attach a specific service project
 * ```typescript
 * const attachment = yield* GCP.AppHub.ServiceProjectAttachment(
 *   "Payments",
 *   { serviceProject: "projects/my-service" },
 * );
 * ```
 *
 * @resource
 * @category AppHub
 */
export const ServiceProjectAttachment = Resource<ServiceProjectAttachment>(
  "GCP.AppHub.ServiceProjectAttachment",
);

const resourceName = (
  project: string,
  location: string,
  attachmentId: string,
) =>
  `${locationParent(project, location)}/serviceProjectAttachments/${attachmentId}`;

const toAttrs = (item: apphub.ServiceProjectAttachment, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "serviceProjectAttachments", GLOBAL_LOCATION);
  return {
    name,
    serviceProjectAttachmentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || GLOBAL_LOCATION,
    serviceProject: item.serviceProject,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apphub
        .getProjectsLocationsServiceProjectAttachments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceProjectAttachmentProvider = () =>
  Provider.succeed(ServiceProjectAttachment, {
    stables: [
      "name",
      "serviceProjectAttachmentId",
      "project",
      "location",
      "serviceProject",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = projectIdOf(
        olds?.serviceProject ?? output?.serviceProject,
        "",
      );
      const nextProject = projectIdOf(
        news.serviceProject ?? olds?.serviceProject ?? output?.serviceProject,
        previousProject,
      );
      return replaceOnIdentity({
        previousId:
          olds?.serviceProjectAttachmentId ??
          output?.serviceProjectAttachmentId,
        nextId:
          news.serviceProjectAttachmentId ??
          olds?.serviceProjectAttachmentId ??
          output?.serviceProjectAttachmentId,
        previousLocation: GLOBAL_LOCATION,
        nextLocation: GLOBAL_LOCATION,
        extra:
          previousProject.length > 0 &&
          nextProject.length > 0 &&
          previousProject !== nextProject,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceProjectId = projectIdOf(
        olds?.serviceProject ?? output?.serviceProject,
        env.project,
      );
      const attachmentId =
        olds?.serviceProjectAttachmentId ??
        output?.serviceProjectAttachmentId ??
        serviceProjectId;
      const name =
        output?.name ??
        resourceName(env.project, GLOBAL_LOCATION, attachmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return attrs.serviceProjectAttachmentId === attachmentId
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apphub.listProjectsLocationsServiceProjectAttachments
          .pages({
            parent: locationParent(env.project, GLOBAL_LOCATION),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.serviceProjectAttachments ?? []),
            ),
            Stream.filter(
              (item) =>
                projectIdOf(item.serviceProject, "") === env.project ||
                parseName(
                  item.name ?? "",
                  "serviceProjectAttachments",
                  GLOBAL_LOCATION,
                ).id === env.project,
            ),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            // No global location yet: no attachments.
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceProject = projectNameOf(news.serviceProject, env.project);
      const attachmentId =
        news.serviceProjectAttachmentId ??
        output?.serviceProjectAttachmentId ??
        projectIdOf(serviceProject, env.project);
      const name = resourceName(env.project, GLOBAL_LOCATION, attachmentId);
      const parent = locationParent(env.project, GLOBAL_LOCATION);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apphub
          .createProjectsLocationsServiceProjectAttachments({
            parent,
            serviceProjectAttachmentId: attachmentId,
            body: {
              serviceProject,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apphub
        .deleteProjectsLocationsServiceProjectAttachments({
          name: output.name,
        })
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
