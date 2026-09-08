import type {
  FlyMachineConfig,
  FlyMachineGuest,
  FlyMachineMount,
  FlyMachineService,
  FlyStatic,
  Machine as FlyMachine,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { DockerLive, Docker } from "../Docker/Docker.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { App } from "./App.ts";
import type {
  MachineGuest,
  MachineImageRef,
  MachineService,
} from "./Machine.ts";
import {
  createFlyResourceName,
  diffMachineMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { MountedDisk, ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";
import {
  collectBindingState,
  createFlyHostedSupport,
  createFlyHostRuntimeContext,
  defaultHttpServices,
  DEFAULT_PORT,
  toEnvRecord,
  type FlyBuildOptions,
  type FlyHostRuntimeContext,
  type HostedProgramProps,
} from "./hosted.ts";
import { attachBucketSecrets } from "./Bucket.ts";
import { attachPostgresSecrets } from "./Postgres.ts";
import { attachRedisSecrets } from "./Redis.ts";
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

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

const DEFAULT_REGION = "iad";
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 256;

export interface ServiceProps extends PlatformProps {
  /**
   * Parent Fly App. Accepts a `Fly.App` or an Effect that produces one
   * (module-scope `const Site = Fly.App("Site")` is valid). Changing the
   * App replaces the Service.
   */
  app: Ref<App>;
  /**
   * Module entrypoint bundled with rolldown and baked into a Docker
   * image pushed to `registry.fly.io`. Typically `import.meta.url`.
   * A content-hash change updates the Machine in place.
   */
  main: string;
  /**
   * Region to start the Machine in (`iad`, `ewr`, `ord`, …). Changing
   * it replaces the Service.
   *
   * @default "iad"
   */
  region?: string;
  /**
   * Number of Machines to keep running. Fly's proxy load-balances
   * `{app}.fly.dev` across them. Each replica gets its own Volume
   * from every `MountVolume` binding.
   *
   * @default 1
   */
  count?: number;
  /**
   * Guest size. Defaults to shared-cpu-1x 256 MB.
   */
  guest?: MachineGuest;
  /**
   * Port the hosted HTTP server listens on. Written to `PORT` and used
   * as the Fly proxy `internal_port`.
   *
   * @default 3000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the hosted process. Merged
   * after binding-injected `env`.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output`
   * overrides, pure-annotation options (`pure`), and `install` for
   * packages that must ship as real `node_modules` (see {@link FlyBuildOptions}).
   */
  build?: FlyBuildOptions;
  /**
   * Environment image used as the generated Dockerfile's `FROM`. Must
   * be able to run Node (websites and Effect-native Services use Node
   * in production).
   *
   * @default "node:26-slim"
   */
  image?: string;
  /**
   * Fly proxy services. Defaults to HTTP 80 + HTTPS 443 → {@link port}.
   */
  services?: MachineService[];
  /**
   * Machine name. Unique per App. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the Service.
   */
  name?: string;
  /**
   * Extra host directories copied into the Machine image next to the
   * bundled entry (e.g. a website `clientDirectory` at `/app/dist`).
   * Hashed into `code.hash` so asset changes update the image.
   * Destination is relative to `/app`.
   */
  extraFiles?: ReadonlyArray<{
    source: string;
    dest: string;
  }>;
  /**
   * Fly proxy static-file maps. Matching GET paths skip the process and
   * are served from the image (`guestPath`) or a Tigris bucket
   * (`tigrisBucket`). Website composites publish hashed client assets
   * this way.
   */
  statics?: ReadonlyArray<{
    /** Path inside the image, or key prefix in {@link tigrisBucket}. */
    guestPath: string;
    /** URL prefix, e.g. `"/"`. */
    urlPrefix: string;
    /** Tigris bucket name. When set, files come from the bucket. */
    tigrisBucket?: string;
    /** Directory index file (`index.html`) for Tigris statics. */
    indexDocument?: string;
  }>;
}

export type Service = Resource<
  "Fly.Service",
  ServiceProps,
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
    /**
     * Public `https://{appName}.fly.dev` URL when a proxy service is
     * configured.
     */
    url: string | undefined;
    /** Parsed image reference from Fly. */
    imageRef: MachineImageRef | undefined;
    /** Number of Machines in the replica set. */
    count: number;
    /** Disks mounted on replica 0. */
    mounts: MountedDisk[];
    /** Every replica in the set. */
    replicas: Replica[];
    /** Content hash of the bundled program's image. */
    code: {
      hash: string;
    };
  },
  ServiceBinding,
  Providers
>;

export const isService = (value: unknown): value is Service =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Fly.Service";

export type ServiceServices = ServerHost;

export type ServiceShape = Main<ServiceServices>;

export type ServiceRuntimeContext = FlyHostRuntimeContext;

/**
 * A Service is an Effect program running in a Fly.io Machine. Set
 * `count` to scale it up or down. Several Services share one {@link App}.
 *
 * @see https://fly.io/docs/machines/api/machines-resource/
 *
 * ### Declare a Service
 * A Service is a class. Props describe the Machine. The Effect is the
 * program that runs on it.
 *
 * `app` is the parent {@link App}. Pass the declaration directly,
 * yielded or module-scope. `main: import.meta.url` is the bundle
 * entrypoint. Alchemy bundles this file with Rolldown, builds a
 * Docker image (default `node:26-slim`), and pushes it to
 * `registry.fly.io/{app}:{id}-{hash}`.
 *
 * **Example:** Class + App + main
 * ```typescript
 * // src/api.ts
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 * import { Site } from "./app.ts";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `app` replaces the Service]
 * The new App gets a new replica set. The old Machines are deleted.
 * :::
 *
 * ### Serve HTTP with fetch
 * Return `fetch` from the init Effect to boot an HTTP server. Omit
 * `fetch` for a background service.
 *
 * **Example:** Hello
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Pin a region
 * Fly Machines live in a region. Default is `iad`. See
 * [Regions](/fly/compute/regions) for the list of codes.
 *
 * **Example:** Region
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `region` replaces the Service]
 * The replica set is created in the new region. The old Machines are
 * deleted.
 * :::
 *
 * ### Set the port
 * `port` is the port the process listens on inside the Machine.
 * Alchemy writes it to `PORT`. Default is `3000`.
 *
 * **Example:** Port 3000
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### The public URL
 * Yield the Service in the Stack. `api.url` is
 * `https://{appName}.fly.dev`. Alchemy does not create this hostname.
 * It is the parent {@link App}'s fly.dev name. The Service does not
 * get its own URL.
 *
 * **Example:** Stack output
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Fly.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url };
 *   }),
 * );
 * ```
 *
 * `url` is `undefined` when you pass `services: []` (nothing is
 * published).
 *
 * :::note[One fly.dev hostname per App]
 * Every published Service on the App shares `{appName}.fly.dev`. Put
 * one public Service on an App. Use `services: []` for workers.
 * :::
 *
 * ### Fly's proxy is the load balancer
 * There is no LoadBalancer resource. Fly runs an Anycast proxy at
 * the edge.
 *
 * **Example:** Published ports
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * Unless you override `services`, Alchemy publishes HTTP 80 and
 * HTTPS 443 on that proxy and points them at `port` inside each
 * Machine (`internal_port`). A request to
 * `https://{appName}.fly.dev` lands on Fly's edge. Fly terminates
 * TLS on 443, picks one started Machine that published this service,
 * and forwards to `port` where `fetch` runs.
 *
 * ### An address so it answers
 * `{app}.fly.dev` does not answer over IPv4 until the App has an
 * {@link IpAssignment}. Allocate a shared Anycast IPv4 on the same
 * App and yield it next to the Service.
 *
 * **Example:** shared_v4
 * ```typescript
 * export const PublicIp = Fly.IpAssignment("Shared", {
 *   app: Site,
 *   type: "shared_v4",
 * });
 * ```
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const api = yield* Api;
 *   const ip = yield* PublicIp;
 *   return { url: api.url, ip: ip.ip };
 * });
 * ```
 *
 * ### Scale with count
 * `count` is how many Machines to keep running. Default is `1`. They
 * all publish the same proxy service, so they all sit behind
 * `{app}.fly.dev`. Fly's proxy picks one Machine per request. Each
 * replica gets its own Volume from every {@link MountVolume} binding.
 *
 * **Example:** Three replicas
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
 * ### Config
 * Yield `Config` in init. Alchemy reads the value from the env of
 * whoever deploys and writes it onto the Machine. Do not pass
 * `env: { ... }` on a Service.
 *
 * `Config.redacted("API_KEY")` is `Redacted<string>`. Unwrap with
 * `Redacted.value` only where you need the raw string.
 *
 * Alchemy also injects `PORT` (when `port` is set) and stack metadata.
 * For a secret Fly should own and inject into every Machine on the
 * App, use {@link Secret}.
 *
 * **Example:** Config.redacted
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const token = Redacted.value(apiKey);
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Mount a disk
 * Bind {@link MountVolume} inside init. App and region come from the
 * Service. `count: 3` creates three Volumes, one per replica. Provide
 * {@link MountVolumeLive}.
 *
 * **Example:** Per-replica disk
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", count: 3, port: 3000 },
 *   Effect.gen(function* () {
 *     const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const text = yield* fs.readFileString(`${disk.path}/hello.txt`);
 *         return HttpServerResponse.text(text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### Guest size
 * `guest` is CPU kind, CPU count, and memory. Default is shared-cpu,
 * 1 CPU, 256 MB. Set `gpuKind` and `gpus` for a GPU. Guest updates in
 * place.
 *
 * **Example:** Bigger guest
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     app: Site,
 *     main: import.meta.url,
 *     region: "iad",
 *     port: 3000,
 *     guest: { cpuKind: "shared", cpus: 2, memoryMb: 512 },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### A stable name
 * Machine names are unique per App. Omit `name` and Alchemy generates
 * one from the stack, stage, and logical ID.
 *
 * **Example:** Explicit name
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, name: "api", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `name` replaces the Service]
 * Fly cannot rename a Machine. Alchemy creates the new name, then
 * deletes the old replica set.
 * :::
 *
 * ### Named export
 * `handler` is the named export to load from `main`. Default is
 * `"default"`.
 *
 * **Example:** Custom handler
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, handler: "api", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Base image
 * `image` is the generated Dockerfile's `FROM`. Default is
 * `node:26-slim`. A content-hash change of `main` updates the
 * Machine in place.
 *
 * **Example:** Override FROM
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     app: Site,
 *     main: import.meta.url,
 *     image: "node:26",
 *     port: 3000,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Custom proxy services
 * `services` defaults to HTTP 80 + HTTPS 443 toward `port`. Pass a
 * custom list to change handlers or autostop. Pass `[]` so Fly does
 * not publish a proxy.
 *
 * **Example:** Unpublished process
 * ```typescript
 * export default class Worker extends Fly.Service<Worker>()(
 *   "Worker",
 *   { app: Site, main: import.meta.url, region: "iad", services: [] },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 * ```
 *
 * ### Background services
 * Omit `port` and `fetch`. Pass `services: []`. Use `ServerHost.run`
 * for a long-running loop. If the process exits, Fly restarts it.
 *
 * **Example:** ServerHost.run
 * ```typescript
 * import { ServerHost } from "alchemy/Server";
 *
 * export default class Worker extends Fly.Service<Worker>()(
 *   "Worker",
 *   { app: Site, main: import.meta.url, region: "iad", services: [] },
 *   Effect.gen(function* () {
 *     const host = yield* ServerHost;
 *
 *     yield* host.run(
 *       Effect.gen(function* () {
 *         return yield* Effect.never;
 *       }).pipe(Effect.orDie),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * ### Bundle config
 * `build` is Rolldown `input` / `output` overrides plus
 * pure-annotation options. Use it when `main` needs extra entry
 * points or externals.
 *
 * **Example:** Externals
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     app: Site,
 *     main: import.meta.url,
 *     port: 3000,
 *     build: { input: { external: ["sharp"] } },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Install `pg` unbundled
 * `pg` is CommonJS. Rolldown's interop turns `Client` into a namespace.
 * Install it into the image so `@effect/sql-pg` / `Drizzle.Postgres` load
 * it with Node's CJS semantics — same `build.install` as Lambda.
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     app: Site,
 *     main: import.meta.url,
 *     port: 3000,
 *     build: { install: ["pg"] },
 *   },
 *   Effect.gen(function* () {
 *     const conn = yield* Fly.ConnectPostgres(Db);
 *     const db = yield* Drizzle.Postgres(conn.connectionString);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.execute("select 1 as ok");
 *         return HttpServerResponse.json({ rows });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
 * ) {}
 * ```
 *
 * ### Multiple Services, one App
 * Each Service has its own Machines, image, and lifecycle. Point
 * several at the same `app`.
 *
 * **Example:** API and worker
 * ```typescript
 * class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 *
 * class Worker extends Fly.Service<Worker>()(
 *   "Worker",
 *   { app: Site, main: import.meta.url, services: [] },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 * ```
 *
 * @resource
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Fly.Service", {
  createRuntimeContext: createFlyHostRuntimeContext("Fly.Service"),
  // `{ app: Site }` at module scope is an Effect. Yield it here so the
  // App is registered and `news.app` is resolved attributes at
  // reconcile (same DX as `yield* App(...)` inside Effect.gen).
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const app = Effect.isEffect(props.app)
        ? yield* props.app as Effect.Effect<App, never, Providers>
        : props.app;
      return { ...props, app };
    }),
});

export class ServiceNotCreated extends Data.TaggedError(
  "Fly.ServiceNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class ServiceAppNotResolved extends Data.TaggedError(
  "Fly.ServiceAppNotResolved",
)<{
  message: string;
}> {}

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
  props: ServiceProps,
  bindingEnv: Record<string, any>,
  alchemyEnv: Record<string, string>,
  port: number,
): Record<string, string> => ({
  ...toEnv(bindingEnv),
  ...alchemyEnv,
  PORT: String(port),
  ...toEnv(props.env),
});

const toFlyStatics = (
  statics:
    | ReadonlyArray<{
        guestPath: string;
        urlPrefix: string;
        tigrisBucket?: string;
        indexDocument?: string;
      }>
    | undefined,
): FlyStatic[] | undefined => {
  if (statics === undefined || statics.length === 0) return undefined;
  return statics.map((entry) => ({
    guest_path: entry.guestPath,
    url_prefix: entry.urlPrefix,
    ...(entry.tigrisBucket !== undefined
      ? { tigris_bucket: entry.tigrisBucket }
      : {}),
    ...(entry.indexDocument !== undefined
      ? { index_document: entry.indexDocument }
      : {}),
  }));
};

const buildConfig = (input: {
  image: string;
  guest: FlyMachineGuest;
  env: Record<string, string>;
  services: FlyMachineService[];
  mounts: FlyMachineMount[];
  metadata: Record<string, string>;
  statics?: FlyStatic[];
}): FlyMachineConfig => ({
  image: input.image,
  guest: input.guest,
  env: Object.keys(input.env).length > 0 ? input.env : undefined,
  services: input.services.length > 0 ? input.services : undefined,
  mounts: input.mounts.length > 0 ? input.mounts : undefined,
  metadata: input.metadata,
  statics:
    input.statics !== undefined && input.statics.length > 0
      ? input.statics
      : undefined,
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
  desired: FlyMachineService[],
) => deepEqual(observed ?? [], desired, { stripNullish: true });

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

const sameStatics = (
  observed: FlyStatic[] | undefined,
  desired: FlyStatic[] | undefined,
) => deepEqual(observed ?? [], desired ?? [], { stripNullish: true });

const configDrifted = (
  machine: FlyMachine,
  desired: {
    image: string;
    guest: FlyMachineGuest;
    env: Record<string, string>;
    services: FlyMachineService[];
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
    statics?: FlyStatic[];
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
    !sameStatics(config?.statics, desired.statics)
  );
};

const toAttrs = (set: ReplicaSet, codeHash: string): Service["Attributes"] => ({
  appName: set.appName,
  machineId: set.machineId,
  machineIds: set.machineIds,
  name: set.name,
  region: set.region,
  state: set.state,
  url: set.url,
  imageRef: set.imageRef,
  count: set.count,
  mounts: set.mounts,
  replicas: set.replicas,
  code: { hash: codeHash },
});

const machineIdsOf = (output: Service["Attributes"] | undefined) =>
  output?.machineIds ??
  (output?.machineId !== undefined && output.machineId.length > 0
    ? [output.machineId]
    : []);

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createFlyHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
        docker,
        dotAlchemy,
      });

      return Service.Provider.of({
        stables: ["machineId", "name", "region", "appName"],
        nuke: { dependsOn: ["Fly.App"] },

        diff: Effect.fn(function* ({ id, news, output }) {
          if (news === undefined || output === undefined) return undefined;
          if (isResolved(news)) {
            const desiredAppName = appNameOf(news.app);
            const appChanged =
              desiredAppName !== undefined && desiredAppName !== output.appName;
            const desiredName =
              news.name !== undefined
                ? sanitizeFlyAppName(news.name)
                : output.name;
            const nameChanged = desiredName !== output.name;
            const desiredRegion = news.region ?? DEFAULT_REGION;
            const regionChanged = desiredRegion !== output.region;
            if (appChanged || nameChanged || regionChanged) {
              return {
                action: "replace" as const,
                deleteFirst: nameChanged === false && appChanged === false,
              };
            }
          }
          // The code hash depends only on statically-known props (`main`,
          // `build`, `image`, `port`, `extraFiles`, `isExternal`). Never
          // gate it on the WHOLE props being resolved: `app` is a resource
          // reference that stays unresolved at diff time, so a whole-props
          // guard makes code-only changes silently noop. By diff time the
          // effect-config form has been evaluated, so the object view is
          // safe to read.
          const statics = news as Partial<
            Pick<
              ServiceProps,
              "main" | "build" | "image" | "port" | "extraFiles" | "isExternal"
            >
          >;
          if (
            isResolved({
              main: statics.main,
              build: statics.build,
              image: statics.image,
              port: statics.port,
              extraFiles: statics.extraFiles,
              isExternal: statics.isExternal,
            }) &&
            statics.main !== undefined
          ) {
            const hash = yield* hosted.hash(statics as HostedProgramProps);
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const appName = appNameOf(olds?.app) ?? output?.appName;
          const name = yield* resolveMachineName(id, olds?.name, output?.name);
          const found = yield* observeReplicaSet({
            appName,
            id,
            type: "Fly.Service",
            machineIds: machineIdsOf(output),
            baseName: name,
          });
          if (found === undefined) return undefined;
          return toAttrs(found, output?.code.hash ?? "");
        }),

        list: Effect.fn(function* () {
          const sets = yield* listReplicaSets("Fly.Service");
          return sets.map((set) => toAttrs(set, ""));
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const appName = appNameOf(props.app) ?? output?.appName;
          if (appName === undefined) {
            return yield* new ServiceAppNotResolved({
              message: "Fly.Service requires a resolved App with appName.",
            });
          }
          const name = yield* resolveMachineName(id, props.name, output?.name);
          const region = props.region ?? output?.region ?? DEFAULT_REGION;
          const count = resolveCount(props.count);
          const port = props.port ?? DEFAULT_PORT;
          const bound = collectBindingState(bindings ?? []);
          yield* attachRedisSecrets(appName, bound.redis);
          yield* attachBucketSecrets(appName, bound.buckets, {
            ...bound.env,
            ...toEnv(props.env),
          });
          let minSecretsVersion: number | undefined;
          for (const pg of bound.postgres) {
            const version = yield* attachPostgresSecrets(
              appName,
              pg.clusterId,
              pg.variableName,
            );
            if (version !== undefined) {
              minSecretsVersion = Math.max(minSecretsVersion ?? 0, version);
            }
          }
          const env = desiredEnv(props, bound.env, hosted.alchemyEnv, port);
          const guest = toFlyGuest(props.guest);
          const services =
            props.services !== undefined
              ? props.services.map(toFlyService)
              : defaultHttpServices(port, count);
          const statics = toFlyStatics(props.statics);

          const { imageRef, codeHash } = yield* hosted.resolveImage({
            id,
            appName,
            props,
            previousHash: output?.code.hash,
            session,
          });

          const set = yield* reconcileReplicas({
            id,
            type: "Fly.Service",
            appName,
            baseName: name,
            region,
            count,
            disks: bound.mounts,
            minSecretsVersion,
            outputMachineIds: machineIdsOf(output),
            preferVolumeIds: (output?.replicas ?? []).map((replica) =>
              replica.mounts.map((mount) => mount.volumeId),
            ),
            configDrifted: (machine, desired) =>
              configDrifted(machine, {
                image: imageRef,
                guest,
                env,
                services,
                mounts: desired.mounts,
                metadata: desired.metadata,
                statics,
              }),
            buildConfig: ({ mounts, metadata }) =>
              buildConfig({
                image: imageRef,
                guest,
                env,
                services,
                mounts,
                metadata,
                statics,
              }),
          }).pipe(
            Effect.catchTag("Fly.ReplicaNotCreated", (error) =>
              Effect.fail(
                new ServiceNotCreated({
                  name: error.name,
                  appName: error.appName,
                }),
              ),
            ),
          );
          return toAttrs(set, codeHash);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteReplicaSet({
            appName: output.appName,
            machineIds: machineIdsOf(output),
            volumeIds: volumeIdsOf(output),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(DockerLive));
