import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import { toSeconds } from "alchemy/Util/Duration";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import { healthcheckCommand, isHealthcheckDisabled } from "./HealthcheckCommand.ts";
import type { Providers } from "./Providers.ts";

const CREATE_CONFIG_HASH_LABEL = "alchemy::container-config";

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
  /**
   * Paths to Docker env files, forwarded in the declared order as repeated
   * `--env-file` options. Explicit `environment` values are forwarded after
   * these files and take precedence in Docker. Editing a file's contents
   * replaces the container on the next deploy. Only a digest of the contents
   * is kept, on the container's own label; neither contents nor digest are
   * written to Alchemy state. Docker itself exposes the resolved values
   * through `docker inspect`, so treat env files as secrets.
   */
  envFiles?: string[];
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
  /** Network namespace. Use `{ container: id }` to share another container's namespace. */
  networkMode?: Container.NetworkMode;
  /** Linux capabilities to add, for example `SYS_ADMIN`. */
  capAdd?: string[];
  /** Linux capabilities to drop, for example `["ALL"]`. */
  capDrop?: string[];
  /** Hard memory limit in Docker's byte-suffix format, e.g. `"512m"`. */
  memory?: string;
  /**
   * Combined memory-plus-swap limit in Docker's byte-suffix format.
   * Requires `memory`. Set to the same value to disable swap, or `"-1"`
   * to allow unlimited swap (subject to the host).
   */
  memorySwap?: string;
  /** Soft memory limit under contention, e.g. `"256m"`. */
  memoryReservation?: string;
  /** CPU quota, in cores (e.g. `0.5` limits to half a CPU). */
  cpus?: number;
  /** Maximum number of processes and threads in the container. */
  pidsLimit?: number;
  /** Mount the container's root filesystem read-only. Writable paths need a volume or tmpfs. */
  readOnlyRootFilesystem?: boolean;
  /** Prevent processes from gaining additional privileges through exec. */
  noNewPrivileges?: boolean;
  /** Run Docker's init process to forward signals and reap child processes. */
  init?: boolean;
  /** Runtime user, e.g. `"1000:1000"` or `"app"`. Omit to keep the image's user. */
  user?: string;
  /**
   * Seccomp JSON profile path on the Docker CLI host, or `"builtin"` to
   * select Docker's default policy. `"unconfined"` explicitly disables it.
   * Changes to a profile file's contents recreate the container.
   */
  seccompProfile?: string;
  /**
   * Name of a preloaded AppArmor profile, e.g. `"docker-default"`.
   * Requires AppArmor support on the target host. `"unconfined"` disables it.
   */
  appArmorProfile?: string;
  /** Docker user-namespace mode. `"host"` opts out of daemon user remapping. */
  userNamespace?: string;
  /** Supplementary Linux group names or numeric GIDs. */
  groupAdd?: string[];
  /** Per-process resource limits. `-1` represents unlimited. */
  ulimits?: Record<string, Container.Ulimit>;
  /** Docker log driver, e.g. `"local"`, `"json-file"`, or `"none"`. */
  logDriver?: string;
  /** Driver-specific settings, such as `{ "max-size": "10m", "max-file": "3" }`. */
  logOptions?: Record<string, string>;
  /** Relative OOM score adjustment on Linux, from -1000 to 1000. */
  oomScoreAdjustment?: number;
  /** Stop signal, e.g. `"SIGTERM"` or `"SIGINT"`. */
  stopSignal?: string;
  /** Writable in-memory mounts, including size and POSIX mode controls. */
  tmpfs?: Container.TmpfsMount[];
  /** Host devices to expose to the container. */
  devices?: Container.DeviceMapping[];
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
  type Status = "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead";
  type Image = string | { imageRef: string; imageId?: string };
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
  interface TmpfsMount {
    /** Absolute mount target in the container, e.g. `"/tmp"`. */
    path: string;
    /** Docker byte-suffix size, e.g. `"32m"`. Omit for the engine default. */
    size?: string;
    /** POSIX mode as a number, e.g. `0o1777` for a sticky world-writable directory. */
    mode?: number;
  }
  interface Ulimit {
    /** Process soft limit. `-1` means unlimited. */
    soft: number;
    /** Process hard limit. `-1` means unlimited. */
    hard: number;
  }
  interface NetworkMapping {
    /** Network name or ID. */
    name: string;
    /** Network aliases for the container. */
    aliases?: string[];
  }
  type NetworkMode = string | { container: string };
  interface DeviceMapping {
    /** Host device path. */
    hostPath: string;
    /** Container device path. */
    containerPath: string;
    /** Cgroup permissions. @default "rwm" */
    permissions?: string;
  }
  interface Healthcheck {
    /**
     * Command to run for health checks. A string runs in the container's
     * shell. An array follows Docker's healthcheck `Test` form:
     * `["CMD-SHELL", "pg_isready -U app"]`, `["CMD", "pg_isready", "-U", "app"]`,
     * or `["NONE"]` to disable the image's healthcheck.
     */
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
    /** Configured network namespace, when reported by Docker. */
    networkMode?: string;
    /** Added Linux capabilities, when reported by Docker. */
    capAdd?: string[];
    /** Configured host devices, when reported by Docker. */
    devices?: Container.DeviceMapping[];
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
 * const password = yield* Config.Redacted("POSTGRES_PASSWORD");
 * const db = yield* Docker.Container("postgres", {
 *   image: "postgres:18-alpine",
 *   environment: {
 *     POSTGRES_PASSWORD: password,
 *   },
 *   start: true,
 * });
 * ```
 *
 * ### Environment Files
 * **Example:** Layered Docker env files
 * ```typescript
 * const app = yield* Docker.Container("app", {
 *   image: "ghcr.io/acme/app:latest",
 *   envFiles: ["./config/base.env", "./config/production.env"],
 *   // Explicit values are passed after env files and take precedence.
 *   environment: { LOG_LEVEL: "info" },
 * });
 * ```
 *
 * Editing an env file replaces the container on the next deploy, as does
 * adopting a container that uses env files (once, so later edits are tracked).
 * Alchemy reads
 * the files at plan time but keeps only a digest of their contents, on the
 * container's own label; neither the values nor the digest are written to
 * Alchemy state. Docker exposes the resolved values through `docker inspect`,
 * so treat env files as secrets.
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
 *   extraHosts: ["service.example:192.0.2.10"],
 *   start: true,
 * });
 * ```
 *
 * ### Runtime Options
 * **Example:** Contain a background worker
 * ```typescript
 * const worker = yield* Docker.Container("worker", {
 *   image: "oven/bun:1",
 *   memory: "512m",
 *   memorySwap: "512m",
 *   memoryReservation: "256m",
 *   cpus: 0.5,
 *   pidsLimit: 128,
 *   readOnlyRootFilesystem: true,
 *   capDrop: ["ALL"],
 *   noNewPrivileges: true,
 *   init: true,
 *   user: "1000:1000",
 *   tmpfs: [{ path: "/tmp", size: "32m", mode: 0o1777 }],
 * });
 * ```
 *
 * **Example:** Customize confinement, process limits, and log rotation
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   seccompProfile: "./security/api-seccomp.json", // client-side JSON; edits roll the container
 *   appArmorProfile: "my-loaded-profile",          // must already be loaded on the host
 *   groupAdd: ["1000"],
 *   ulimits: { nofile: { soft: 1024, hard: 4096 } },
 *   logDriver: "local",
 *   logOptions: { "max-size": "10m", "max-file": "3" },
 *   oomScoreAdjustment: 200,
 *   stopSignal: "SIGTERM",
 * });
 * ```
 *
 * **Example:** Share a donor container's network namespace
 * ```typescript
 * const donor = yield* Docker.Container("donor", { image: "redis:alpine" });
 * const sidecar = yield* Docker.Container("sidecar", {
 *   image: "busybox:latest",
 *   networkMode: { container: donor.id },
 * });
 * ```
 *
 * **Example:** Add capabilities and devices
 * ```typescript
 * const worker = yield* Docker.Container("worker", {
 *   image: "ubuntu:latest",
 *   capAdd: ["SYS_ADMIN"],
 *   devices: [{ hostPath: "/dev/fuse", containerPath: "/dev/fuse" }],
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
 * @product Container
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
    Effect.flatMap((docker) => docker.container.inspect(name, dockerContextName(context))),
    Effect.map((container) => toContainerAttributes(container, container.Config.Image)),
  );

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Env files are read so editing one rolls the container, but only a
      // digest of their bytes enters the config hash, which lives solely in
      // the container's own label (where `docker inspect` already exposes
      // the resolved values). Neither contents nor digest reach alchemy state.
      const envFilesDigest = Effect.fn(function* (envFiles: ReadonlyArray<string> | undefined) {
        if (!envFiles?.length) return undefined;
        const digests = yield* Effect.forEach(envFiles, (file) =>
          fs.readFile(path.resolve(file)).pipe(
            Effect.flatMap(sha256),
            Effect.map((digest) => `${file}\0${digest}`),
          ),
        );
        return yield* sha256(digests.join("\n"));
      });

      // Docker CLI loads seccomp profiles from client-side files at create
      // time. Hash the contents as well as the path so policy edits are never
      // silently ignored on subsequent deploys.
      const seccompProfileDigest = Effect.fn(function* (profile: string | undefined) {
        if (!isCustomSeccompProfile(profile)) return undefined;
        return yield* fs.readFile(path.resolve(profile)).pipe(Effect.flatMap(sha256));
      });

      // Without env files the hash input is unchanged from before they were
      // supported, so existing containers keep their label and are not rolled.
      const desiredConfigHash = Effect.fn(function* (
        args: Parameters<Docker["Service"]["container"]["create"]>[0],
        news: ContainerProps,
      ) {
        const envFiles = yield* envFilesDigest(news.envFiles);
        const seccompProfile = yield* seccompProfileDigest(news.seccompProfile);
        return yield* sha256Object({
          ...args,
          imageId: normalizeImageId(news.image),
          ...(envFiles === undefined ? {} : { envFiles }),
          ...(seccompProfile === undefined ? {} : { seccompProfile }),
        });
      });

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
          } else if (!Equal.equals(entry.Aliases ?? [], network.aliases ?? [])) {
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
          if (!desired.has(network.name) && live.NetworkSettings.Networks?.[network.name]) {
            disconnect.add(network.name);
          }
        }
        yield* Effect.forEach(
          disconnect,
          (network) => docker.network.disconnect({ network, container: live.Id, context }),
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

      const inspect = (name: string, context?: string) =>
        docker.container
          .inspect(name, context)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));

      const remove = (name: string, context?: string) =>
        docker.container.stop(name, context).pipe(
          Effect.andThen(docker.container.remove(name, true, context)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        );

      return Container.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerContextName(olds.context);
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* inspect(name, context);
          if (!info) return undefined;
          // `olds.image` may be `undefined` when a `creating` row was
          // persisted before upstream Outputs resolved — fall back to the
          // live container's actual image.
          const attrs = toContainerAttributes(
            info,
            olds.image !== undefined ? normalizeImageRef(olds.image) : info.Config.Image,
          );
          if (output) return attrs;
          // Without prior state, only adopt a container that carries our
          // branding; anything else is foreign and gated behind `--adopt`.
          const owned = yield* hasAlchemyTags(id, info.Config.Labels ?? undefined);
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds }) {
          if (!isResolved(news)) return undefined;
          // An Output-valued `image` doesn't survive a `creating`-state
          // round-trip (it deserializes as `undefined`) — without comparable
          // prior create args, let the engine apply its default update logic.
          if (olds.image === undefined) return undefined;
          if (dockerContextName(olds.context) !== dockerContextName(news.context)) {
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
          // File-backed inputs can change without changing their paths.
          // Compare their digests against the live config hash.
          if (news.envFiles?.length || isCustomSeccompProfile(news.seccompProfile)) {
            const live = yield* inspect(newArgs.name, dockerContextName(news.context));
            const applied = live?.Config.Labels?.[CREATE_CONFIG_HASH_LABEL];
            if (applied !== undefined && applied !== (yield* desiredConfigHash(newArgs, news))) {
              return { action: "update" as const };
            }
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          const context = dockerContextName(news.context);
          const args = yield* makeCreateArgs(id, news, instanceId);
          const configHash = yield* desiredConfigHash(args, news);
          // Adoption has output but no olds. In that case the observed
          // container already lives in the desired context.
          const oldContext = olds ? dockerContextName(olds.context) : context;
          const desiredLive = yield* inspect(args.name, context);
          const previous =
            output && (output.name !== args.name || oldContext !== context)
              ? yield* inspect(output.name, oldContext)
              : undefined;
          if (previous) {
            yield* remove(previous.Id, oldContext);
          }
          const live = desiredLive?.Id === previous?.Id ? undefined : desiredLive;

          const oldArgs =
            live?.Config.Labels?.[CREATE_CONFIG_HASH_LABEL] === undefined && olds !== undefined
              ? yield* makeCreateArgs(
                  id,
                  {
                    ...olds,
                    image: olds.image ?? output?.imageRef ?? news.image,
                  },
                  instanceId,
                )
              : undefined;
          const recreate =
            live !== undefined &&
            (live.Config.Labels?.[CREATE_CONFIG_HASH_LABEL] === undefined
              ? (oldArgs !== undefined && !Equal.equals(oldArgs, args)) ||
                normalizeImageId(olds?.image) !== normalizeImageId(news.image) ||
                !matchesLegacyConfig(live, args, news.image) ||
                // Env file contents can't be compared without a label (e.g. an
                // adopted container); recreate once so later edits are tracked.
                (news.envFiles?.length ?? 0) > 0 ||
                isCustomSeccompProfile(news.seccompProfile) ||
                // A legacy/adopted container has no stamped config hash.
                // Do not retain it without proof that the requested security
                // restrictions were applied.
                hasHardeningOptions(news)
              : live.Config.Labels[CREATE_CONFIG_HASH_LABEL] !== configHash);
          if (recreate) {
            yield* remove(live.Id, context);
          }

          const current = recreate ? undefined : live;
          if (!current) {
            const internalTags = yield* createInternalTags(id);
            const { stdout: containerId } = yield* docker.container.create({
              ...args,
              context,
              label: {
                ...args.label,
                ...internalTags,
                [CREATE_CONFIG_HASH_LABEL]: configHash,
              },
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
          }

          yield* reconcileNetworks(current, news, olds);
          if (news.start && current.State.Status !== "running") {
            yield* docker.container.start(current.Id, context);
          } else if (!news.start && current.State.Status === "running") {
            yield* docker.container.stop(current.Id, context);
          }
          return yield* docker.container
            .inspect(current.Id, context)
            .pipe(Effect.map((info) => toContainerAttributes(info, args.image)));
        }),
        delete: Effect.fn(({ olds, output }) =>
          remove(output.name, dockerContextName(olds.context)),
        ),
      });
    }),
  );

const normalizeImageRef = (image: Container.Image): string =>
  typeof image === "string" ? image : image.imageRef;

const normalizeImageId = (image: Container.Image | undefined) =>
  typeof image === "string" ? undefined : image?.imageId;

type CreateArgs = Parameters<Docker["Service"]["container"]["create"]>[0];

// Containers created before config hashes were introduced are compared using
// the fields Docker reports without image-default normalization. A subsequent
// create stamps the complete resolved configuration hash.
const matchesLegacyConfig = (live: Docker.Container, desired: CreateArgs, image: Container.Image) =>
  (normalizeImageId(image)
    ? live.Image === normalizeImageId(image)
    : live.Config.Image === desired.image) &&
  (desired.command === undefined || Equal.equals(live.Config.Cmd, desired.command)) &&
  Object.entries(desired.env ?? {}).every(([key, value]) =>
    live.Config.Env?.includes(`${key}=${value}`),
  );

const makeCreateArgs = (id: string, news: ContainerProps, instanceId: string) =>
  dockerPhysicalName(id, news, instanceId).pipe(
    Effect.tap(() => validateContainerOptions(news)),
    Effect.map((name): Parameters<Docker["Service"]["container"]["create"]>[0] => ({
      name,
      image: normalizeImageRef(news.image),
      command: news.command,
      env: normalizeEnvironment(news.environment),
      "env-file": news.envFiles?.length ? news.envFiles : undefined,
      volume: news.volumes?.map(
        (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
      ),
      p: news.ports?.map((port) => {
        const target = `${port.internal}/${port.protocol ?? "tcp"}`;
        // `external: 0` means "any free host port". Docker spells that as a
        // bare container port (`-p 80/tcp`); `-p 0:80/tcp` instead asks for
        // host port 0 literally, which the daemon accepts and then reports
        // back as 0.
        return isRandomHostPort(port.external) ? target : `${port.external}:${target}`;
      }),
      "add-host": news.extraHosts,
      network: normalizeNetworkMode(news.networkMode),
      "cap-add": normalizeCapabilities(news.capAdd),
      ...(news.capDrop?.length ? { "cap-drop": normalizeCapabilities(news.capDrop) } : {}),
      ...(news.memory !== undefined ? { memory: news.memory } : {}),
      ...(news.memorySwap !== undefined ? { "memory-swap": news.memorySwap } : {}),
      ...(news.memoryReservation !== undefined
        ? { "memory-reservation": news.memoryReservation }
        : {}),
      ...(news.cpus !== undefined ? { cpus: news.cpus } : {}),
      ...(news.pidsLimit !== undefined ? { "pids-limit": news.pidsLimit } : {}),
      ...(news.readOnlyRootFilesystem ? { "read-only": true } : {}),
      ...(normalizeSecurityOptions(news) ? { "security-opt": normalizeSecurityOptions(news) } : {}),
      ...(news.userNamespace !== undefined ? { userns: news.userNamespace } : {}),
      ...(news.groupAdd?.length ? { "group-add": normalizeGroups(news.groupAdd) } : {}),
      ...(Object.keys(news.ulimits ?? {}).length ? { ulimit: normalizeUlimits(news.ulimits) } : {}),
      ...(news.logDriver !== undefined ? { "log-driver": news.logDriver } : {}),
      ...(Object.keys(news.logOptions ?? {}).length
        ? { "log-opt": normalizeLogOptions(news.logOptions) }
        : {}),
      ...(news.oomScoreAdjustment !== undefined
        ? { "oom-score-adj": news.oomScoreAdjustment }
        : {}),
      ...(news.stopSignal !== undefined ? { "stop-signal": news.stopSignal } : {}),
      ...(news.init ? { init: true } : {}),
      ...(news.user !== undefined ? { user: news.user } : {}),
      ...(news.tmpfs?.length ? { tmpfs: normalizeTmpfs(news.tmpfs) } : {}),
      device: normalizeDevices(news.devices),
      restart: news.restart ?? "no",
      label: news.labels,
      "stop-timeout": toSeconds(news.stopTimeout)?.toString(),
      rm: news.removeOnExit ?? false,
      ...(news.healthcheck
        ? {
            "health-cmd": healthcheckCommand(news.healthcheck.cmd),
            // Only when set: an always-present key would change every
            // container's config hash and recreate it on upgrade.
            ...(isHealthcheckDisabled(news.healthcheck.cmd) ? { "no-healthcheck": true } : {}),
            "health-interval": normalizeDuration(news.healthcheck.interval),
            "health-timeout": normalizeDuration(news.healthcheck.timeout),
            "health-retries": news.healthcheck.retries ?? 0,
            "health-start-period": normalizeDuration(news.healthcheck.startPeriod),
            "health-start-interval": normalizeDuration(news.healthcheck.startInterval),
          }
        : {
            "health-cmd": undefined,
            "health-interval": undefined,
            "health-timeout": undefined,
            "health-retries": undefined,
            "health-start-period": undefined,
            "health-start-interval": undefined,
          }),
    })),
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
  networkMode: info.HostConfig.NetworkMode,
  capAdd: info.HostConfig.CapAdd ?? undefined,
  devices: info.HostConfig.Devices?.map((device) => ({
    hostPath: device.PathOnHost,
    containerPath: device.PathInContainer,
    permissions: device.CgroupPermissions,
  })),
});

const normalizeNetworkMode = (mode: Container.NetworkMode | undefined): string | undefined =>
  mode === undefined ? undefined : typeof mode === "string" ? mode : `container:${mode.container}`;

const normalizeCapabilities = (capAdd: string[] | undefined): string[] | undefined => {
  if (!capAdd?.length) return undefined;
  return [...new Set(capAdd.map((capability) => capability.trim()).filter(Boolean))].sort();
};

const isCustomSeccompProfile = (profile: string | undefined): profile is string =>
  profile !== undefined && profile !== "builtin" && profile !== "unconfined";

const normalizeSecurityOptions = (props: ContainerProps): string[] | undefined => {
  const options = [
    ...(props.noNewPrivileges ? ["no-new-privileges"] : []),
    ...(props.seccompProfile ? [`seccomp=${props.seccompProfile}`] : []),
    ...(props.appArmorProfile ? [`apparmor=${props.appArmorProfile}`] : []),
  ];
  return options.length ? options : undefined;
};

const normalizeGroups = (groups: string[]): string[] =>
  [...new Set(groups.map((group) => group.trim()))].sort();

const normalizeUlimits = (limits: ContainerProps["ulimits"]): string[] =>
  Object.entries(limits ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, { soft, hard }]) => `${name}=${soft}:${hard}`);

const normalizeLogOptions = (options: ContainerProps["logOptions"]): string[] =>
  Object.entries(options ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);

const normalizeTmpfs = (mounts: Container.TmpfsMount[]): string[] =>
  [...mounts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, size, mode }) => {
      const options = [
        ...(size !== undefined ? [`size=${size}`] : []),
        ...(mode !== undefined ? [`mode=${mode.toString(8)}`] : []),
      ];
      return options.length > 0 ? `${path}:${options.join(",")}` : path;
    });

const hasHardeningOptions = (props: ContainerProps): boolean =>
  (props.capDrop?.length ?? 0) > 0 ||
  props.memory !== undefined ||
  props.memorySwap !== undefined ||
  props.memoryReservation !== undefined ||
  props.cpus !== undefined ||
  props.pidsLimit !== undefined ||
  props.readOnlyRootFilesystem === true ||
  props.noNewPrivileges === true ||
  props.seccompProfile !== undefined ||
  props.appArmorProfile !== undefined ||
  props.userNamespace !== undefined ||
  (props.groupAdd?.length ?? 0) > 0 ||
  Object.keys(props.ulimits ?? {}).length > 0 ||
  props.logDriver !== undefined ||
  Object.keys(props.logOptions ?? {}).length > 0 ||
  props.oomScoreAdjustment !== undefined ||
  props.stopSignal !== undefined ||
  props.init === true ||
  props.user !== undefined ||
  (props.tmpfs?.length ?? 0) > 0;

const normalizeDevices = (devices: Container.DeviceMapping[] | undefined): string[] | undefined => {
  if (!devices?.length) return undefined;
  const normalized = devices.map(
    (device) => `${device.hostPath}:${device.containerPath}:${device.permissions ?? "rwm"}`,
  );
  return [...new Set(normalized)].sort();
};

/**
 * Raised before Docker is called when a container's options cannot be
 * combined, e.g. sharing another container's network namespace while
 * publishing ports.
 */
export class InvalidContainerOptions extends Data.TaggedError("InvalidContainerOptions")<{
  readonly message: string;
}> {}

const validateContainerOptions = (news: ContainerProps) => {
  // The CLI formatter omits empty strings. Reject them instead of silently
  // dropping user-specified resource and security restrictions.
  for (const option of [
    "memory",
    "memorySwap",
    "memoryReservation",
    "user",
    "seccompProfile",
    "appArmorProfile",
    "userNamespace",
    "logDriver",
    "stopSignal",
  ] as const) {
    if (news[option] !== undefined && news[option].trim().length === 0) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container ${option} cannot be empty`,
        }),
      );
    }
  }
  if (news.capDrop?.some((capability) => capability.trim().length === 0)) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container capDrop cannot contain empty capabilities",
      }),
    );
  }
  if (news.groupAdd?.some((group) => group.trim().length === 0)) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container groupAdd cannot contain empty groups",
      }),
    );
  }
  for (const [name, limit] of Object.entries(news.ulimits ?? {})) {
    if (
      !/^[a-z][a-z0-9_-]*$/.test(name) ||
      !Number.isSafeInteger(limit.soft) ||
      !Number.isSafeInteger(limit.hard) ||
      limit.soft < -1 ||
      limit.hard < -1 ||
      (limit.hard !== -1 && (limit.soft === -1 || limit.soft > limit.hard))
    ) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container ulimits contains an invalid soft/hard limit for ${name}`,
        }),
      );
    }
  }
  for (const [name, value] of Object.entries(news.logOptions ?? {})) {
    if (!name.trim() || name.includes("=") || !value.trim()) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container logOptions contains an invalid option: ${name}`,
        }),
      );
    }
  }
  if (
    news.oomScoreAdjustment !== undefined &&
    (!Number.isInteger(news.oomScoreAdjustment) ||
      news.oomScoreAdjustment < -1000 ||
      news.oomScoreAdjustment > 1000)
  ) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container oomScoreAdjustment must be an integer from -1000 to 1000",
      }),
    );
  }
  if (news.memorySwap !== undefined && news.memory === undefined) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container memorySwap requires memory to be set",
      }),
    );
  }
  if (news.cpus !== undefined && (!Number.isFinite(news.cpus) || news.cpus <= 0)) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container cpus must be a finite, positive number",
      }),
    );
  }
  if (
    news.pidsLimit !== undefined &&
    (!Number.isInteger(news.pidsLimit) || (news.pidsLimit <= 0 && news.pidsLimit !== -1))
  ) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container pidsLimit must be a positive integer or -1 (unlimited)",
      }),
    );
  }
  if (
    isContainerNetworkMode(news.networkMode) &&
    ((news.ports?.length ?? 0) > 0 || (news.networks?.length ?? 0) > 0)
  ) {
    return Effect.fail(
      new InvalidContainerOptions({
        message: "Docker.Container networkMode.container cannot be combined with ports or networks",
      }),
    );
  }
  const targets = new Set<string>();
  for (const device of news.devices ?? []) {
    if (targets.has(device.containerPath)) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container devices contain conflicting target path ${device.containerPath}`,
        }),
      );
    }
    targets.add(device.containerPath);
  }
  const tmpfsTargets = new Set<string>();
  for (const mount of news.tmpfs ?? []) {
    if (mount.size !== undefined && mount.size.trim().length === 0) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container tmpfs size cannot be empty for ${mount.path}`,
        }),
      );
    }
    if (!mount.path.startsWith("/") || mount.path.includes(":") || mount.path.includes(",")) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container tmpfs target must be an absolute path: ${mount.path}`,
        }),
      );
    }
    if (tmpfsTargets.has(mount.path)) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container tmpfs contains duplicate target ${mount.path}`,
        }),
      );
    }
    if (
      mount.mode !== undefined &&
      (!Number.isInteger(mount.mode) || mount.mode < 0 || mount.mode > 0o7777)
    ) {
      return Effect.fail(
        new InvalidContainerOptions({
          message: `Docker.Container tmpfs mode is not a valid POSIX mode for ${mount.path}`,
        }),
      );
    }
    tmpfsTargets.add(mount.path);
  }
  return Effect.void;
};

const isContainerNetworkMode = (mode: Container.NetworkMode | undefined): boolean =>
  typeof mode === "string" ? mode.startsWith("container:") : mode !== undefined;

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
  for (const [internal, bindings] of Object.entries(info.HostConfig.PortBindings ?? {})) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  for (const [internal, bindings] of Object.entries(info.NetworkSettings.Ports ?? {})) {
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

const normalizeDuration = (input: Duration.Input | undefined): string | undefined => {
  if (!input) return undefined;
  const duration = Duration.fromInputUnsafe(input);
  // Docker parses `--health-*` durations with Go's `time.ParseDuration`, which
  // requires a unit suffix — a bare nanosecond count is rejected with "missing
  // unit in duration". `ns` is the lossless Go-duration rendering of the nanos.
  return `${Duration.toNanosUnsafe(duration).toString()}ns`;
};
