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
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import { App } from "./App.ts";
import { toEnvRecord } from "./hosted.ts";
import {
  createFlyResourceName,
  diffMachineMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { DiskSpec, MountedDisk, ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";
import {
  deleteReplicaSet,
  listReplicaSets,
  observeReplicaSet,
  reconcileReplicas,
  resolveCount,
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
}

export type MachineMount = DiskSpec;

export interface MachineProps {
  /**
   * Parent Fly App. Changing it replaces the Machine.
   */
  app: Ref<App>;
  /**
   * Machine name. Unique per App. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the Machine.
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
   * Number of Machines to keep running. Fly's proxy load-balances
   * published `services` across them. Each replica gets its own
   * Volume from every {@link mounts} group.
   *
   * @default 1
   */
  count?: number;
  /**
   * Docker image reference. Updated in place via `updateMachine`.
   */
  image: string;
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
   * Init overrides (`cmd`, `entrypoint`, `exec`, swap, TTY).
   */
  init?: MachineInit;
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
   * Minimum app-secrets version the Machine must see.
   */
  minSecretsVersion?: number;
}

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
    /** Parent Fly App name. */
    appName: string;
    /** Fly Machine id of replica 0. */
    machineId: string;
    /** Fly Machine ids of every replica. */
    machineIds: string[];
    /** Machine name of replica 0 (unique per App). */
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
    /**
     * Public `https://{appName}.fly.dev` URL when this Machine publishes
     * a proxy service. `undefined` when no services are configured.
     */
    url: string | undefined;
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
 * A Fly.Machine is a Firecracker VM running a container image.
 *
 * Prefer a {@link Service} when the program is Effect. A Service is
 * effectful, supports bindings, and scales with `count`. Alchemy builds
 * and pushes the image. Use `Fly.Machine` when you already have an image.
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
 * defaults to shared-cpu 1× / 256 MB. `image` updates in place.
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
 * 1 CPU, 256 MB. Guest updates in place.
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
 * `services` publishes ports on Fly's proxy. `{app}.fly.dev` over IPv4
 * still needs an {@link IpAssignment} on the parent App. `url` is
 * `https://{appName}.fly.dev` when a proxy service is configured.
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
 * ### Autostart and autostop
 * `autostart` starts the Machine when a request arrives. `autostop` is
 * `"off"`, `"stop"`, `"suspend"`, or a boolean. `minMachinesRunning`
 * keeps that many Machines up for the service.
 *
 * Autostop only stops Machines that already exist. It does not mint
 * new ones. Yield more Machine resources to size the pool.
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
 * Each Machine resource is one VM. Yield another Machine to add
 * capacity. Fly's proxy load-balances published `services` across
 * them.
 *
 * A {@link Service} still scales with `count`. That is one program,
 * many Machines.
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
 * the Machine is `started`.
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
 * `minSecretsVersion` waits until the Machine has seen at least that
 * App secrets version. Use it after rotating a {@link Secret} if the
 * process must start with the new value.
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
 * @resource
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

const toFlyService = (service: MachineService): FlyMachineService => ({
  protocol: service.protocol,
  internal_port: service.internalPort,
  autostart: service.autostart,
  autostop:
    typeof service.autostop === "boolean"
      ? service.autostop
        ? "stop"
        : "off"
      : service.autostop,
  min_machines_running: service.minMachinesRunning,
  ports: service.ports?.map((port) => ({
    port: port.port,
    handlers: port.handlers,
    force_https: port.forceHttps,
    start_port: port.startPort,
    end_port: port.endPort,
  })),
});

const desiredEnv = (
  props: MachineProps,
  bindingEnv: Record<string, any>,
): Record<string, string> => ({
  ...toEnv(props.env),
  ...toEnv(bindingEnv),
});

const desiredMetadata = (
  props: MachineProps,
  alchemy: Record<string, string>,
): Record<string, string> => ({
  ...(props.metadata ?? {}),
  ...alchemy,
});

const buildConfig = (input: {
  image: string;
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

const sameServices = (
  observed: FlyMachineService[] | undefined,
  desired: FlyMachineService[] | undefined,
) => deepEqual(observed ?? [], desired ?? [], { stripNullish: true });

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
      policy: observed?.policy,
      max_retries: observed?.max_retries,
    },
    {
      policy: desired?.policy,
      max_retries: desired?.max_retries,
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
    image: string;
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
    !sameImage(machine, desired.image) ||
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
  machineId: set.machineId,
  machineIds: set.machineIds,
  name: set.name,
  region: set.region,
  state: set.state,
  instanceId: set.instanceId,
  privateIp: set.privateIp,
  imageRef: set.imageRef,
  guest: set.guest,
  url: set.url,
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
    stables: ["machineId", "name", "region", "appName"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredAppName = appNameOf(news.app);
      const appChanged =
        desiredAppName !== undefined && desiredAppName !== output.appName;
      const desiredName =
        news.name !== undefined ? sanitizeFlyAppName(news.name) : output.name;
      const nameChanged = desiredName !== output.name;
      const desiredRegion = news.region ?? DEFAULT_REGION;
      const regionChanged = desiredRegion !== output.region;
      if (appChanged || nameChanged || regionChanged) {
        return {
          action: "replace" as const,
          // Name is unique per App — same name in a new region cannot coexist.
          deleteFirst: nameChanged === false && appChanged === false,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const appName = appNameOf(olds?.app) ?? output?.appName;
      const name = yield* resolveMachineName(id, olds?.name, output?.name);
      const found = yield* observeReplicaSet({
        appName,
        id,
        type: "Fly.Machine",
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

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const props = news;
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new MachineAppNotResolved({
          message: "Fly.Machine requires a resolved App with appName.",
        });
      }
      const name = yield* resolveMachineName(id, props.name, output?.name);
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

      const set = yield* reconcileReplicas({
        id,
        type: "Fly.Machine",
        appName,
        baseName: name,
        region,
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
            new MachineNotCreated({
              name: error.name,
              appName: error.appName,
            }),
          ),
        ),
      );
      return toAttrs(set);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteReplicaSet({
        appName: output.appName,
        machineIds: machineIdsOf(output),
        volumeIds: volumeIdsOf(output),
      });
    }),
  });
