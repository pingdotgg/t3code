import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource } from "../Resource.ts";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createInternalTags, hasAlchemyTags } from "../Tags.ts";
import {
  Docker,
  dockerEngineContextName,
  dockerPhysicalName,
} from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import { makeServiceImage } from "./ServiceImage.ts";

export interface ServicePropsBase extends PlatformProps {
  /**
   * Service name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /**
   * The engine the service is deployed to: a Docker context name, a
   * `Docker.Context` resource, or a `Docker.Swarm` — passing the swarm also
   * orders the service after the swarm is initialized.
   */
  context?: Docker.EngineRef;
  /** Entrypoint command passed after the image. */
  command?: string[];
  /** Additional args appended after `command`. */
  args?: string[];
  /** Environment variables. Use Redacted for secrets. */
  environment?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Environment variables injected by the platform (bound `Config` values and
   * future bindings). Merged after `environment`; usually not set directly.
   */
  env?: Record<string, any>;
  /** Overlay networks attached to this service. */
  networks?: Array<string | Service.NetworkAttachment>;
  /** Published port mappings. */
  ports?: Service.PortMapping[];
  /**
   * Service discovery endpoint mode.
   *
   * @default "vip"
   */
  endpointMode?: "vip" | "dnsrr";
  /**
   * Desired number of service replicas.
   *
   * @default 1
   */
  replicas?: number;
  /** Placement controls for task scheduling. */
  placement?: Service.Placement;
  /** Deprecated alias for `placement.constraints`. */
  constraints?: string[];
  /** Rolling update strategy for service updates. */
  updateConfig?: Service.RolloutConfig;
  /** Rollback strategy applied when updates fail. */
  rollbackConfig?: Service.RolloutConfig;
  /** Task restart behavior. */
  restartPolicy?: Service.RestartPolicy;
  /** Container healthcheck for service tasks. */
  healthcheck?: Service.Healthcheck;
  /** Grace period before force-killing a task during shutdown, e.g. `"30s"`. */
  stopGracePeriod?: string;
  /** Volume or bind mounts. */
  volumes?: Service.VolumeMapping[];
  /** Swarm secrets mounted into task containers. */
  secrets?: Service.SecretRef[];
  /** Swarm configs mounted into task containers. */
  configs?: Service.ConfigRef[];
  /**
   * Mount task root filesystem read-only.
   *
   * @default false
   */
  readOnlyRootFs?: boolean;
  /**
   * Service labels. Alchemy's internal ownership labels are added
   * automatically.
   */
  labels?: Record<string, string>;
}

/**
 * Run a pre-built image: a registry reference or a Docker image resource
 * (`Docker.Image` / `Docker.RemoteImage`).
 */
export interface ImageServiceProps extends ServicePropsBase {
  /** Docker image reference or Docker image resource. */
  image: Service.Image;
  main?: undefined;
}

/**
 * Bundle an inline Effect program (`main`) into a generated image built
 * against the service's Docker context. The optional `image` is the
 * environment base (`FROM`) and must be able to run the bun runtime.
 */
export interface BundledServiceProps extends ServicePropsBase {
  /**
   * Module entrypoint for the bundled program. This should typically be
   * `import.meta.url` (or `import.meta.filename`) from an inline Effect
   * program.
   */
  main: string;
  /**
   * Environment image used as the generated Dockerfile's `FROM`. Must be
   * able to run the bun runtime.
   *
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * Container port the bundled HTTP server listens on. Baked into the image
   * as `ENV PORT` + `EXPOSE`; publish it to the swarm ingress with `ports`.
   */
  port?: number;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /** Bundler configuration for the entrypoint. */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
}

/**
 * Service props — the image comes from exactly one of two sources, flat on
 * the props: `image` (a pre-built reference) or `main` (a bundled Effect
 * program).
 */
export type ServiceProps = ImageServiceProps | BundledServiceProps;

export declare namespace Service {
  type Image = string | { imageRef: string };

  interface PortMapping {
    /** Published port on the swarm node. Omit to let Swarm assign one dynamically. */
    external?: number;
    /** Container port receiving traffic. */
    internal: number;
    /**
     * Protocol used for the mapping.
     *
     * @default "tcp"
     */
    protocol?: "tcp" | "udp";
    /**
     * Publish through the swarm routing mesh (`ingress`) or directly on each
     * node (`host`).
     *
     * @default "ingress"
     */
    mode?: "ingress" | "host";
  }

  interface VolumeMapping {
    /** Host path or named volume source. */
    hostPath: string;
    /** Container path. */
    containerPath: string;
    /**
     * Mount read-only.
     *
     * @default false
     */
    readOnly?: boolean;
  }

  interface NetworkAttachment {
    /** Network name. */
    name: string;
    /** Network aliases for the service's tasks. */
    aliases?: string[];
  }

  interface Placement {
    /** Placement constraints, e.g. `"node.role==worker"`. */
    constraints?: string[];
    /** Placement preferences, e.g. `"spread=node.labels.zone"`. */
    preferences?: string[];
    /** Maximum number of replicas per swarm node. */
    maxReplicasPerNode?: number;
  }

  interface RolloutConfig {
    /** Number of tasks updated simultaneously. */
    parallelism?: number;
    /** Delay between task updates, e.g. `"10s"`. */
    delay?: string;
    /** Duration to monitor each updated task for failure, e.g. `"30s"`. */
    monitor?: string;
    /** Action on update failure. */
    failureAction?: "pause" | "continue" | "rollback";
    /** Failure ratio tolerated during an update. */
    maxFailureRatio?: number;
    /** Operation order during updates. */
    order?: "stop-first" | "start-first";
  }

  interface RestartPolicy {
    /** Condition under which tasks restart. */
    condition?: "none" | "on-failure" | "any";
    /** Delay between restart attempts, e.g. `"5s"`. */
    delay?: string;
    /** Maximum restart attempts before giving up. */
    maxAttempts?: number;
    /** Window used to evaluate the restart policy, e.g. `"120s"`. */
    window?: string;
  }

  interface Healthcheck {
    /** Command to run for health checks. */
    cmd: string[] | string;
    /** Time between checks, e.g. `"30s"`. */
    interval?: string;
    /** Maximum time a check may run, e.g. `"5s"`. */
    timeout?: string;
    /** Consecutive failures before unhealthy. */
    retries?: number;
    /** Startup grace period, e.g. `"30s"`. */
    startPeriod?: string;
  }

  interface SecretRef {
    /** Swarm secret name. */
    source: string;
    /** Target file name in `/run/secrets/`. Defaults to `source`. */
    target?: string;
    /** File owner uid. */
    uid?: string;
    /** File owner gid. */
    gid?: string;
    /** File mode, e.g. `0o400`. */
    mode?: number | string;
  }

  interface ConfigRef {
    /** Swarm config name. */
    source: string;
    /** Target path in the container. Defaults to `/<source>`. */
    target?: string;
    /** File owner uid. */
    uid?: string;
    /** File owner gid. */
    gid?: string;
    /** File mode, e.g. `0o444`. */
    mode?: number | string;
  }
}

export interface Service extends Resource<
  "Docker.Service",
  ServiceProps,
  {
    /** Swarm service id. */
    id: string;
    /** Swarm service name. */
    name: string;
    /** Docker context the service is deployed to. */
    context?: string;
    /** Image reference the service runs. */
    image: string;
    /** Desired number of replicas. */
    replicas: number;
    /** Network ids the service's tasks attach to. */
    networks: string[];
    /** Published port mappings reported by Swarm. */
    ports: Service.PortMapping[];
    /** Service labels reported by Swarm. */
    labels: Record<string, string>;
    /** Service discovery endpoint mode. */
    endpointMode: "vip" | "dnsrr";
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Last update timestamp in milliseconds since epoch. */
    updatedAt: number;
    /** Content hash of the bundled program's image (`main` form only). */
    code?: {
      /** Content hash of the bundled program's image. */
      hash: string;
    };
  },
  never,
  Providers
> {}

/** Services available to an effectful `Service` impl at init time. */
export type ServiceServices = ServerHost;

/**
 * The impl shape for an effectful `Service`: a long-running server returning
 * `{ fetch }` (plus optional RPC methods).
 */
export type ServiceShape = Main<ServiceServices>;

export interface ServiceRuntimeContext extends HostRuntimeContext {
  readonly Type: "Docker.Service";
}

/**
 * A Docker Swarm service: N replicas of a container kept alive by the swarm,
 * deployed through the active (or a named) Docker context.
 *
 * The target engine must be a swarm manager — `Service` wraps
 * `docker service`, swarm mode's orchestration API. Declare the swarm with
 * `Docker.Swarm` and pass it as `context` so the service deploys after the
 * swarm exists; for a plain single container on a non-swarm daemon use
 * `Docker.Container` instead.
 *
 * The service's image comes from one of two sources:
 *
 * - `image` — run a pre-built reference (a registry ref, or a `Docker.Image`
 *   / `Docker.RemoteImage` resource).
 * - `main` — bundle an inline Effect program into a generated bun image,
 *   built directly against the service's Docker context. The impl returns
 *   `{ fetch }` and may register background loops via `ServerHost.run` —
 *   the same effectful platform shape as `AWS.ECS.Service`.
 *
 * The bundled image is content-addressed and only rebuilt when the program
 * (or its generated Dockerfile) changes. It is built on the target engine's
 * local store — single-node swarms run it as-is; multi-node swarms need the
 * image on a registry every node can reach (build with `Docker.Image` +
 * `registry` and pass the pushed ref as `image` instead).
 *
 * Only replicated services are supported. Configuration changes replace the
 * service (delete-then-create); swarm tasks are stateless, so replacement is
 * cheap and avoids partially-applied `service update` drift.
 * ### Creating Services
 * **Example:** Replicated Nginx
 * ```typescript
 * const swarm = yield* Docker.Swarm("swarm");
 * const web = yield* Docker.Service("web", {
 *   context: swarm,
 *   image: "nginx:alpine",
 *   replicas: 3,
 *   ports: [{ external: 8080, internal: 80 }],
 * });
 * ```
 *
 * **Example:** Run a Built Image
 * ```typescript
 * const image = yield* Docker.Image("app-image", {
 *   build: { context: "./app" },
 * });
 * const app = yield* Docker.Service("app", {
 *   context: swarm,
 *   image,
 *   replicas: 2,
 * });
 * ```
 *
 * ### Effectful Services
 * **Example:** Inline Effect Server
 * ```typescript
 * const swarm = yield* Docker.Swarm("swarm");
 * const api = yield* Docker.Service(
 *   "Api",
 *   {
 *     context: swarm,
 *     main: import.meta.url,
 *     port: 3000,
 *     ports: [{ external: 8080, internal: 3000 }],
 *     replicas: 2,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** Background Loops with ServerHost
 * ```typescript
 * // Class props may be an Effect, so the service can yield the swarm it
 * // deploys into (declared once at module level).
 * const Swarm = Docker.Swarm("swarm");
 *
 * export default class Worker extends Docker.Service<Worker>()(
 *   "Worker",
 *   Effect.gen(function* () {
 *     const swarm = yield* Swarm;
 *     return { context: swarm, main: import.meta.url, port: 3000 };
 *   }),
 *   Effect.gen(function* () {
 *     const host = yield* ServerHost;
 *     yield* host.run(
 *       pollQueue.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.asVoid),
 *     );
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Top-level calls in the
 * `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`, and
 * `@distilled.cloud/*` packages receive `#__PURE__` annotations by
 * default, so anything the service doesn't use from those packages is
 * tree-shaken out of the bundle. Any other package — including your own
 * app — is left untouched unless you list it explicitly.
 *
 * **Example:** Treat additional packages as pure
 * Pass package names (or picomatch globs) via `build.pure.packages` to
 * annotate them in addition to the defaults.
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * }
 * ```
 *
 * Listing a package annotates calls whose result is bound (variable
 * initializers, exports) — safe anywhere. If a listed package also
 * declares `"sideEffects": false` (or `[]`) in its `package.json`, that
 * combination opts it into full annotation: top-level calls whose result
 * is discarded (e.g. `router.on("/path", handler)` registrations) are
 * also marked pure and deleted under minification when unused. Only list
 * a `sideEffects: false` package if its modules really are free of
 * meaningful top-level side effects. The `effect`, `alchemy`, and
 * `@distilled.cloud` defaults declare exactly that, on purpose — their
 * modules are designed to be fully tree-shakeable.
 *
 * **Example:** Disable pure annotations
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: { pure: false },
 * }
 * ```
 *
 * ### Docker Contexts
 * **Example:** Deploy to a Remote Swarm over SSH
 * ```typescript
 * const vps = yield* Docker.Context("vps", {
 *   docker: "host=ssh://deploy@example.com",
 * });
 * const swarm = yield* Docker.Swarm("swarm", {
 *   context: vps,
 *   advertiseAddr: "10.0.0.1",
 * });
 * const app = yield* Docker.Service("app", {
 *   context: swarm,
 *   image: "nginx:alpine",
 *   replicas: 3,
 * });
 * ```
 *
 * ### Networks & Volumes
 * **Example:** Overlay Network with Aliases
 * ```typescript
 * const network = yield* Docker.Network("app-net", {
 *   context: swarm,
 *   driver: "overlay",
 * });
 * const db = yield* Docker.Service("db", {
 *   context: swarm,
 *   image: "postgres:18-alpine",
 *   networks: [{ name: network.name, aliases: ["postgres"] }],
 *   volumes: [{ hostPath: "pg-data", containerPath: "/var/lib/postgresql/data" }],
 * });
 * ```
 *
 * ### Rollouts & Placement
 * **Example:** Rolling Update with Rollback
 * ```typescript
 * const app = yield* Docker.Service("app", {
 *   image: "ghcr.io/acme/app:latest",
 *   replicas: 4,
 *   updateConfig: {
 *     parallelism: 1,
 *     delay: "10s",
 *     failureAction: "rollback",
 *     order: "start-first",
 *   },
 *   placement: {
 *     constraints: ["node.role==worker"],
 *     maxReplicasPerNode: 2,
 *   },
 * });
 * ```
 *
 * ### Secrets & Configs
 * **Example:** Mount Swarm Secrets
 * ```typescript
 * const app = yield* Docker.Service("app", {
 *   image: "ghcr.io/acme/app:latest",
 *   secrets: [{ source: "db-password", target: "db_password", mode: 0o400 }],
 *   configs: [{ source: "app-config", target: "/etc/app/config.yaml" }],
 * });
 * ```
 *
 * @resource
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Docker.Service", {
  createRuntimeContext: createContainerRuntimeContext("Docker.Service") as (
    id: string,
  ) => ServiceRuntimeContext,
});

/** True when the props declare a bundled `main` program. */
const isBundledService = (props: ServiceProps): props is BundledServiceProps =>
  typeof (props as BundledServiceProps).main === "string";

type ServiceInspect = {
  ID: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  Spec: {
    Name: string;
    Labels?: Record<string, string> | null;
    TaskTemplate?: {
      ContainerSpec?: {
        Image?: string;
      };
      Networks?: Array<{ Target?: string }>;
      Placement?: {
        Constraints?: string[];
      };
    };
    Mode?: {
      Replicated?: {
        Replicas?: number;
      };
      Global?: Record<string, never>;
    };
    EndpointSpec?: {
      Mode?: "vip" | "dnsrr";
      Ports?: Array<{
        PublishedPort?: number;
        TargetPort?: number;
        Protocol?: "tcp" | "udp";
        PublishMode?: "ingress" | "host";
      }>;
    };
  };
};

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const stack = yield* Stack;
      const serviceImage = yield* makeServiceImage;

      // The bundled program's bootstrap reads these to rebuild the Stack at
      // container runtime (same contract as the ECS bootstrap).
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const inspect = (id: string, context?: string) =>
        docker.service.inspect(id, context).pipe(
          Effect.map((result) => normalizeServiceInspect(result)),
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.undefined,
          ),
        );

      /**
       * Resolve the image the service should run: build the bundled `main`
       * program (content-addressed, skipped when already present in the
       * target engine) or normalize the pre-built reference.
       */
      const resolveImage = Effect.fn(function* (
        id: string,
        props: ServiceProps,
        name: string,
        context: string | undefined,
        session: { note: (message: string) => Effect.Effect<void> },
      ) {
        if (isBundledService(props)) {
          return yield* serviceImage.resolve({
            id,
            source: props,
            name,
            context,
            isExternal: props.isExternal,
            session,
          });
        }
        return {
          imageRef: normalizeImageRef(props.image),
          codeHash: undefined,
        };
      });

      return Service.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* servicePhysicalName(id, olds, instanceId);
          const context = dockerEngineContextName(olds?.context);
          const live = yield* inspect(name, context);
          if (!live) return undefined;
          ensureReplicatedMode(live);
          const attrs = toServiceAttributes(live, context, output?.code);
          if (output) return attrs;
          const owned = yield* hasAlchemyTags(
            id,
            live.Spec.Labels ?? undefined,
          );
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          if (!isResolved(news)) return undefined;

          const oldDesired = yield* normalizeDesired(id, olds, instanceId);
          const newDesired = yield* normalizeDesired(id, news, instanceId);

          if (!Equal.equals(oldDesired, newDesired)) {
            return { action: "replace" as const, deleteFirst: true };
          }

          // Bundled program: the image identity is the content hash — a code
          // or bootstrap change replaces the service with the new image.
          if (isBundledService(news)) {
            const hash = yield* serviceImage.hash({
              source: news,
              isExternal: news.isExternal,
            });
            if (hash !== output?.code?.hash) {
              return { action: "replace" as const, deleteFirst: true };
            }
          }

          return { action: "noop" as const };
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          olds,
          output,
          session,
        }) {
          const desired = yield* normalizeDesired(id, news, instanceId);
          const resolved = yield* resolveImage(
            id,
            news,
            desired.name,
            desired.context,
            session,
          );
          const image = resolved.imageRef;
          const code = resolved.codeHash
            ? { hash: resolved.codeHash }
            : undefined;
          const environment = isBundledService(news)
            ? { ...alchemyEnv, ...desired.environment }
            : desired.environment;

          if (output && olds) {
            const oldDesired = yield* normalizeDesired(id, olds, instanceId);
            if (
              deepEqual(oldDesired, desired) &&
              (resolved.codeHash === undefined ||
                resolved.codeHash === output.code?.hash)
            ) {
              const current = yield* inspect(output.id, desired.context);
              if (current) {
                ensureReplicatedMode(current);
                return toServiceAttributes(current, desired.context, code);
              }
            }
          }

          if (output) {
            const current = yield* inspect(output.id, desired.context);
            if (current) {
              ensureReplicatedMode(current);
              const internalTags = yield* createInternalTags(id);
              const allDesiredLabels = { ...internalTags, ...desired.labels };
              const currentLabels = current.Spec.Labels ?? {};
              const labelsToRemove = Object.keys(currentLabels).filter(
                (k) => !(k in allDesiredLabels),
              );
              yield* docker.service.update({
                context: desired.context,
                id: output.id,
                image,
                replicas: desired.replicas,
                "endpoint-mode": desired.endpointMode,
                "constraint-add": desired.constraints,
                "replicas-max-per-node": desired.maxReplicasPerNode,
                "placement-pref": desired.preferences,
                "update-parallelism": desired.updateConfig?.parallelism,
                "update-delay": desired.updateConfig?.delay,
                "update-monitor": desired.updateConfig?.monitor,
                "update-failure-action": desired.updateConfig?.failureAction,
                "update-max-failure-ratio":
                  desired.updateConfig?.maxFailureRatio,
                "update-order": desired.updateConfig?.order,
                "rollback-parallelism": desired.rollbackConfig?.parallelism,
                "rollback-delay": desired.rollbackConfig?.delay,
                "rollback-monitor": desired.rollbackConfig?.monitor,
                "rollback-failure-action":
                  desired.rollbackConfig?.failureAction,
                "rollback-max-failure-ratio":
                  desired.rollbackConfig?.maxFailureRatio,
                "rollback-order": desired.rollbackConfig?.order,
                "restart-condition": desired.restartPolicy?.condition,
                "restart-delay": desired.restartPolicy?.delay,
                "restart-max-attempts": desired.restartPolicy?.maxAttempts,
                "restart-window": desired.restartPolicy?.window,
                "health-cmd": desired.healthcheck
                  ? Array.isArray(desired.healthcheck.cmd)
                    ? desired.healthcheck.cmd.join(" ")
                    : desired.healthcheck.cmd
                  : undefined,
                "health-interval": desired.healthcheck?.interval,
                "health-timeout": desired.healthcheck?.timeout,
                "health-retries": desired.healthcheck?.retries,
                "health-start-period": desired.healthcheck?.startPeriod,
                "stop-grace-period": desired.stopGracePeriod,
                "mount-add": desired.volumes.map(formatMount),
                "secret-add": desired.secrets.map(formatRef),
                "config-add": desired.configs.map(formatRef),
                "read-only": desired.readOnlyRootFs || undefined,
                "publish-add": desired.ports.map(formatPublish),
                "label-add": allDesiredLabels,
                "label-rm": labelsToRemove,
                "env-add": environment,
                args:
                  desired.command.length > 0
                    ? desired.command.concat(desired.args).join(" ")
                    : undefined,
              });

              return toServiceAttributes(
                yield* inspectOrDie(inspect, output.id, desired.context),
                desired.context,
                code,
              );
            }
          }

          const existingByName = yield* inspect(desired.name, desired.context);
          if (existingByName) {
            ensureReplicatedMode(existingByName);
            return toServiceAttributes(existingByName, desired.context, code);
          }

          const internalTags = yield* createInternalTags(id);
          const allDesiredLabels = { ...internalTags, ...desired.labels };
          yield* docker.service.create({
            context: desired.context,
            name: desired.name,
            image,
            replicas: desired.replicas,
            "endpoint-mode": desired.endpointMode,
            network: desired.networks.map((n) =>
              [
                `name=${n.name}`,
                ...(n.aliases ?? []).map((a) => `alias=${a}`),
              ].join(","),
            ),
            constraint: desired.constraints,
            "replicas-max-per-node": desired.maxReplicasPerNode,
            "placement-pref": desired.preferences,
            "update-parallelism": desired.updateConfig?.parallelism,
            "update-delay": desired.updateConfig?.delay,
            "update-monitor": desired.updateConfig?.monitor,
            "update-failure-action": desired.updateConfig?.failureAction,
            "update-max-failure-ratio": desired.updateConfig?.maxFailureRatio,
            "update-order": desired.updateConfig?.order,
            "rollback-parallelism": desired.rollbackConfig?.parallelism,
            "rollback-delay": desired.rollbackConfig?.delay,
            "rollback-monitor": desired.rollbackConfig?.monitor,
            "rollback-failure-action": desired.rollbackConfig?.failureAction,
            "rollback-max-failure-ratio":
              desired.rollbackConfig?.maxFailureRatio,
            "rollback-order": desired.rollbackConfig?.order,
            "restart-condition": desired.restartPolicy?.condition,
            "restart-delay": desired.restartPolicy?.delay,
            "restart-max-attempts": desired.restartPolicy?.maxAttempts,
            "restart-window": desired.restartPolicy?.window,
            "health-cmd": desired.healthcheck
              ? Array.isArray(desired.healthcheck.cmd)
                ? desired.healthcheck.cmd.join(" ")
                : desired.healthcheck.cmd
              : undefined,
            "health-interval": desired.healthcheck?.interval,
            "health-timeout": desired.healthcheck?.timeout,
            "health-retries": desired.healthcheck?.retries,
            "health-start-period": desired.healthcheck?.startPeriod,
            "stop-grace-period": desired.stopGracePeriod,
            mount: desired.volumes.map(formatMount),
            secret: desired.secrets.map(formatRef),
            config: desired.configs.map(formatRef),
            "read-only": desired.readOnlyRootFs || undefined,
            publish: desired.ports.map(formatPublish),
            label: allDesiredLabels,
            env: environment,
            command: desired.command,
            args: desired.args,
          });
          return toServiceAttributes(
            yield* inspectOrDie(inspect, desired.name, desired.context),
            desired.context,
            code,
          );
        }),
        delete: Effect.fn(({ output }) =>
          docker
            .run([
              ...(output.context ? ["--context", output.context] : []),
              "service",
              "scale",
              "--detach=false",
              `${output.id}=0`,
            ])
            .pipe(
              Effect.flatMap(() =>
                docker.service.remove(output.id, output.context),
              ),
              Effect.flatMap(() =>
                waitForServiceContainersReleased(
                  docker,
                  output.id,
                  output.context,
                ),
              ),
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
              // Best-effort: drop the content-addressed image built for a
              // bundled program so replaced/destroyed services don't strand
              // local image tags.
              Effect.andThen(
                output.code
                  ? docker.image
                      .remove(output.image, true, output.context)
                      .pipe(Effect.catchCause(() => Effect.void))
                  : Effect.void,
              ),
            ),
        ),
      });
    }),
  );

/** Swarm rejects service names longer than 63 characters. */
const servicePhysicalName = (
  id: string,
  props: { name?: string } | undefined,
  instanceId: string,
) => dockerPhysicalName(id, props, instanceId, 63);

const normalizeDesired = (
  id: string,
  props: ServiceProps,
  instanceId: string,
) =>
  servicePhysicalName(id, props, instanceId).pipe(
    Effect.map((name) => ({
      name,
      context: dockerEngineContextName(props.context),
      // The bundled form's image identity is its content hash (compared
      // separately in diff) — the `image` prop is only the environment base
      // there, and it participates in the hash.
      image: isBundledService(props)
        ? undefined
        : normalizeImageRef(props.image),
      command: props.command ?? [],
      args: props.args ?? [],
      environment: {
        ...normalizeEnvironment(props.environment),
        ...normalizeBoundEnv(props.env),
      },
      networks: normalizeNetworks(props.networks),
      ports: normalizePorts(props.ports),
      endpointMode: props.endpointMode ?? "vip",
      replicas: normalizeReplicas(props.replicas),
      constraints: [
        ...(props.constraints ?? []),
        ...(props.placement?.constraints ?? []),
      ],
      maxReplicasPerNode: props.placement?.maxReplicasPerNode,
      preferences: props.placement?.preferences ?? [],
      updateConfig: props.updateConfig,
      rollbackConfig: props.rollbackConfig,
      restartPolicy: props.restartPolicy,
      healthcheck: props.healthcheck,
      stopGracePeriod: props.stopGracePeriod,
      volumes: props.volumes ?? [],
      secrets: props.secrets ?? [],
      configs: props.configs ?? [],
      readOnlyRootFs: props.readOnlyRootFs ?? false,
      labels: props.labels ?? {},
    })),
  );

const normalizeImageRef = (image: Service.Image): string =>
  typeof image === "string" ? image : image.imageRef;

const normalizeEnvironment = (
  environment: Record<string, string | Redacted.Redacted<string>> | undefined,
) =>
  Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

/**
 * Platform-injected env (`props.env`) after Output resolution: values are
 * usually marker-packed strings, but tolerate Redacted and structured values.
 */
const normalizeBoundEnv = (
  env: Record<string, any> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value
        : Redacted.isRedacted(value)
          ? Redacted.value(value as Redacted.Redacted<string>)
          : JSON.stringify(value),
    ]),
  );

const normalizePorts = (
  ports: Service.PortMapping[] | undefined,
): Service.PortMapping[] =>
  (ports ?? []).map((port) => ({
    external: port.external,
    internal: port.internal,
    protocol: port.protocol ?? "tcp",
    mode: port.mode ?? "ingress",
  }));

const normalizeReplicas = (replicas: number | undefined): number => {
  const value = replicas ?? 1;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Service.replicas must be an integer >= 0");
  }
  return value;
};

const normalizeNetworks = (
  networks: Array<string | Service.NetworkAttachment> | undefined,
): Service.NetworkAttachment[] =>
  (networks ?? []).map((network) =>
    typeof network === "string"
      ? { name: network }
      : { name: network.name, aliases: network.aliases },
  );

const formatMount = (volume: Service.VolumeMapping): string =>
  [
    `type=${/^(\/|\.\/|\.\.\/|~)/.test(volume.hostPath) ? "bind" : "volume"}`,
    `source=${volume.hostPath}`,
    `target=${volume.containerPath}`,
    ...(volume.readOnly ? ["readonly=true"] : []),
  ].join(",");

const formatRef = (ref: Service.SecretRef | Service.ConfigRef): string =>
  Object.entries(ref)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

const formatPublish = (port: Service.PortMapping): string =>
  [
    ...(port.external !== undefined ? [`published=${port.external}`] : []),
    `target=${port.internal}`,
    `protocol=${port.protocol ?? "tcp"}`,
    `mode=${port.mode ?? "ingress"}`,
  ].join(",");

const toServiceAttributes = (
  service: ServiceInspect,
  context?: string,
  code?: { hash: string },
): Service["Attributes"] => {
  return {
    id: service.ID,
    name: service.Spec.Name,
    context,
    image: service.Spec.TaskTemplate?.ContainerSpec?.Image ?? "",
    replicas: service.Spec.Mode?.Replicated?.Replicas ?? 1,
    networks: (service.Spec.TaskTemplate?.Networks ?? []).flatMap((n) =>
      n.Target ? [n.Target] : [],
    ),
    ports: (service.Spec.EndpointSpec?.Ports ?? []).flatMap((port) => {
      if (port.PublishedPort === undefined || port.TargetPort === undefined) {
        return [];
      }
      return [
        {
          external: port.PublishedPort,
          internal: port.TargetPort,
          protocol: port.Protocol ?? "tcp",
          mode: port.PublishMode ?? "ingress",
        },
      ];
    }),
    labels: service.Spec.Labels ?? {},
    endpointMode: service.Spec.EndpointSpec?.Mode ?? "vip",
    createdAt: Date.parse(service.CreatedAt ?? "") || Date.now(),
    updatedAt: Date.parse(service.UpdatedAt ?? "") || Date.now(),
    code,
  };
};

const ensureReplicatedMode = (service: ServiceInspect): void => {
  if (service.Spec.Mode?.Global !== undefined) {
    throw new Error(
      `Docker.Service only supports replicated services. Service "${service.Spec.Name}" is global.`,
    );
  }
};

const parseInspectArray = <T>(json: string): T => {
  const parsed = JSON.parse(json) as T[];
  if (parsed.length === 0) {
    throw new Error("docker inspect returned no objects");
  }
  return parsed[0]!;
};

const normalizeServiceInspect = (value: unknown): ServiceInspect => {
  if (typeof value === "object" && value !== null && "stdout" in value) {
    const stdout = (value as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") {
      return parseInspectArray<ServiceInspect>(stdout);
    }
  }
  return value as ServiceInspect;
};

const inspectOrDie = <T>(
  inspect: (
    nameOrId: string,
    context?: string,
  ) => Effect.Effect<T | undefined, any>,
  nameOrId: string,
  context?: string,
) =>
  inspect(nameOrId, context).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.die(`Expected ${nameOrId} to exist after create`),
    ),
  );

const waitForServiceContainersReleased = (
  docker: Docker["Service"],
  serviceId: string,
  context?: string,
): Effect.Effect<void, any, any> => {
  const maxAttempts = 10;
  const noContainers = Symbol.for("Docker.Service.NoContainers");

  const poll = listServiceContainerIds(docker, serviceId, context).pipe(
    Effect.flatMap((containerIds) =>
      containerIds.length === 0
        ? Effect.fail(noContainers)
        : Effect.succeed(containerIds),
    ),
  );

  return poll.pipe(
    Effect.repeat(
      Schedule.spaced("1 second").pipe(
        Schedule.upTo({ times: maxAttempts - 1 }),
      ),
    ),
    Effect.catchIf(
      (error): error is typeof noContainers => error === noContainers,
      () => Effect.void,
    ),
    Effect.andThen(listServiceContainerIds(docker, serviceId, context)),
    Effect.flatMap((containerIds) =>
      containerIds.length === 0
        ? Effect.void
        : // Best effort cleanup for lingering task containers that keep volumes attached.
          Effect.forEach(
            containerIds,
            (containerId) =>
              docker
                .run([
                  ...(context ? ["--context", context] : []),
                  "container",
                  "rm",
                  "-f",
                  containerId,
                ])
                .pipe(Effect.catchCause(() => Effect.void)),
            { concurrency: "unbounded" },
          ).pipe(Effect.as(undefined)),
    ),
  );
};

const listServiceContainerIds = (
  docker: Docker["Service"],
  serviceId: string,
  context?: string,
): Effect.Effect<string[], any, any> =>
  docker
    .run([
      ...(context ? ["--context", context] : []),
      "ps",
      "-a",
      "--filter",
      `label=com.docker.swarm.service.id=${serviceId}`,
      "--format",
      "{{.ID}}",
    ])
    .pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );
