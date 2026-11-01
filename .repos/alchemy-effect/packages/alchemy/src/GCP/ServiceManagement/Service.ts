import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  getByName,
  getLatestConfig,
  isGeneratedServiceName,
  listProducerServices,
  ServiceNotResolved,
  toServiceName,
  undeleteService,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export { ServiceNotResolved };

export type ServiceProps = {
  /**
   * DNS service name (for example
   * `hello.endpoints.my-project.cloud.goog`). If omitted, Alchemy
   * generates `{alch-…}.endpoints.{project}.cloud.goog` from the stack,
   * stage, and logical id. Immutable — changing it replaces the service.
   * After delete the name is reserved for 30 days; reconcile undeletes
   * instead of recreating.
   */
  serviceName?: string;
  /**
   * Display title stored on the service config. Changing it writes a new
   * config version.
   */
  title?: string;
  /**
   * Producer project id. Defaults to the current stack project.
   * Immutable — changing it replaces the service.
   */
  producerProjectId?: string;
};

export type Service = Resource<
  "GCP.ServiceManagement.Service",
  ServiceProps,
  {
    /** DNS service name. */
    serviceName: string;
    /** Producer project id. */
    producerProjectId: string;
    /** Project id used when the service was reconciled. */
    project: string;
    /** Title of the newest service config. */
    title: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Service Management managed service (Cloud Endpoints producer
 * service).
 *
 * A managed service is identity-only and immutable. Create and delete
 * return long-running operations. After delete the name stays reserved
 * for 30 days — reconcile undeletes rather than recreating. There is no
 * labels field: `list` / `pnpm nuke:gcp` find services by their generated
 * `alch-` name, and `read` reports an explicitly named service it has no
 * state for as unowned. Changing `serviceName` or `producerProjectId`
 * replaces the service. `title` updates in place by writing a new config
 * version.
 *
 * ### Creating a Service
 * **Example:** Generated Endpoints name
 * ```typescript
 * const api = yield* GCP.ServiceManagement.Service("Hello", {
 *   title: "Hello API",
 * });
 * ```
 *
 * **Example:** Explicit DNS name
 * ```typescript
 * const api = yield* GCP.ServiceManagement.Service("Hello", {
 *   serviceName: "hello.endpoints.my-project.cloud.goog",
 *   title: "Hello API",
 * });
 * ```
 *
 * ### Updating a Service
 * **Example:** Change the display title
 * ```typescript
 * const api = yield* GCP.ServiceManagement.Service("Hello", {
 *   title: "Hello API v2",
 * });
 * ```
 *
 * @resource
 * @category ServiceManagement
 */
export const Service = Resource<Service>("GCP.ServiceManagement.Service");

const toAttrs = (
  service: servicemanagement.ManagedService,
  project: string,
  title: string | undefined,
) => {
  const serviceName = service.serviceName ?? "";
  return {
    serviceName,
    producerProjectId: service.producerProjectId ?? project,
    project,
    title,
  };
};

const toAttrsLive = (
  service: servicemanagement.ManagedService,
  project: string,
) =>
  Effect.gen(function* () {
    const serviceName = service.serviceName ?? "";
    const config =
      serviceName.length > 0 ? yield* getLatestConfig(serviceName) : undefined;
    return toAttrs(service, project, config?.title);
  });

const desiredProducer = (
  news: ServiceProps,
  project: string,
  existing?: string,
) => news.producerProjectId ?? existing ?? project;

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceName", "producerProjectId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.serviceName ?? output?.serviceName;
      if (
        previousName !== undefined &&
        news.serviceName !== undefined &&
        news.serviceName !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousProducer =
        olds?.producerProjectId ?? output?.producerProjectId;
      if (
        previousProducer !== undefined &&
        news.producerProjectId !== undefined &&
        news.producerProjectId !== previousProducer
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceName = yield* toServiceName(
        id,
        olds?.serviceName,
        output?.serviceName,
        env.project,
      );
      const existing = yield* getByName(serviceName);
      if (existing === undefined) return undefined;
      const attrs = yield* toAttrsLive(existing, env.project);
      // Managed services have no labels. A generated `alch-` name derives
      // from this stack, stage and logical id; any other name is only ours
      // when state already records it.
      return output !== undefined ||
        isGeneratedServiceName(serviceName, env.project)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const services = yield* listProducerServices(env.project);
        return yield* Effect.forEach(
          services.filter((service) =>
            isGeneratedServiceName(service.serviceName ?? "", env.project),
          ),
          (service) => toAttrsLive(service, env.project),
          { concurrency: 4 },
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceName = yield* toServiceName(
        id,
        news.serviceName,
        output?.serviceName,
        env.project,
      );
      const producerProjectId = desiredProducer(
        news,
        env.project,
        output?.producerProjectId,
      );

      let current = yield* getByName(serviceName);

      if (current === undefined) {
        // A name deleted in the last 30 days is soft-deleted: undelete it.
        const created = yield* servicemanagement
          .createServices({
            body: {
              serviceName,
              producerProjectId,
            },
          })
          .pipe(
            Effect.catchTag(["Conflict", "ServiceSoftDeleted"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
          current = yield* waitUntilExists(serviceName);
        } else {
          current =
            (yield* undeleteService(serviceName)) ??
            (yield* waitUntilExists(serviceName));
        }
      }

      const config = yield* getLatestConfig(serviceName);
      if (news.title !== undefined && (config?.title ?? "") !== news.title) {
        // A new service is briefly invisible to the config API.
        yield* servicemanagement
          .createServicesConfigs({
            serviceName,
            body: {
              name: serviceName,
              title: news.title,
              producerProjectId,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "NotFound" || error._tag === "ServiceNotFound",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
      }

      return yield* toAttrsLive(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* servicemanagement
        .deleteServices({ serviceName: output.serviceName })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.serviceName);
    }),
  });
