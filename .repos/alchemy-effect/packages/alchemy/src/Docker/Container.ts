import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../Tags.ts";
import { toSeconds } from "../Util/Duration.ts";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface ContainerProps {
  /** Image reference or Docker image resource. */
  image: Container.Image;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
  /**
   * Container name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Command to run in the container. */
  command?: string[];
  /** Container environment variables. Use Redacted for secrets. */
  environment?: Record<string, string | Redacted.Redacted<string>>;
  /** Host/container port mappings. */
  ports?: Container.PortMapping[];
  /** Volume or bind mounts. */
  volumes?: Container.VolumeMapping[];
  /** Restart policy. */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /**
   * Container labels. Alchemy's internal ownership labels are added
   * automatically.
   */
  labels?: Record<string, string>;
  /**
   * Grace period before Docker forcefully kills the container after stopping
   * it.
   */
  stopTimeout?: Duration.Input;
  /** Networks to connect after create. */
  networks?: Container.NetworkMapping[];
  /**
   * Extra `/etc/hosts` entries, each `hostname:address`. Docker's
   * `host-gateway` alias resolves to the host machine, so
   * `"host.docker.internal:host-gateway"` reaches services listening on the
   * developer's machine from inside the container.
   *
   * On Linux `host-gateway` is the bridge gateway address, so those packets
   * traverse the host's `INPUT` chain — under a default-deny firewall the
   * name resolves and the connection then times out. See the Host Access
   * examples.
   */
  extraHosts?: string[];
  /** Remove the container when it exits. @default false */
  removeOnExit?: boolean;
  /** Start the container after creation/reconciliation. @default false */
  start?: boolean;
  /** Docker healthcheck configuration. */
  healthcheck?: Container.Healthcheck;
}

export declare namespace Container {
  type Status =
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";
  type Image = string | { imageRef: string };
  interface PortMapping {
    /** External port on the host. */
    external: number | string;
    /** Internal port inside the container. */
    internal: number | string;
    /** Protocol used for the mapping. @default "tcp" */
    protocol?: "tcp" | "udp";
  }
  interface VolumeMapping {
    /** Host path or named volume source. */
    hostPath: string;
    /** Container path. */
    containerPath: string;
    /** Mount read-only. @default false */
    readOnly?: boolean;
  }
  interface NetworkMapping {
    /** Network name or ID. */
    name: string;
    /** Network aliases for the container. */
    aliases?: string[];
  }
  interface Healthcheck {
    /** Command to run for health checks. */
    cmd: string[] | string;
    /** Time between checks. */
    interval?: Duration.Input;
    /** Maximum time a check may run. */
    timeout?: Duration.Input;
    /** Consecutive failures before unhealthy. */
    retries?: number;
    /** Startup grace period. */
    startPeriod?: Duration.Input;
    /** Check interval during startup. Requires Docker API 1.44+. */
    startInterval?: Duration.Input;
  }
}

export interface Container extends Resource<
  "Docker.Container",
  ContainerProps,
  {
    /** Docker container id. */
    id: string;
    /** Docker container name. */
    name: string;
    /** Docker container state. */
    status: Container.Status;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Image reference used to create the container. */
    imageRef: string;
    /**
     * Map of internal container ports to their bound host ports.
     * Format: `"80/tcp" -> 8080`.
     */
    ports: Record<string, number>;
  },
  never,
  Providers
> {}

/**
 * A Docker container managed through the active Docker context.
 *
 * This resource creates, starts, stops, inspects, and removes containers through
 * the Docker CLI. It is not interchangeable with `Cloudflare.Container`, which
 * manages Cloudflare's container platform; use pushed image references to bridge
 * Docker-built images into cloud container runtimes.
 *
 *
 * ### Running Containers
 * **Example:** Nginx with a published port
 * ```typescript
 * const nginx = yield* Docker.Container("nginx", {
 *   image: "nginx:alpine",
 *   ports: [{ external: 8080, internal: 80 }],
 *   start: true,
 * });
 * ```
 *
 * ### Secret Environment
 * **Example:** Redacted env var
 * ```typescript
 * const password = yield* Config.redacted("POSTGRES_PASSWORD");
 * const db = yield* Docker.Container("postgres", {
 *   image: "postgres:18-alpine",
 *   environment: {
 *     POSTGRES_PASSWORD: password,
 *   },
 *   start: true,
 * });
 * ```
 *
 * ### Networks and Volumes
 * **Example:** PostgreSQL with persistent storage
 * ```typescript
 * const network = yield* Docker.Network("app-network");
 * const data = yield* Docker.Volume("postgres-data");
 * const postgresName = "app-postgres";
 * yield* Docker.Container("postgres", {
 *   name: postgresName,
 *   image: "postgres:18-alpine",
 *   ports: [{ external: 15432, internal: 5432 }],
 *   volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
 *   networks: [{ name: network.name, aliases: ["postgres"] }],
 *   start: true,
 * });
 * const runtime = yield* Docker.inspectContainer(postgresName);
 * ```
 *
 * ### Host Access
 * `extraHosts` writes lines into the container's `/etc/hosts`; it changes name
 * resolution and nothing else. Docker's `host-gateway` alias resolves to the
 * host machine, which is how a container reaches a service on the developer's
 * loopback.
 *
 * On Linux `host-gateway` is the Docker bridge gateway (typically
 * `172.17.0.1`), so a container's packets to it arrive on the host's `INPUT`
 * chain. Under a default-deny firewall — ufw ships
 * `DEFAULT_INPUT_POLICY="DROP"` — the hostname resolves correctly and the
 * connection then times out, which reads like an application bug rather than a
 * firewall one. Allow the bridge subnet to fix it:
 * `sudo ufw allow from 172.16.0.0/12`.
 *
 * **Example:** Reach a service on the developer's machine
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // `host-gateway` resolves to the host machine, so a database listening
 *   // on the developer's loopback is reachable from inside the container.
 *   extraHosts: ["host.docker.internal:host-gateway"],
 *   environment: {
 *     DATABASE_URL: "postgres://postgres@host.docker.internal:5432/app",
 *   },
 *   start: true,
 * });
 * ```
 *
 * **Example:** Pin a hostname to a fixed address
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // Any `hostname:address` pair — host access is just the common case.
 *   extraHosts: ["payments.internal:10.1.2.3"],
 *   start: true,
 * });
 * ```
 *
 * **Example:** Publish on any free host port
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // `external: 0` lets Docker choose; the assigned port is reported back.
 *   ports: [{ external: 0, internal: 3000 }],
 *   start: true,
 * });
 * const hostPort = api.ports["3000/tcp"];
 * ```
 *
 * ### Traefik
 * **Example:** Route a container through Traefik
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   networks: [{ name: "traefik" }],
 *   labels: {
 *     "traefik.enable": "true",
 *     "traefik.http.routers.api.rule": "Host(`api.example.com`)",
 *     "traefik.http.services.api.loadbalancer.server.port": "3000",
 *   },
 *   stopTimeout: "30 seconds",
 *   start: true,
 * });
 * ```
 *
 * **Example:** Use a Docker.Context resource
 * ```typescript
 * const remote = yield* Docker.Context("remote", {
 *   name: "remote-build",
 *   docker: "host=ssh://docker@example.com",
 * });
 *
 * const api = yield* Docker.Container("api", {
 *   image: "nginx:alpine",
 *   context: remote,
 * });
 * ```
 *
 * @resource
 */
export const Container = Resource<Container>("Docker.Container");

/**
 * Inspect a Docker container by name and return normalized runtime details.
 *
 * This is a small public wrapper around Docker's raw inspect output. It returns
 * the stable data Alchemy callers typically need, including bound host ports.
 */
export const inspectContainer = (
  name: string,
  context?: Docker.ContextRef,
): Effect.Effect<Container["Attributes"], PlatformError, Docker> =>
  Docker.pipe(
    Effect.flatMap((docker) =>
      docker.container.inspect(name, dockerContextName(context)),
    ),
    Effect.map((container) =>
      toContainerAttributes(container, container.Config.Image),
    ),
  );

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const docker = yield* Docker;

      const reconcileNetworks = Effect.fn(function* (
        live: Docker.Container,
        news: ContainerProps,
        olds: ContainerProps | undefined,
      ) {
        const context = dockerContextName(news.context);
        const connect = new Map<string, Container.NetworkMapping>();
        const disconnect = new Set<string>();
        for (const network of news.networks ?? []) {
          const entry = live.NetworkSettings.Networks?.[network.name];
          if (!entry) {
            connect.set(network.name, network);
          } else if (
            !Equal.equals(entry.Aliases ?? [], network.aliases ?? [])
          ) {
            connect.set(network.name, network);
            disconnect.add(network.name);
          }
        }
        // Only networks alchemy itself attached are alchemy's to detach, and
        // `olds.networks` is the sole record of which those are — the live
        // container cannot say who connected a network. Sweeping every live
        // network instead tore off the default `bridge` and anything a user,
        // compose file, or another tool had attached out of band (#1386).
        const desired = new Set((news.networks ?? []).map((n) => n.name));
        for (const network of olds?.networks ?? []) {
          if (
            !desired.has(network.name) &&
            live.NetworkSettings.Networks?.[network.name]
          ) {
            disconnect.add(network.name);
          }
        }
        yield* Effect.forEach(
          disconnect,
          (network) =>
            docker.network.disconnect({ network, container: live.Id, context }),
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          connect.values(),
          (network) =>
            docker.network.connect({
              network: network.name,
              container: live.Id,
              alias: network.aliases,
              context,
            }),
          { concurrency: "unbounded" },
        );
      });

      return Container.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerContextName(olds.context);
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* docker.container
            .inspect(name, context)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
          if (!info) return undefined;
          // `olds.image` may be `undefined` when a `creating` row was
          // persisted before upstream Outputs resolved — fall back to the
          // live container's actual image.
          const attrs = toContainerAttributes(
            info,
            olds.image !== undefined
              ? normalizeImageRef(olds.image)
              : info.Config.Image,
          );
          if (output) return attrs;
          // Without prior state, only adopt a container that carries our
          // branding; anything else is foreign and gated behind `--adopt`.
          const owned = yield* hasAlchemyTags(
            id,
            info.Config.Labels ?? undefined,
          );
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds }) {
          if (!isResolved(news)) return undefined;
          // An Output-valued `image` doesn't survive a `creating`-state
          // round-trip (it deserializes as `undefined`) — without comparable
          // prior create args, let the engine apply its default update logic.
          if (olds.image === undefined) return undefined;
          if (
            dockerContextName(olds.context) !== dockerContextName(news.context)
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          const oldArgs = yield* makeCreateArgs(id, olds, instanceId);
          const newArgs = yield* makeCreateArgs(id, news, instanceId);
          if (!Equal.equals(oldArgs, newArgs)) {
            return { action: "replace" as const, deleteFirst: true };
          }
          if (
            !Equal.equals(olds.networks ?? [], news.networks ?? []) ||
            (olds.start ?? false) !== (news.start ?? false)
          ) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, olds }) {
          const context = dockerContextName(news.context);
          const args = yield* makeCreateArgs(id, news, instanceId);
          const live = yield* docker.container
            .inspect(args.name, context)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );

          if (live) {
            yield* reconcileNetworks(live, news, olds);
            if (news.start && live.State.Status !== "running") {
              yield* docker.container.start(live.Id, context);
            } else if (!news.start && live.State.Status === "running") {
              yield* docker.container.stop(live.Id, context);
            }
            return yield* docker.container
              .inspect(live.Id, context)
              .pipe(
                Effect.map((info) => toContainerAttributes(info, args.image)),
              );
          }

          const internalTags = yield* createInternalTags(id);
          const { stdout: containerId } = yield* docker.container.create({
            ...args,
            context,
            label: { ...args.label, ...internalTags },
          });
          yield* Effect.forEach(
            news.networks ?? [],
            (network) =>
              docker.network.connect({
                network: network.name,
                container: containerId,
                alias: network.aliases,
                context,
              }),
            { concurrency: "unbounded" },
          );
          if (news.start) {
            yield* docker.container.start(containerId, context);
          }
          const info = yield* docker.container.inspect(containerId, context);
          return toContainerAttributes(info, args.image);
        }),
        delete: Effect.fn(({ olds, output }) =>
          docker.container
            .stop(output.name, dockerContextName(olds.context))
            .pipe(
              Effect.andThen(
                docker.container.remove(
                  output.name,
                  true,
                  dockerContextName(olds.context),
                ),
              ),
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const normalizeImageRef = (image: Container.Image): string =>
  typeof image === "string" ? image : image.imageRef;

const makeCreateArgs = (id: string, news: ContainerProps, instanceId: string) =>
  dockerPhysicalName(id, news, instanceId).pipe(
    Effect.map(
      (name): Parameters<Docker["Service"]["container"]["create"]>[0] => ({
        name,
        image: normalizeImageRef(news.image),
        command: news.command,
        env: normalizeEnvironment(news.environment),
        volume: news.volumes?.map(
          (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
        ),
        p: news.ports?.map((port) => {
          const target = `${port.internal}/${port.protocol ?? "tcp"}`;
          // `external: 0` means "any free host port". Docker spells that as a
          // bare container port (`-p 80/tcp`); `-p 0:80/tcp` instead asks for
          // host port 0 literally, which the daemon accepts and then reports
          // back as 0.
          return isRandomHostPort(port.external)
            ? target
            : `${port.external}:${target}`;
        }),
        "add-host": news.extraHosts,
        restart: news.restart ?? "no",
        label: news.labels,
        "stop-timeout": toSeconds(news.stopTimeout)?.toString(),
        rm: news.removeOnExit ?? false,
        ...(news.healthcheck
          ? {
              "health-cmd": Array.isArray(news.healthcheck.cmd)
                ? news.healthcheck.cmd.join(" ")
                : news.healthcheck.cmd,
              "health-interval": normalizeDuration(news.healthcheck.interval),
              "health-timeout": normalizeDuration(news.healthcheck.timeout),
              "health-retries": news.healthcheck.retries ?? 0,
              "health-start-period": normalizeDuration(
                news.healthcheck.startPeriod,
              ),
              "health-start-interval": normalizeDuration(
                news.healthcheck.startInterval,
              ),
            }
          : {
              "health-cmd": undefined,
              "health-interval": undefined,
              "health-timeout": undefined,
              "health-retries": undefined,
              "health-start-period": undefined,
              "health-start-interval": undefined,
            }),
      }),
    ),
  );

const toContainerAttributes = (
  info: Docker.Container,
  imageRef: string,
): Container["Attributes"] => ({
  id: info.Id,
  name: typeof info.Name === "string" ? info.Name.replace(/^\//, "") : info.Id,
  status: info.State.Status,
  createdAt: Date.parse(info.Created) || Date.now(),
  imageRef,
  ports: toPortAttributes(info),
});

/** First binding that carries a real (non-zero) host port. */
const boundHostPort = (
  bindings: ReadonlyArray<{ HostPort?: string }> | null | undefined,
): number | undefined => {
  for (const binding of bindings ?? []) {
    if (!binding.HostPort) continue;
    const port = Number.parseInt(binding.HostPort, 10);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
};

/**
 * `HostConfig.PortBindings` is what was *requested*, `NetworkSettings.Ports`
 * what Docker actually *assigned* — so the assignment wins wherever both
 * exist. A container published with `external: 0` (or any random-publish
 * mapping) has no requested host port at all, and reading the request over
 * the assignment reported 0 instead of the port the container is reachable
 * on. The request is still the fallback: a created-but-not-yet-started
 * container has empty `NetworkSettings.Ports`.
 */
const toPortAttributes = (info: Docker.Container): Record<string, number> => {
  const ports: Record<string, number> = {};
  for (const [internal, bindings] of Object.entries(
    info.HostConfig.PortBindings ?? {},
  )) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  for (const [internal, bindings] of Object.entries(
    info.NetworkSettings.Ports ?? {},
  )) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  return ports;
};

/** `external: 0` / `"0"` asks Docker to pick any free host port. */
const isRandomHostPort = (external: number | string): boolean =>
  Number.parseInt(String(external), 10) === 0;

const normalizeEnvironment = (
  environment: Record<string, string | Redacted.Redacted<string>> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const normalizeDuration = (
  input: Duration.Input | undefined,
): string | undefined => {
  if (!input) return undefined;
  const duration = Duration.fromInputUnsafe(input);
  // Docker parses `--health-*` durations with Go's `time.ParseDuration`, which
  // requires a unit suffix — a bare nanosecond count is rejected with "missing
  // unit in duration". `ns` is the lossless Go-duration rendering of the nanos.
  return `${Duration.toNanosUnsafe(duration).toString()}ns`;
};
