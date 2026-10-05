import type {
  FlyMachineConfig,
  FlyMachineGuest,
  FlyMachineInit,
  FlyMachineMount,
  FlyMachineRestart,
  FlyMachineService,
  Machine as FlyMachine,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { Input } from "../Input.ts";
import type { DiskSpec, MountedDisk, ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";

import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import { App } from "./App.ts";
import {
  deploymentPolicy,
  validateDeployment,
  type MachineDeploy,
  type MachineShutdown,
  type MachineCheck,
} from "./Deployment.ts";
import { toEnvRecord } from "./hosted.ts";
import {
  sameContainerWorkload,
  toFlyContainers,
  validateMachineContainers,
} from "./MachineContainers.ts";
import {
  createFlyResourceName,
  diffMachineMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import {
  deleteReplicaSet,
  listReplicaSets,
  observeReplicaSet,
  reconcileReplicas,
  resolveCount,
  sameServices,
  toFlyService,
  volumeIdsOf,
  type Replica,
  type ReplicaSet,
} from "./replicas.ts";

export type { Replica };

const DEFAULT_REGION = "iad";
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 256;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface MachineGuest {
  /**
   * CPU kind (`shared`, `performance`, `shared-cpu-1x`, …).
   *
   * @default "shared"
   */
  cpuKind?: string;
  /**
   * Number of CPUs.
   *
   * @default 1
   */
  cpus?: number;
  /**
   * Memory in MB.
   *
   * @default 256
   */
  memoryMb?: number;
  /** GPU kind, if this Machine should have a GPU. */
  gpuKind?: string;
  /** Number of GPUs. */
  gpus?: number;
}

export interface MachineInit {
  /** Process command. */
  cmd?: string[];
  /** Container entrypoint. */
  entrypoint?: string[];
  /** Exec form override. */
  exec?: string[];
  /** Swap size in MB. */
  swapSizeMb?: number;
  /** Allocate a TTY. */
  tty?: boolean;
}

export interface MachineRestart {
  /**
   * Restart policy (`no`, `always`, `on-failure`, `spot-price`).
   */
  policy?: "no" | "always" | "on-failure" | "spot-price";
  /** Max restarts when `policy` is `on-failure`. */
  maxRetries?: number;
}

export interface MachinePort {
  /** Published proxy port. */
  port?: number;
  /** Fly handlers (`http`, `tls`, `pg_tls`, …). */
  handlers?: string[];
  /** Redirect HTTP to HTTPS on this port. */
  forceHttps?: boolean;
  /** Inclusive start of a published port range. */
  startPort?: number;
  /** Inclusive end of a published port range. */
  endPort?: number;
}

/** A health check attached to a Fly service. */
export interface MachineServiceCheck {
  /** Check type. HTTP checks send a request; TCP checks open a connection. */
  type: "http" | "tcp";
  /** Port to check. Usually the service's {@link MachineService.internalPort}. */
  port?: number;
  /**
   * Time between checks, such as `"15s"`.
   * Fly caps service checks at `"60s"`; this cap does not apply to named Machine checks.
   */
  interval?: string;
  /** Maximum time for a check, such as `"2s"`. */
  timeout?: string;
  /** Delay after the Machine starts before checks begin, such as `"30s"`. */
  gracePeriod?: string;
  /** HTTP method for an `http` check. */
  method?: string;
  /** Request path for an `http` check. */
  path?: string;
  /** Request protocol for an `http` check. */
  protocol?: "http" | "https";
  /** Headers sent by an `http` check. */
  headers?: Array<{
    /** Header name. */
    name: string;
    /** Header values. */
    values: string[];
  }>;
  /** Hostname used to validate the certificate for an HTTPS check. */
  tlsServerName?: string;
  /** Skip certificate verification for an HTTPS check. */
  tlsSkipVerify?: boolean;
}

export interface MachineService {
  /**
   * Proxy protocol (`tcp` or `udp`).
   */
  protocol?: string;
  /** Port the process listens on inside the Machine. */
  internalPort?: number;
  /** Published Fly proxy ports. */
  ports?: MachinePort[];
  /** Start this Machine when a request arrives. */
  autostart?: boolean;
  /**
   * Stop or suspend this Machine when idle.
   */
  autostop?: "off" | "stop" | "suspend" | boolean;
  /** Minimum Machines to keep running for this service. */
  minMachinesRunning?: number;
  /** Health checks for this service. */
  checks?: MachineServiceCheck[];
}

export type MachineMount = DiskSpec;

/** Startup dependency on another named container in the same Machine. */
export interface MachineContainerDependency {
  /** Name of another container in this Machine. */
  name: string;
  /** Startup condition Fly waits for. */
  condition?: "started" | "healthy" | "exited_successfully";
}

/** A native Pilot health check; timing fields are numeric seconds. */
export interface MachineContainerHealthCheck {
  /** Optional check name, unique within this container. */
  name?: string;
  /** Whether the check gates readiness or liveness. */
  kind?: "readiness" | "liveness";
  /** Seconds between checks. */
  interval?: number;
  /** Seconds before a check times out. */
  timeout?: number;
  /** Seconds after startup before checks begin. */
  gracePeriod?: number;
  /** Consecutive successes required to become healthy. */
  successThreshold?: number;
  /** Consecutive failures required to become unhealthy. */
  failureThreshold?: number;
  /** HTTP probe. Configure exactly one of HTTP, TCP, or exec. */
  http?: {
    /** Container-local port. */
    port: number;
    /** Request path. */
    path?: string;
    /** Request method. */
    method?: string;
    /** Request scheme. */
    scheme?: "http" | "https";
    /** Additional request headers. */
    headers?: Array<{ name: string; values: string[] }>;
    /** Hostname for TLS certificate verification. */
    tlsServerName?: string;
    /** Skip TLS certificate verification. */
    tlsSkipVerify?: boolean;
  };
  /** TCP connection probe. */
  tcp?: { port: number };
  /** Process execution probe. */
  exec?: { command: string[] };
}

/** One named container in a Machine replica. */
export interface MachineContainer {
  /** Stable name identifying this container within the group. */
  name: string;
  /** Docker image reference. Rolling deployments accept tags or digests. */
  image: string;
  /** Command override. */
  cmd?: string[];
  /** Entrypoint override. */
  entrypoint?: string[];
  /** Per-container environment variables; Fly applies these over Machine env. */
  env?: Record<string, string>;
  /** Other named containers that must reach a startup condition first. */
  dependsOn?: MachineContainerDependency[];
  /** Native Pilot checks for this container. Deployment readiness is configured separately. */
  healthChecks?: MachineContainerHealthCheck[];
}

export interface MachinePropsBase {
  /** Deployment strategy and readiness deadline. Defaults to in-place rolling updates. */
  deploy?: MachineDeploy;
  /** Graceful process shutdown. Defaults to SIGTERM / 30 seconds when blue/green is enabled. */
  shutdown?: MachineShutdown;
  /** Named readiness checks for workers without public services. */
  checks?: Record<string, MachineCheck>;
  /**
   * Parent Fly App. Changing it replaces the Machine.
   */
  app: Ref<App>;
  /**
   * Machine name. Unique per App. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the Machine.
   * In blue/green mode this is a base for generation-qualified physical names.
   */
  name?: string;
  /**
   * Region to start the Machine in (`iad`, `ewr`, `ord`, …). Changing it
   * replaces the Machine.
   *
   * @default "iad"
   */
  region?: string;
  /**
   * Number of Machines to provision, including stopped/suspended idle capacity.
   * Fly's proxy load-balances published `services` across available replicas.
   * Blue/green checks a representative and the required running floor while
   * preserving idle nonrepresentatives. Each replica gets its own Volume
   * from every {@link mounts} group; attached volumes require rolling updates.
   *
   * @default 1
   */
  count?: number;
  /**
   * Guest size. Defaults to shared-cpu-1x 256 MB.
   */
  guest?: MachineGuest;
  /**
   * Environment variables. Merged with binding `env`.
   */
  env?: Record<string, string>;
  /**
   * Fly proxy services (HTTP/TCP ports).
   */
  services?: MachineService[];
  /**
   * Disks to attach. Each entry is a Fly volume group: `count`
   * independent Volumes, one mounted on each replica. Also collected
   * from `MountVolume` bindings.
   */
  mounts?: MachineMount[];
  /**
   * User metadata. Alchemy ownership keys (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id` / `alchemy.type` /
   * `alchemy.replica`) are always merged.
   */
  metadata?: Record<string, string>;
  /**
   * Destroy the Machine when its main process exits.
   *
   * @default false
   */
  autoDestroy?: boolean;
  /**
   * Restart policy after the main process exits.
   */
  restart?: MachineRestart;
  /**
   * Create or update without launching the Machine.
   *
   * @default false
   */
  skipLaunch?: boolean;
  /**
   * Minimum App-secrets version required by this Machine, not an immutable
   * snapshot. Other writers can advance the shared vault. Secret changes are
   * not automatically watched; change an explicit deployment input or floor
   * when an out-of-band rotation requires reconciliation.
   */
  minSecretsVersion?: number;
}

export type MachineProps =
  | (MachinePropsBase & {
      /** Docker image reference. Rolling updates change the existing Machines. */
      image: string;
      containers?: never;
      /** Process init overrides for a single-image Machine. */
      init?: MachineInit;
    })
  | (MachinePropsBase & {
      /** Named containers run together in every Machine replica. */
      containers: MachineContainer[];
      image?: never;
      init?: never;
    });

export type MachineImageRef = {
  registry?: string;
  repository?: string;
  tag?: string;
  digest?: string;
};

export type Machine = Resource<
  "Fly.Machine",
  MachineProps,
  {
    /** Whether recovery must finish an interrupted deployment. */
    rolloutPending?: boolean;
    /** Parent Fly App name. */
    appName: string;
    /** Fly Machine id of replica 0. */
    machineId: string;
    /** Fly Machine ids of every replica. */
    machineIds: string[];
    /** Logical base for generation-qualified Machine names. */
    baseName?: string;
    /** Machine name of replica 0 (unique per App). Changes during blue/green deployment. */
    name: string;
    /** Region the Machines are running in. */
    region: string;
    /** Observed state of replica 0 (`created`, `started`, `stopped`, …). */
    state: string;
    /** Fly instance / version id of replica 0, if the API returned one. */
    instanceId: string | undefined;
    /** Internal 6PN address of replica 0. */
    privateIp: string | undefined;
    /** Parsed image reference from Fly. */
    imageRef: MachineImageRef | undefined;
    /** Observed guest size. */
    guest: MachineGuest | undefined;
    /** Number of Machines in the replica set. */
    count: number;
    /** Disks mounted on replica 0. */
    mounts: MountedDisk[];
    /** Every replica in the set. */
    replicas: Replica[];
  },
  ServiceBinding,
  Providers
>;

/**
 * A Fly.Machine is a Firecracker VM running one image or a named container group.
 *
 * Prefer a {@link Service} when the program is Effect. A Service is effectful, supports bindings,
 * and scales with `count`. Alchemy builds and pushes the image. Use `Fly.Machine` when you already
 * have an image.
 *
 * @see https://fly.io/docs/machines/api/machines-resource/
 *
 * ### Prefer a Service
 * Declare a {@link Service} when you own the program. Alchemy bundles
 * `main`, builds `linux/amd64`, and pushes to `registry.fly.io`.
 *
 * **Example:** Effect HTTP service
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", count: 3, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Launch a Machine
 * The parent is an {@link App}. Pin a region and an image. Guest
 * defaults to shared-cpu 1× / 256 MB. Rolling updates `image` in place;
 * blue/green prepares replacement Machines.
 *
 * **Example:** Nginx
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 * });
 * ```
 *
 * :::caution[Changing `app` replaces the Machine]
 * The new App gets a new Machine. The old one is deleted.
 * :::
 *
 * ### Run named containers
 * Each replica contains the entire group. Container checks and dependencies
 * control Pilot startup; configure Machine or service checks for deployment
 * readiness. Rolling updates can restart the entire group when one image
 * changes. Blue/green requires every named image to use an immutable
 * `repository@sha256:` digest and cannot attach volumes. Alchemy replaces
 * the entire group and applies readiness policy before retiring predecessors.
 *
 * **Example:** API and worker
 * ```typescript
 * const preview = yield* Fly.Machine("Preview", {
 *   app: Site,
 *   containers: [
 *     { name: "api", image: apiImage, healthChecks: [{ http: { port: 3000, path: "/health" } }] },
 *     { name: "worker", image: workerImage, dependsOn: [{ name: "api", condition: "healthy" }] },
 *   ],
 * });
 * ```
 *
 * ### A stable name
 * Machine names are unique per App. Omit `name` and Alchemy generates
 * one from the stack, stage, and logical ID.
 *
 * **Example:** Explicit name
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   name: "web",
 *   region: "iad",
 *   image: "nginx:alpine",
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the Machine]
 * Fly cannot rename a Machine. Alchemy creates the new name, then
 * deletes the old one.
 * :::
 *
 * ### Region
 * Fly Machines live in a region. Default is `iad`. See
 * [Regions](/fly/compute/regions) for the list of codes.
 *
 * **Example:** Pin a region
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "ewr",
 *   image: "nginx:alpine",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the Machine]
 * The Machine is created in the new region. The old one is deleted.
 * :::
 *
 * ### Guest size
 * `guest` is CPU kind, CPU count, and memory. Default is shared-cpu,
 * 1 CPU, 256 MB. Rolling updates guest sizing in place; blue/green replaces
 * the Machines.
 *
 * **Example:** Shared CPU
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
 * });
 * ```
 *
 * ### GPU
 * Set `gpuKind` and `gpus` on `guest` when the Machine should have a
 * GPU.
 *
 * **Example:** GPU guest
 * ```typescript
 * const worker = yield* Fly.Machine("Worker", {
 *   app: Site,
 *   region: "iad",
 *   image: "my-gpu-image:tag",
 *   guest: {
 *     cpuKind: "performance",
 *     cpus: 2,
 *     memoryMb: 4096,
 *     gpuKind: "a10",
 *     gpus: 1,
 *   },
 * });
 * ```
 *
 * ### Environment variables
 * `env` is merged onto the Machine. Fly also injects App
 * {@link Secret} values as env vars unless the Machine skips secrets.
 *
 * **Example:** Set env
 * ```typescript
 * const worker = yield* Fly.Machine("Worker", {
 *   app: Site,
 *   region: "iad",
 *   image: "my-image:tag",
 *   env: { LOG_LEVEL: "info" },
 * });
 * ```
 *
 * ### Publish a proxy service
 * `services` publishes ports on Fly's proxy. The App needs an
 * {@link IpAssignment} before `{app}.fly.dev` answers. For a public
 * endpoint without managing Apps and addresses, use a {@link Service}.
 *
 * Handlers are `http`, `tls`, `pg_tls`, and similar. Set `forceHttps`
 * to redirect HTTP to HTTPS. Use `startPort` / `endPort` for a
 * published range.
 *
 * Omit `services` (or pass `[]`) for a process that should not be
 * reachable from the internet.
 *
 * **Example:** HTTP on port 80
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       ports: [
 *         { port: 80, handlers: ["http"], forceHttps: true },
 *         { port: 443, handlers: ["tls", "http"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Service health checks
 * Add HTTP or TCP `checks` to a service. Fly uses their results to
 * determine whether the service is ready to receive traffic. With rolling
 * updates, reconcile waits for each started replica's checks before updating
 * the next replica. Missing or non-passing results are polled within
 * `deploy.healthTimeout` (60 seconds by default), then fail deployment with
 * `Fly.ReplicaChecksNotPassing`. Later replicas remain unchanged; earlier
 * updates are not rolled back. A single rolling replica can be unavailable.
 * Blue/green checks replacements before retiring the old set, with
 * representative/floor readiness for idle capacity.
 *
 * **Example:** HTTP readiness check
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       ports: [{ port: 80, handlers: ["http"] }],
 *       checks: [
 *         {
 *           type: "http",
 *           port: 80,
 *           method: "GET",
 *           path: "/",
 *           protocol: "http",
 *           interval: "15s",
 *           timeout: "2s",
 *           gracePeriod: "30s",
 *           headers: [{ name: "X-Health-Check", values: ["alchemy"] }],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Autostart and autostop
 * `autostart` starts the Machine when a request arrives. `autostop` is
 * `"off"`, `"stop"`, `"suspend"`, or a boolean. `minMachinesRunning`
 * keeps that many Machines up for the service.
 *
 * Autostop only affects Machines that already exist. Set `count` or declare
 * more resources to size the pool. Stop boots a new process on autostart;
 * suspend may resume memory or fall back to a cold start. Suspension is not
 * SIGTERM shutdown and does not run ordinary shutdown finalizers.
 *
 * Blue/green supports both policies: it checks a representative and the
 * required running floor while preserving idle nonrepresentatives. It
 * restores the requested idle policy before retiring predecessors and
 * checks any new instance created by restoration. A replacement does not
 * inherit its suspended predecessor's process memory.
 *
 * **Example:** Stop when idle
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       autostart: true,
 *       autostop: "stop",
 *       minMachinesRunning: 0,
 *       ports: [{ port: 80, handlers: ["http"] }],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Scale up
 * Each Machine resource runs one VM by default. Set `count` to manage
 * several replicas together, or declare separate resources for Machines
 * with different configuration. Fly's proxy load-balances published
 * `services` across them.
 *
 * Both Machine and {@link Service} support `count`. Default rolling updates
 * replicas sequentially; blue/green prepares replacements before retirement.
 * Separate resources do not share an update order or App-wide lease lock.
 *
 * **Example:** Two Machines
 * ```typescript
 * const web1 = yield* Fly.Machine("Web1", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       ports: [{ port: 80, handlers: ["http"] }],
 *     },
 *   ],
 * });
 *
 * const web2 = yield* Fly.Machine("Web2", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       ports: [{ port: 80, handlers: ["http"] }],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Scale down
 * Remove a Machine from the stack. The next deploy deletes it.
 *
 * **Example:** Drop Web2
 * ```diff
 *   const web1 = yield* Fly.Machine("Web1", {
 *     app: Site,
 *     region: "iad",
 *     image: "nginx:alpine",
 *   });
 * -
 * - const web2 = yield* Fly.Machine("Web2", {
 * -   app: Site,
 * -   region: "iad",
 * -   image: "nginx:alpine",
 * - });
 * ```
 *
 * ### Attach a disk
 * Pass disks as `mounts`. Alchemy creates a Volume in the Machine's
 * app and region. A Volume attaches to one Machine. There is no
 * standalone Volume resource.
 *
 * `sizeGb` can grow in place. Shrinking is not supported. Encryption,
 * filesystem type, `snapshotId`, and `sourceVolumeId` are create-only.
 * See {@link MountVolume} for the full disk spec. From a Service,
 * prefer `MountVolume` so the path is part of the binding graph.
 *
 * **Example:** Mount `/data`
 * ```typescript
 * const box = yield* Fly.Machine("Box", {
 *   app: Site,
 *   region: "iad",
 *   image: "postgres:16",
 *   mounts: [{ path: "/data", sizeGb: 10 }],
 * });
 * ```
 *
 * ### Init
 * `init` overrides `cmd`, `entrypoint`, `exec`, swap, and TTY. Updates
 * in place.
 *
 * **Example:** Custom command
 * ```typescript
 * const box = yield* Fly.Machine("Box", {
 *   app: Site,
 *   region: "iad",
 *   image: "postgres:16",
 *   init: { cmd: ["postgres", "-c", "shared_buffers=256MB"] },
 * });
 * ```
 *
 * ### Restart policy
 * `restart.policy` is `"no"`, `"always"`, `"on-failure"`, or
 * `"spot-price"`. `maxRetries` applies when the policy is
 * `"on-failure"`. Updates in place.
 *
 * **Example:** Always restart
 * ```typescript
 * const worker = yield* Fly.Machine("Worker", {
 *   app: Site,
 *   region: "iad",
 *   image: "my-image:tag",
 *   restart: { policy: "always" },
 * });
 * ```
 *
 * ### Destroy on exit
 * `autoDestroy: true` tears the Machine down when its main process
 * exits. Default is `false`.
 *
 * **Example:** One-shot Machine
 * ```typescript
 * const job = yield* Fly.Machine("Job", {
 *   app: Site,
 *   region: "iad",
 *   image: "my-job:tag",
 *   autoDestroy: true,
 *   restart: { policy: "no" },
 * });
 * ```
 *
 * ### Skip launch
 * `skipLaunch: true` creates or updates the config without starting
 * the Machine. Default is `false`. Reconcile otherwise waits until
 * the Machine is `started`, and until service checks are passing when
 * the Machine has them.
 *
 * **Example:** Config only
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   skipLaunch: true,
 * });
 * ```
 *
 * ### Metadata
 * User keys on `metadata` merge with Alchemy ownership keys
 * (`alchemy.stack`, `alchemy.stage`, `alchemy.id`, `alchemy.type`,
 * `alchemy.replica`). Those ownership keys are always written so
 * `list()` can find owned Machines. Fly Apps have no labels.
 *
 * **Example:** User metadata
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   metadata: { role: "edge" },
 * });
 * ```
 *
 * ### Secrets version
 * `minSecretsVersion` requires at least that App-secrets version, not an
 * immutable snapshot. Machine leases do not serialize vault writers.
 * After rotating a {@link Secret}, declare the required floor or another
 * explicit rollout input; an out-of-band change alone does not watch/redeploy.
 *
 * **Example:** Wait for secrets
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   minSecretsVersion: 2,
 * });
 * ```
 *
 * ### Blue/green deployments
 * Prepare a healthy replacement set before retiring the current Machines.
 * Physical IDs and names change; the App URL remains stable. Volumes,
 * auto-destroy, and skipLaunch are incompatible. Autostop preserves idle
 * nonrepresentatives while a representative passes checks. Raw images must
 * handle their own shutdown signal and stop accepting background work.
 *
 * Retirement honors each predecessor's own signal and timeout. Native
 * target leases do not exclude every simultaneous first deployment or
 * snapshot; serialize CI for the same resource. See the
 * [deployment guide](/fly/compute/deployments) for idle capacity, secret
 * floors, recovery, and the limits of live-tested parity.
 *
 * **Example:** Private worker readiness
 * ```typescript
 * const worker = yield* Fly.Machine("Worker", {
 *   app: Site,
 *   image: "registry.example.com/worker:v2",
 *   deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
 *   shutdown: { signal: "SIGTERM", timeout: "30 seconds" },
 *   checks: {
 *     ready: { type: "http", port: 3000, path: "/healthz", interval: "5s", timeout: "2s" },
 *   },
 * });
 * ```
 *
 * Every published service needs its own service check. Before promotion, a
 * failed candidate leaves the old generation serving. After possible promotion,
 * potentially serving replacements are preserved rather than blindly deleted.
 * Retry an interrupted deploy to finish promotion or retirement; destroy
 * discovers unfinished owned generations.
 * See the [deployment guide](/fly/compute/deployments) for recovery and limits.
 *
 * @resource
 * @product Machine
 */
export const Machine = Resource<Machine>("Fly.Machine");

export class MachineNotCreated extends Data.TaggedError(
  "Fly.MachineNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class MachineAppNotResolved extends Data.TaggedError(
  "Fly.MachineAppNotResolved",
)<{
  message: string;
}> {}

type MachineBinding = Machine["Binding"];

const appNameOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const name = (value as { appName?: unknown }).appName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const compactRecord = (
  record: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const toEnv = toEnvRecord;

const resolveMachineName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyResourceName(id);
  });

const mergeBindings = (
  bindings: readonly ResourceBinding<MachineBinding>[],
) => {
  const env: Record<string, any> = {};
  const mounts: DiskSpec[] = [];
  for (const binding of bindings) {
    Object.assign(env, binding.data?.env);
    if (binding.data?.mounts) mounts.push(...binding.data.mounts);
  }
  return { env, mounts };
};

const mergeDisks = (
  props: DiskSpec[] | undefined,
  bindingMounts: DiskSpec[],
): DiskSpec[] => {
  const byPath = new Map<string, DiskSpec>();
  for (const disk of [...(props ?? []), ...bindingMounts]) {
    byPath.set(disk.path, disk);
  }
  return [...byPath.values()];
};

const toFlyGuest = (guest: MachineGuest | undefined): FlyMachineGuest => {
  const fly: FlyMachineGuest = {
    cpu_kind: guest?.cpuKind ?? DEFAULT_CPU_KIND,
    cpus: guest?.cpus ?? DEFAULT_CPUS,
    memory_mb: guest?.memoryMb ?? DEFAULT_MEMORY_MB,
  };
  if (guest?.gpuKind !== undefined) fly.gpu_kind = guest.gpuKind;
  if (guest?.gpus !== undefined) fly.gpus = guest.gpus;
  return fly;
};

const toFlyInit = (init: MachineInit): FlyMachineInit => ({
  cmd: init.cmd,
  entrypoint: init.entrypoint,
  exec: init.exec,
  swap_size_mb: init.swapSizeMb,
  tty: init.tty,
});

const toFlyRestart = (restart: MachineRestart): FlyMachineRestart => ({
  policy: restart.policy,
  max_retries: restart.maxRetries,
});

const desiredEnv = (
  props: MachineProps,
  bindingEnv: Record<string, any>,
): Record<string, string> => ({ ...toEnv(props.env), ...toEnv(bindingEnv) });

const desiredMetadata = (
  props: MachineProps,
  alchemy: Record<string, string>,
): Record<string, string> => ({ ...(props.metadata ?? {}), ...alchemy });

const buildConfig = (input: {
  image: string | undefined;
  containers: FlyMachineConfig["containers"];
  guest: FlyMachineGuest;
  env: Record<string, string>;
  services: FlyMachineService[] | undefined;
  mounts: FlyMachineMount[];
  metadata: Record<string, string>;
  restart: FlyMachineRestart | undefined;
  autoDestroy: boolean | undefined;
  init: FlyMachineInit | undefined;
}): FlyMachineConfig => ({
  image: input.image,
  containers: input.containers,
  guest: input.guest,
  env: Object.keys(input.env).length > 0 ? input.env : undefined,
  services:
    input.services !== undefined && input.services.length > 0
      ? input.services
      : undefined,
  mounts: input.mounts.length > 0 ? input.mounts : undefined,
  metadata: input.metadata,
  restart: input.restart,
  auto_destroy: input.autoDestroy,
  init: input.init,
});

const sameImage = (machine: FlyMachine, image: string) => {
  const configImage = machine.config?.image;
  if (configImage === image) return true;
  const ref = machine.image_ref;
  const colon = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  const split = colon > slash ? colon : -1;
  const repo = split === -1 ? image : image.slice(0, split);
  const tag = split === -1 ? "latest" : image.slice(split + 1);
  const observedRepo = ref?.repository;
  if (observedRepo === undefined || ref?.tag !== tag) return false;
  return observedRepo === repo || observedRepo.endsWith(`/${repo}`);
};

const sameGuest = (
  observed: FlyMachineGuest | undefined,
  desired: FlyMachineGuest,
) =>
  (observed?.cpu_kind ?? DEFAULT_CPU_KIND) === desired.cpu_kind &&
  (observed?.cpus ?? DEFAULT_CPUS) === desired.cpus &&
  (observed?.memory_mb ?? DEFAULT_MEMORY_MB) === desired.memory_mb &&
  observed?.gpu_kind === desired.gpu_kind &&
  observed?.gpus === desired.gpus;

const sameEnv = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => deepEqual(compactRecord(observed), desired);

const sameMounts = (
  observed: FlyMachineMount[] | undefined,
  desired: FlyMachineMount[],
) => {
  const key = (mount: FlyMachineMount) =>
    `${mount.volume ?? ""}:${mount.path ?? ""}`;
  const left = [...(observed ?? [])].map(key).sort();
  const right = desired.map(key).sort();
  return deepEqual(left, right);
};

const sameRestart = (
  observed: FlyMachineRestart | undefined,
  desired: FlyMachineRestart | undefined,
) =>
  deepEqual(
    {
      policy: observed?.policy ?? "on-failure",
      max_retries: observed?.max_retries ?? 10,
    },
    {
      policy: desired?.policy ?? "on-failure",
      max_retries: desired?.max_retries ?? 10,
    },
    { stripNullish: true },
  );

const sameInit = (
  observed: FlyMachineInit | undefined,
  desired: FlyMachineInit | undefined,
) => deepEqual(observed ?? {}, desired ?? {}, { stripNullish: true });

const metadataChanged = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => {
  const { removed, added, updated } = diffMachineMetadata(
    compactRecord(observed),
    desired,
  );
  return (
    removed.length > 0 ||
    Object.keys(added).length > 0 ||
    Object.keys(updated).length > 0
  );
};

const configDrifted = (
  machine: FlyMachine,
  desired: {
    image: string | undefined;
    containers: FlyMachineConfig["containers"];
    guest: FlyMachineGuest;
    env: Record<string, string>;
    services: FlyMachineService[] | undefined;
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
    restart: FlyMachineRestart | undefined;
    autoDestroy: boolean | undefined;
    init: FlyMachineInit | undefined;
  },
) => {
  const config = machine.config;
  return (
    (desired.containers !== undefined
      ? !sameContainerWorkload(config, desired.containers)
      : desired.image === undefined ||
        !sameImage(machine, desired.image) ||
        (config?.containers?.length ?? 0) > 0) ||
    !sameGuest(config?.guest, desired.guest) ||
    !sameEnv(config?.env, desired.env) ||
    !sameServices(config?.services, desired.services) ||
    !sameMounts(config?.mounts, desired.mounts) ||
    metadataChanged(config?.metadata, desired.metadata) ||
    !sameRestart(config?.restart, desired.restart) ||
    (desired.autoDestroy ?? false) !== (config?.auto_destroy ?? false) ||
    !sameInit(config?.init, desired.init)
  );
};

const toAttrs = (set: ReplicaSet): Machine["Attributes"] => ({
  appName: set.appName,
  rolloutPending: set.rolloutPending,
  machineId: set.machineId,
  machineIds: set.machineIds,
  name: set.name,
  baseName: set.baseName,
  region: set.region,
  state: set.state,
  instanceId: set.instanceId,
  privateIp: set.privateIp,
  imageRef: set.imageRef,
  guest: set.guest,
  count: set.count,
  mounts: set.mounts,
  replicas: set.replicas,
});

const machineIdsOf = (output: Machine["Attributes"] | undefined) =>
  output?.machineIds ??
  (output?.machineId !== undefined && output.machineId.length > 0
    ? [output.machineId]
    : []);

export const MachineProvider = () =>
  Provider.succeed(Machine, {
    stables: ["region", "appName"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined) return;
      if ("app" in news) {
        const imageMode = {
          image: news.image,
          containers: news.containers,
          init: news.init,
        };
        const imageModeResolved =
          isResolved<Pick<MachineProps, "image" | "containers" | "init">>(
            imageMode,
          );
        if (imageModeResolved) yield* validateMachineContainers(imageMode);
        const settings: Input<
          Pick<
            MachineProps,
            | "deploy"
            | "shutdown"
            | "checks"
            | "services"
            | "mounts"
            | "skipLaunch"
            | "autoDestroy"
            | "restart"
            | "containers"
          >
        > = {
          deploy: news.deploy,
          shutdown: news.shutdown,
          checks: news.checks,
          services: news.services,
          mounts: news.mounts,
          skipLaunch: news.skipLaunch,
          autoDestroy: news.autoDestroy,
          restart: news.restart,
          containers: news.containers,
        };
        if (
          imageModeResolved &&
          isResolved<
            Pick<
              MachineProps,
              | "deploy"
              | "shutdown"
              | "checks"
              | "services"
              | "mounts"
              | "skipLaunch"
              | "autoDestroy"
              | "restart"
              | "containers"
            >
          >(settings)
        ) {
          yield* validateDeployment(
            yield* deploymentPolicy(settings.deploy, settings.shutdown),
            {
              services: settings.services?.map(toFlyService),
              checks: settings.checks,
              auto_destroy: settings.autoDestroy,
              restart: settings.restart,
              containers:
                settings.containers === undefined
                  ? undefined
                  : toFlyContainers(settings.containers),
            },
            (settings.mounts?.length ?? 0) > 0,
            settings.skipLaunch,
          );
        }
      }
      if (!isResolved(news))
        return output?.rolloutPending
          ? { action: "update" as const }
          : undefined;
      yield* validateMachineContainers(news);
      if (output === undefined) return undefined;
      const desiredAppName = appNameOf(news.app);
      const appChanged =
        desiredAppName !== undefined && desiredAppName !== output.appName;
      const desiredName =
        news.name !== undefined
          ? sanitizeFlyAppName(news.name)
          : (output.baseName ?? output.name);
      const nameChanged = desiredName !== (output.baseName ?? output.name);
      const desiredRegion = news.region ?? DEFAULT_REGION;
      const regionChanged = desiredRegion !== output.region;
      if (appChanged || nameChanged || regionChanged) {
        return {
          action: "replace" as const,
          // Name is unique per App — same name in a new region cannot coexist.
          deleteFirst: nameChanged === false && appChanged === false,
        };
      }
      return output.rolloutPending ? { action: "update" as const } : undefined;
    }),

    read: Effect.fn(function* ({ id, fqn, instanceId, olds, output }) {
      const appName = appNameOf(olds?.app) ?? output?.appName;
      const name = yield* resolveMachineName(
        id,
        olds?.name,
        output?.baseName ?? output?.name,
      );
      const found = yield* observeReplicaSet({
        appName,
        id,
        type: "Fly.Machine",
        fqn,
        resourceInstanceId: instanceId,
        machineIds: machineIdsOf(output),
        baseName: name,
      });
      if (found === undefined) return undefined;
      return toAttrs(found);
    }),

    list: Effect.fn(function* () {
      const sets = yield* listReplicaSets("Fly.Machine");
      return sets.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      fqn,
      instanceId,
      news,
      output,
      bindings,
    }) {
      const props = news;
      yield* validateMachineContainers(props);
      const policy = yield* deploymentPolicy(props.deploy, props.shutdown);
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new MachineAppNotResolved({
          message: "Fly.Machine requires a resolved App with appName.",
        });
      }
      const name = yield* resolveMachineName(
        id,
        props.name,
        output?.baseName ?? output?.name,
      );
      const region = props.region ?? output?.region ?? DEFAULT_REGION;
      const count = resolveCount(props.count);
      const skipLaunch = props.skipLaunch === true;
      const bound = mergeBindings(bindings ?? []);
      const disks = mergeDisks(props.mounts, bound.mounts);
      const env = desiredEnv(props, bound.env);
      const guest = toFlyGuest(props.guest);
      const services = props.services?.map(toFlyService);
      const restart = props.restart ? toFlyRestart(props.restart) : undefined;
      const init = props.init ? toFlyInit(props.init) : undefined;
      const containers =
        props.containers === undefined
          ? undefined
          : toFlyContainers(props.containers);

      const set = yield* reconcileReplicas({
        id,
        type: "Fly.Machine",
        fqn,
        resourceInstanceId: instanceId,
        policy,
        checks: props.checks,
        appName,
        baseName: name,
        regions: [region],
        count,
        disks,
        skipLaunch,
        minSecretsVersion: props.minSecretsVersion,
        outputMachineIds: machineIdsOf(output),
        preferVolumeIds: (output?.replicas ?? []).map((replica) =>
          replica.mounts.map((mount) => mount.volumeId),
        ),
        configDrifted: (machine, desired) =>
          configDrifted(machine, {
            image: props.image,
            containers,
            guest,
            env,
            services,
            mounts: desired.mounts,
            metadata: desiredMetadata(props, desired.metadata),
            restart,
            autoDestroy: props.autoDestroy,
            init,
          }),
        buildConfig: ({ mounts, metadata }) =>
          buildConfig({
            image: props.image,
            containers,
            guest,
            env,
            services,
            mounts,
            metadata: desiredMetadata(props, metadata),
            restart,
            autoDestroy: props.autoDestroy,
            init,
          }),
      }).pipe(
        Effect.catchTag("Fly.ReplicaNotCreated", (error) =>
          Effect.fail(
            new MachineNotCreated({ name: error.name, appName: error.appName }),
          ),
        ),
      );
      return toAttrs(set);
    }),

    delete: Effect.fn(function* ({ id, fqn, instanceId, olds, output, force }) {
      const appName = output.appName ?? appNameOf(olds.app);
      if (appName === undefined) return;
      yield* deleteReplicaSet({
        appName,
        id,
        type: "Fly.Machine",
        fqn,
        resourceInstanceId: instanceId,
        machineIds: machineIdsOf(output),
        volumeIds: volumeIdsOf(output),
        force,
      });
    }),
  });
