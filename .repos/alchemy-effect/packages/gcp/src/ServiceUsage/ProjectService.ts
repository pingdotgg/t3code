import * as serviceusage from "@distilled.cloud/gcp/serviceusage_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

export type ProjectServiceProps = {
  /**
   * Project to enable the API in. Defaults to the current GCP project.
   * Changing it replaces the resource.
   */
  project?: string;
  /**
   * Service identifier, such as `compute.googleapis.com`. Changing it
   * replaces the resource.
   */
  service: string;
  /**
   * Disable the API when this resource is destroyed. Leave unset for APIs
   * shared with resources outside this stack: disabling is project-wide.
   * @default false
   */
  disableOnDestroy?: boolean;
};

export type ProjectService = Resource<
  "GCP.ServiceUsage.ProjectService",
  ProjectServiceProps,
  {
    /** Project the API is enabled in. */
    project: string;
    /** Service identifier, such as `compute.googleapis.com`. */
    service: string;
    /** Service Usage consumer state. */
    state: serviceusage.GoogleApiServiceusageV1ServiceStateEnum;
    /** Whether destroy disables the API. */
    disableOnDestroy: boolean;
  },
  never,
  Providers
>;

/**
 * Enables a Google Cloud API for a project — the GCP analog of a
 * Terraform `google_project_service`.
 *
 * Service Usage has no per-caller ownership marker, so an API that is
 * already enabled (by another stack, the console, or a dependent service)
 * is adopted as-is. By default destroy only releases Alchemy state and
 * leaves the API enabled. Set `disableOnDestroy` only for APIs this stack
 * alone relies on: it disables the API project-wide, even if it was
 * enabled before this stack adopted it.
 *
 * ### Enabling an API
 * **Example:** Enable Compute Engine before creating a network
 * ```typescript
 * const computeApi = yield* GCP.ServiceUsage.ProjectService("ComputeApi", {
 *   service: "compute.googleapis.com",
 * });
 * ```
 *
 * **Example:** Disable the API on destroy
 * ```typescript
 * yield* GCP.ServiceUsage.ProjectService("TranslateApi", {
 *   service: "translate.googleapis.com",
 *   disableOnDestroy: true,
 * });
 * ```
 *
 * @resource
 * @category Service Usage
 */
export const ProjectService = Resource<ProjectService>("GCP.ServiceUsage.ProjectService");

export class ProjectServiceNotEnabled extends Data.TaggedError(
  "GCP.ServiceUsage.ProjectServiceNotEnabled",
)<{
  project: string;
  service: string;
}> {}

const normalizeService = (service: string) =>
  service.replace(/^services\//, "").replace(/^\/+|\/+$/g, "");

const serviceName = (project: string, service: string) =>
  `projects/${project}/services/${normalizeService(service)}`;

const getService = (project: string, service: string) =>
  serviceusage
    .getServices({ name: serviceName(project, service) })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

// Enabling an API usually finishes in well under a minute, but first-time
// enables of heavier APIs (Compute, GKE) can take a few.
const waitForServiceOperation = (operation: serviceusage.Operation) =>
  waitForOperation(operation, (name) => serviceusage.getOperations({ name }), {
    budget: "5 minutes",
  });

const toAttrs = (
  project: string,
  service: string,
  state: serviceusage.GoogleApiServiceusageV1ServiceStateEnum,
  disableOnDestroy: boolean,
): ProjectService["Attributes"] => ({
  project,
  service: normalizeService(service),
  state,
  disableOnDestroy,
});

export const ProjectServiceProvider = () =>
  Provider.succeed(ProjectService, {
    stables: ["project", "service"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = olds?.project ?? output?.project;
      const previousService = olds?.service ?? output?.service;
      if (
        (previousProject !== undefined &&
          news.project !== undefined &&
          news.project !== previousProject) ||
        (previousService !== undefined &&
          normalizeService(news.service) !== normalizeService(previousService))
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const service = olds?.service ?? output?.service;
      if (service === undefined) return undefined;
      const current = yield* getService(project, service);
      if (current?.state !== "ENABLED") return undefined;
      return toAttrs(
        project,
        service,
        current.state,
        olds?.disableOnDestroy ?? output?.disableOnDestroy ?? false,
      );
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      // Keep the project chosen on create when an explicit `project` prop
      // is later omitted, matching `read` and the stable-property contract.
      const project = news.project ?? output?.project ?? env.project;
      const service = normalizeService(news.service);

      // Observe
      let current = yield* getService(project, service);

      // Ensure — enabling an already-enabled API is a no-op, so skip it.
      if (current?.state !== "ENABLED") {
        const operation = yield* serviceusage.enableServices({
          name: serviceName(project, service),
          body: {},
        });
        yield* waitForServiceOperation(operation);
        // The operation can finish before `getServices` reports ENABLED.
        current = yield* getService(project, service).pipe(
          Effect.flatMap((value) =>
            value?.state === "ENABLED"
              ? Effect.succeed(value)
              : Effect.fail(new ProjectServiceNotEnabled({ project, service })),
          ),
          Effect.retry({
            while: (error) => error._tag === "GCP.ServiceUsage.ProjectServiceNotEnabled",
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
          }),
        );
      }
      return toAttrs(project, service, current.state ?? "ENABLED", news.disableOnDestroy === true);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.disableOnDestroy !== true) return;
      const current = yield* getService(output.project, output.service);
      if (current?.state !== "ENABLED") return;
      const operation = yield* serviceusage.disableServices({
        name: serviceName(output.project, output.service),
        body: {},
      });
      yield* waitForServiceOperation(operation);
    }),
  });
