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
import {
  Platform,
  type Main,
  type MainRpc,
  type PlatformProps,
} from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Input } from "../Input.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { App, deleteApp, ensureApp } from "./App.ts";
import {
  deploymentPolicy,
  validateDeployment,
  type MachineDeploy,
  type MachineShutdown,
  type MachineCheck,
} from "./Deployment.ts";
import type {
  MachineGuest,
  MachineImageRef,
  MachineService,
} from "./Machine.ts";
import {
  ensureFlycastAddress,
  hasPublicAddress,
  syncOwnedAppAddresses,
} from "./IpAssignment.ts";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Redacted from "effect/Redacted";
import { makeRandom } from "../Random.ts";
import { resolveOrgSlug } from "./Environment.ts";
import { bindingPortOf, findPortConflict, portsOfFly } from "./ports.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { boundTargetEnvKeys } from "./BindService.ts";
import {
  BINDING_PORT_ENV,
  DEFAULT_BINDING_PORT,
  RPC_ORG_ENV,
  RPC_TOKEN_ENV,
} from "./rpc.ts";
import { type Region, regionList } from "./Region.ts";
import {
  alchemyMetadataKeys,
  createFlyAppName,
  createFlyResourceName,
  diffMachineMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type {
  BoundTarget,
  MountedDisk,
  ServiceBinding,
} from "./MountVolume.ts";
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
  hasPublishedService,
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
  /** Deployment strategy and readiness deadline. Defaults to in-place rolling updates. */
  deploy?: MachineDeploy;
  /** Graceful process shutdown. Defaults to SIGTERM / 30 seconds when blue/green is enabled. */
  shutdown?: MachineShutdown;
  /** Named readiness checks for workers without public services. */
  checks?: Record<string, MachineCheck>;
  /**
   * Run inside an existing {@link App} instead of the Service's own App.
   * The Service then shares that App's hostname, addresses, and secrets,
   * and Alchemy does not manage addresses for it. Accepts a `Fly.App` or
   * an Effect that produces one. Changing it, or adding or removing it,
   * replaces the Service.
   *
   * By default each Service owns its App, so it gets its own
   * `{name}.fly.dev` hostname, addresses, logs, and metrics.
   */
  app?: Ref<App>;
  /**
   * Whether the Service is reachable from the internet. A public Service
   * gets a shared IPv4 and an IPv6 and serves `https://{name}.fly.dev`. A
   * private Service is reachable only from other Apps in the organization,
   * at `http://{name}.flycast`. Every address is free. Only applies when
   * the Service owns its App (no `app`).
   *
   * @default true
   */
  public?: boolean;
  /**
   * Private network the Service's App joins. Only Apps on the same
   * network can reach it, over `privateUrl` or `.internal`; every other
   * App in the organization, including those on the default network,
   * cannot resolve it. Services on one network reach each other freely.
   * Use {@link stackNetwork} for a network unique to the stack and stage.
   * Fly creates the network with the first App that names it. Changing
   * it replaces the Service. Only applies when the Service owns its App
   * (no `app`).
   *
   * @default the organization's default network, shared by every App
   */
  network?: string;
  /**
   * Plain-HTTP port Alchemy publishes for callers that bind this Service
   * with {@link bindService}, when the Service publishes no plain-HTTP port
   * of its own (a public Service's defaults are an HTTPS redirect on 80 and
   * HTTPS on 443). Fly issues no certificate for `.flycast`, so bound
   * callers use plain HTTP inside Fly's WireGuard-encrypted private network.
   * Requests on this port must come from Fly's private network. Change it
   * when the port collides with another Service in the same App.
   *
   * @default 7780
   */
  bindingPort?: number;
  /**
   * Caller token for bound callers. Set automatically from an
   * `Alchemy.Random` child resource; do not pass it.
   * @internal
   */
  rpcToken?: Redacted.Redacted<string>;
  /**
   * Module entrypoint bundled with rolldown and baked into a Docker
   * image pushed to `registry.fly.io`. Typically `import.meta.url`.
   * A content-hash change updates the workload using the selected deployment strategy.
   */
  main: string;
  /**
   * Region or regions to run in (`"iad"`, `["iad", "lhr"]`). The
   * Service runs `count` Machines in each region behind one hostname;
   * Fly's proxy sends each request to the nearest healthy Machine.
   * Adding or removing a region updates the Service in place: Machines
   * in a removed region are deleted, new regions get new Machines.
   *
   * @default "iad"
   */
  region?: Region | Region[];
  /**
   * Number of Machines to provision in each region, including
   * stopped/suspended idle capacity. Fly's proxy load-balances
   * `{app}.fly.dev` across available replicas.
   * Blue/green checks a representative and the required running floor while
   * preserving idle nonrepresentatives. Each replica gets its own Volume
   * from every `MountVolume` binding; attached volumes require rolling updates.
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
   * Name of the Service's App, which is its `{name}.fly.dev` and
   * `{name}.flycast` hostname. Globally unique across Fly. If omitted, a
   * unique name is generated from the stack, stage and logical ID.
   * Changing it replaces the Service.
   *
   * When `app` is set, this is instead the Machine name (unique per App;
   * in blue/green mode a base for generation-qualified physical names).
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

/** A port the Service publishes on Fly's proxy. */
export interface ServiceEndpoint {
  /**
   * Hostname the port is published on: `{appName}.fly.dev`, or
   * `{appName}.flycast` for a private Service.
   */
  host: string;
  /** Port on Fly's proxy. */
  port: number;
  /** Port the process listens on inside the Machine. */
  internalPort: number | undefined;
  /** `tcp` or `udp`. */
  protocol: string;
  /** Fly proxy handlers (`tls`, `http`, `pg_tls`, …). Empty for raw TCP or UDP. */
  handlers: string[];
  /**
   * URL when the port speaks HTTP: `https://` for `tls` + `http`, `http://`
   * for plain `http`, with `:{port}` unless it is 443 or 80. `undefined`
   * for other protocols, and for TLS ports on `.flycast` (Fly issues no
   * certificate there).
   */
  url: string | undefined;
}

export type Service = Resource<
  "Fly.Service",
  ServiceProps,
  {
    /** Whether recovery must finish an interrupted deployment. */
    rolloutPending?: boolean;
    /** Fly App name the Machines run in. */
    appName: string;
    /** Whether the Service created and manages {@link appName}. */
    ownsApp?: boolean;
    /**
     * Private network the Service's Machines are on: `network`, or the
     * shared App's network. `undefined` for the organization's default.
     */
    network?: string;
    /** Token bound callers send with RPC calls. */
    rpcToken?: Redacted.Redacted<string>;
    /** Fly Machine id of replica 0. */
    machineId: string;
    /** Fly Machine ids of every replica. */
    machineIds: string[];
    /** Logical base for generation-qualified Machine names. */
    baseName?: string;
    /** Machine name of replica 0 (unique per App). Changes during blue/green deployment. */
    name: string;
    /** Region of the first Machine. */
    region: string;
    /** Every region the Service's Machines run in. */
    regions: string[];
    /** Observed state of replica 0 (`created`, `started`, `stopped`, …). */
    state: string;
    /**
     * Main public HTTP endpoint: the first published `tls` + `http` port
     * as `https://{appName}.fly.dev[:port]`, else the first plain `http`
     * port as `http://{appName}.fly.dev[:port]`. `https://{appName}.fly.dev`
     * for the default services. `undefined` for a private Service or when
     * no port speaks HTTP. When `app` is set, the App's addresses are
     * managed elsewhere, so this is where the Service answers once the App
     * is reachable. See {@link endpoints} for every published port.
     */
    url: string | undefined;
    /**
     * Every port the Service publishes, in declaration order. Ports that
     * only redirect HTTP to HTTPS (`forceHttps`) and port ranges are
     * omitted. Empty when nothing is published.
     */
    endpoints: ServiceEndpoint[];
    /**
     * Address bound callers use over Fly's private network:
     * `http://{appName}.flycast`, with the port when it is not 80. It is
     * the Service's first plain-HTTP port, or {@link ServiceProps.bindingPort}
     * when it has none. Reachable only from Apps on the Service's network.
     * `undefined` when nothing is published.
     */
    privateUrl: string | undefined;
    /** Parsed image reference from Fly. */
    imageRef: MachineImageRef | undefined;
    /** Number of Machines in each region. */
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

/**
 * What a Service's program returns: `fetch` for HTTP, `run` for a
 * background loop, and any other methods, which bound callers invoke
 * with {@link bindService}.
 */
export type ServiceShape =
  | Main<ServiceServices>
  | (Exclude<Main<ServiceServices>, void> & MainRpc<ServiceServices>);

export type ServiceRuntimeContext = FlyHostRuntimeContext;

/**
 * A Service is an Effect program running on Fly.io Machines in its own
 * Fly App. It gets its own `{name}.fly.dev` hostname, addresses, logs,
 * and metrics, the way each Cloudflare Worker is its own endpoint. Set
 * `count` to scale it up or down.
 *
 * @see https://fly.io/docs/machines/api/machines-resource/
 *
 * ### Declare a Service
 * A Service is a class. Props describe the Machine. The Effect is the
 * program that runs on it.
 *
 * The Service creates its Fly App, and deleting the Service deletes it.
 * `main: import.meta.url` is the bundle entrypoint. Alchemy bundles this
 * file with Rolldown, builds a Docker image (default `node:26-slim`), and
 * pushes it to `registry.fly.io/{app}:{id}-{hash}`.
 *
 * **Example:** Class + main
 * ```typescript
 * // src/api.ts
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 * ```
 *
 * ### Serve HTTP with fetch
 * Return `fetch` from the init Effect to boot an HTTP server. Omit
 * `fetch` for a background service.
 *
 * **Example:** Hello
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url },
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
 *   { main: import.meta.url, region: "iad" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Run in several regions
 * Pass a list to run the same program in several regions behind one
 * hostname. `count` Machines run in each region, and Fly's proxy sends
 * each request to the nearest healthy one. `regions` on the Service
 * lists where it runs.
 *
 * **Example:** Two regions, two Machines each
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, region: ["iad", "lhr"], count: 2 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * Adding or removing a region updates the Service in place and keeps
 * its App and hostname. Machines already in a kept region stay; a
 * removed region's Machines are deleted. Each Machine's Volume from
 * `MountVolume` is created in that Machine's region.
 *
 * ### Set the port
 * `port` is the port the process listens on inside the Machine.
 * Alchemy writes it to `PORT`. Default is `3000`.
 *
 * **Example:** Port 3000
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, region: "iad", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### The public URL
 * A Service is public by default. Alchemy allocates a shared IPv4 and
 * an IPv6 on its App (both free) and `api.url` is
 * `https://{appName}.fly.dev`.
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
 * ### Every published port
 * `url` is one endpoint. A Service that publishes several ports has one
 * endpoint per port at the same hostname, listed in `endpoints` with
 * its port, handlers, and a URL when the port speaks HTTP. Ports that
 * only redirect to HTTPS are left out.
 *
 * **Example:** An admin UI on 8443 and raw TCP on 7000
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     services: [
 *       {
 *         internalPort: 3000,
 *         ports: [
 *           { port: 80, handlers: ["http"], forceHttps: true },
 *           { port: 443, handlers: ["tls", "http"] },
 *         ],
 *       },
 *       { internalPort: 9000, ports: [{ port: 8443, handlers: ["tls", "http"] }] },
 *       { internalPort: 7000, ports: [{ port: 7000 }] },
 *     ],
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 *
 * api.url; // "https://{appName}.fly.dev"
 * api.endpoints.map((endpoint) => endpoint.url);
 * // ["https://{appName}.fly.dev", "https://{appName}.fly.dev:8443", undefined]
 * ```
 *
 * :::note[Plain HTTP on other ports needs IPv6]
 * The free shared IPv4 serves TLS on any port but plain HTTP only on
 * port 80. A plain-HTTP port such as 8080 answers over IPv6 only.
 * :::
 *
 * ### Private Services
 * `public: false` keeps a Service off the internet. It gets only a
 * Flycast address and publishes plain HTTP on port 80 (Fly issues no
 * certificate for `.flycast`). `url` is `undefined`, and `privateUrl` is
 * `http://{appName}.flycast`. Calls go through Fly's proxy, so service
 * checks, `autostart`, and blue/green cutover still apply.
 *
 * Turning `public` on or off updates the Service in place. Its App and
 * hostname stay the same.
 *
 * ### Call another Service
 * A Service can return methods next to `fetch`. Another Service calls
 * them by binding it with {@link bindService}, which returns a typed
 * client. Binding makes the caller deploy after the Service, and only
 * callers that bind a Service receive its caller token, so only they
 * can call its methods.
 *
 * **Example:** A private Service with methods
 * ```typescript
 * export default class Users extends Fly.Service<Users>()(
 *   "Users",
 *   { main: import.meta.url, public: false },
 *   Effect.gen(function* () {
 *     return {
 *       list: () => Effect.succeed(USERS),
 *       get: (id: string) =>
 *         Effect.succeed(USERS.find((user) => user.id === id)),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Bind it from another Service
 * ```typescript
 * export default class Gateway extends Fly.Service<Gateway>()(
 *   "Gateway",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const users = yield* Fly.bindService(Users);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* users.list());
 *       }).pipe(Effect.orDie),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * Calls use plain HTTP to `privateUrl` inside Fly's WireGuard-encrypted
 * private network. The Service accepts a method call only with its
 * caller token and a `Fly-Src` signature from Fly's proxy for the same
 * organization, so the public internet can never call it. A public
 * Service publishes an extra plain-HTTP port for bound callers,
 * `bindingPort` (default 7780), since its own ports are an HTTPS
 * redirect and HTTPS. `client.fetch` sends a request to the Service's
 * `fetch` routes, and {@link bindEndpoint} targets one published port.
 * Two Services can bind each other; declare them as tag classes and
 * provide their `.make` layers (see the
 * [Connect Services guide](/fly/compute/connecting-services)).
 *
 * ### Isolate Services on a private network
 * Fly's default private network spans the whole organization, so any
 * App in it can reach a private Service's address. Put a stack's
 * Services on their own network with `network`. {@link stackNetwork}
 * names one per stack and stage. Apps on other networks, including the
 * default one, cannot resolve them, and binding a Service on another
 * network fails the caller's deploy with `Fly.ServiceUnreachable`
 * before anything is created. A public Service on the network still
 * serves `url`, which makes it the stack's single entry point.
 *
 * **Example:** Private backend behind a public gateway
 * ```typescript
 * export class Users extends Fly.Service<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     return {
 *       main: import.meta.url,
 *       public: false,
 *       network: yield* Fly.stackNetwork,
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     return { list: () => Effect.succeed(USERS) };
 *   }),
 * ) {}
 *
 * export class Gateway extends Fly.Service<Gateway>()(
 *   "Gateway",
 *   Effect.gen(function* () {
 *     return { main: import.meta.url, network: yield* Fly.stackNetwork };
 *   }),
 *   Effect.gen(function* () {
 *     const users = yield* Fly.bindService(Users);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* users.list());
 *       }).pipe(Effect.orDie),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `network` replaces the Service]
 * Fly cannot move an App between networks. Alchemy creates the Service
 * on the new network, then deletes the old App.
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
 *   { main: import.meta.url, region: "iad", port: 3000 },
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
 * ### Configure routing health checks
 * The generated service includes a TCP check on `port`. To customize
 * it, provide `services` and configure each service's `checks` property.
 * With rolling updates, reconcile waits for each started replica's checks
 * before updating the next replica. Missing or non-passing results are
 * polled within `deploy.healthTimeout` (60 seconds by default), then fail
 * deployment with `Fly.ReplicaChecksNotPassing`. Later replicas remain
 * unchanged; earlier updates are not rolled back. A single rolling replica
 * can be unavailable. Blue/green checks replacements before retiring the
 * old set, with representative/floor readiness for idle capacity.
 *
 * **Example:** HTTP readiness check
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     port: 3000,
 *     services: [
 *       {
 *         protocol: "tcp",
 *         internalPort: 3000,
 *         ports: [
 *           { port: 80, handlers: ["http"], forceHttps: true },
 *           { port: 443, handlers: ["tls", "http"] },
 *         ],
 *         checks: [
 *           {
 *             type: "http",
 *             port: 3000,
 *             method: "GET",
 *             path: "/health",
 *             protocol: "http",
 *             interval: "15s",
 *             timeout: "2s",
 *             gracePeriod: "30s",
 *           },
 *         ],
 *       },
 *     ],
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Scale with count
 * `count` is how many Machines to provision, including idle capacity.
 * Default is `1`. Replicas publish the same proxy service behind
 * `{appName}.fly.dev`; Fly's proxy picks an available Machine per request.
 * Each replica gets its own Volume from every {@link MountVolume} binding;
 * attached volumes require rolling updates.
 *
 * **Example:** Three replicas
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, region: "iad", count: 3, port: 3000 },
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
 * whoever deploys and writes it onto the Machine, so there is no need
 * to copy it into `env`.
 *
 * `Config.Redacted("API_KEY")` is `Redacted<string>`. Unwrap with
 * `Redacted.value` only where you need the raw string.
 *
 * Alchemy also injects `PORT` (when `port` is set) and stack metadata.
 * For a secret Fly should own and inject into every Machine on an App,
 * run the Service in an {@link App} (`app`) and use {@link Secret}.
 *
 * **Example:** Config.Redacted
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.Redacted("API_KEY");
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
 *   { main: import.meta.url, region: "iad", count: 3, port: 3000 },
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
 * ### A stable hostname
 * `name` names the Service's App, so it is the `{name}.fly.dev`
 * hostname. App names are globally unique across Fly. Omit `name` and
 * Alchemy generates one from the stack, stage, and logical ID.
 *
 * **Example:** Explicit name
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, name: "api", port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `name` replaces the Service]
 * Fly cannot rename an App. Alchemy creates the Service under the new
 * name, then deletes the old App.
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
 *   { main: import.meta.url, handler: "api", port: 3000 },
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
 * `services` defaults to HTTP 80 (redirecting to HTTPS) + HTTPS 443
 * toward `port`, or plain HTTP 80 for a private Service. Pass a custom
 * list to change handlers or autostop. Pass `[]` so Fly does not
 * publish a proxy.
 *
 * **Example:** Unpublished process
 * ```typescript
 * export default class Worker extends Fly.Service<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, region: "iad", services: [] },
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
 *   { main: import.meta.url, region: "iad", services: [] },
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
 * ### Group Services in one App
 * Pass `app` to run a Service inside an existing {@link App} instead of
 * its own. The Services share the App's hostname, addresses, and
 * {@link Secret}s, and a {@link Certificate} on the App covers them.
 * Alchemy manages no addresses for a Service in a shared App: allocate
 * an {@link IpAssignment} on the App. `url` and `endpoints` follow the
 * Service's own ports, so Services in one App tell themselves apart by
 * port (`https://{appName}.fly.dev` and `https://{appName}.fly.dev:8443`).
 * `public` does not apply.
 *
 * **Example:** API and worker sharing a secret
 * ```typescript
 * export const Site = Fly.App("Site");
 *
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
 * Fly's proxy routes an App's traffic by port only, so each Service in
 * the App needs its own ports, including its own `bindingPort` when
 * Alchemy adds one. Two Services on the same port and protocol fail with
 * `Fly.ServicePortConflict` before any Machine is created: at plan time
 * when the App already exists, otherwise when the App deploys. Grouped
 * Services can be bound like any other; they cannot bind each other in
 * a cycle.
 *
 * ### Blue/green deployments
 * Opt into healthy replacement Machines instead of in-place updates.
 * The default TCP service check proves the server is listening; supply
 * service HTTP checks when readiness also depends on application state.
 *
 * **Example:** Single-replica HTTP replacement
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     deploy: { strategy: "bluegreen" },
 *     shutdown: { timeout: "30 seconds" },
 *   },
 *   Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ready")) }),
 * ) {}
 * ```
 *
 * Keep one Service declaration. The old process retains its own shutdown
 * signal and deadline when the replacement's policy changes. Managed
 * SIGTERM/SIGINT shutdown drains HTTP while runtime resource finalizers run;
 * shared dependencies remain alive until both settle or the deadline expires.
 * Applications own stop-acquisition barriers, separately scoped jobs, and
 * bounded drain or checkpoint logic using ordinary finalizers, not a new
 * shutdown hook. External servers own their signal handling. An old bootstrap
 * cannot gain handlers retroactively. Volumes are incompatible with blue/green;
 * physical IDs and names change. Service-bound secret versions are floors,
 * not vault snapshots, and native Machine leases are not deployment-wide locks.
 * Leases do not serialize vault writers or every simultaneous first deployment;
 * serialize CI invocations for the same resource.
 *
 * Stop and suspend autostop policies preserve idle nonrepresentatives while
 * a representative and the required running floor pass readiness. Requested
 * idle policy is restored before old retirement; a new instance needs fresh
 * checks. Suspension is not SIGTERM shutdown and does not run ordinary
 * shutdown finalizers. Replacements do not inherit suspended process memory.
 * See the [deployment guide](/fly/compute/deployments) for recovery,
 * idle capacity, application responsibilities, and verification limits.
 *
 * @resource
 * @product Service
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
  transformProps: (id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const app = Effect.isEffect(props.app)
        ? yield* props.app as Effect.Effect<App, never, Providers>
        : props.app;
      // Only callers that bind this Service receive the token.
      const rpcToken = yield* makeRandom(`${id}RpcToken`);
      if (app !== undefined) {
        // Report the ports this Service publishes so the App can reject
        // two Services on the same port before either one is deployed.
        yield* app.bind(id, {
          service: id,
          services: props.services,
          bindingPort: props.bindingPort,
        });
      }
      return { ...props, app, rpcToken } as typeof props;
    }),
});

export class ServiceNotCreated extends Data.TaggedError(
  "Fly.ServiceNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class InvalidServiceProps extends Data.TaggedError(
  "Fly.InvalidServiceProps",
)<{
  message: string;
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
) => {
  const normalize = (statics: FlyStatic[] | undefined) =>
    (statics ?? []).map((entry) => ({
      ...entry,
      // Empty and omitted index documents both disable directory indexes.
      index_document:
        entry.index_document === "" ? undefined : entry.index_document,
    }));
  return deepEqual(normalize(observed), normalize(desired), {
    stripNullish: true,
  });
};

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

const portsOf = (services: FlyMachineService[] | undefined) =>
  (services ?? []).flatMap((service) => service.ports ?? []);

const withPort = (base: string, port: number, standard: number) =>
  port === standard ? base : `${base}:${port}`;

const isRedirect = (handlers: string[], forceHttps: boolean | undefined) =>
  forceHttps === true && handlers.includes("http") && !handlers.includes("tls");

/** Every published port on `host`, excluding HTTPS redirects and ranges. */
const endpointListOf = (
  host: string,
  services: FlyMachineService[] | undefined,
): ServiceEndpoint[] => {
  const flycast = host.endsWith(".flycast");
  return (services ?? []).flatMap((service) =>
    (service.ports ?? []).flatMap((entry) => {
      const handlers = entry.handlers ?? [];
      if (entry.port === undefined || isRedirect(handlers, entry.force_https))
        return [];
      const http = handlers.includes("http");
      const tls = handlers.includes("tls");
      const url = !http
        ? undefined
        : tls
          ? flycast
            ? undefined
            : withPort(`https://${host}`, entry.port, 443)
          : withPort(`http://${host}`, entry.port, 80);
      return [
        {
          host,
          port: entry.port,
          internalPort: service.internal_port,
          protocol: service.protocol ?? "tcp",
          handlers,
          url,
        },
      ];
    }),
  );
};

/** HTTPS on the first TLS port, else HTTP on the first plain HTTP port. */
const mainUrlOf = (endpoints: ServiceEndpoint[]) =>
  endpoints.find((endpoint) => endpoint.url?.startsWith("https://"))?.url ??
  endpoints.find((endpoint) => endpoint.url !== undefined)?.url;

/** `public` and `network` configure the Service's own App. */
const validateOwnership = (
  props: Partial<Pick<ServiceProps, "app" | "public" | "network">>,
) => {
  if (props.app === undefined) return Effect.void;
  const conflicting = (["public", "network"] as const).filter(
    (key) => props[key] !== undefined,
  );
  return conflicting.length === 0
    ? Effect.void
    : Effect.fail(
        new InvalidServiceProps({
          message: `Fly.Service ${conflicting.map((key) => `\`${key}\``).join(" and ")} only apply when the Service owns its App; remove \`app\` or ${conflicting.map((key) => `\`${key}\``).join(" and ")}.`,
        }),
      );
};

/**
 * A private network name unique to the current stack and stage, for the
 * Service `network` prop. Services in one stage reach each other; other
 * stages and every other App in the organization cannot.
 */
export const stackNetwork = Effect.gen(function* () {
  const stack = yield* Stack;
  const name = `${stack.name}-${stack.stage}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
  return /^[a-z]/.test(name) ? name : `n-${name}`.slice(0, 63);
});

interface Access {
  ownsApp: boolean;
  isPublic: boolean;
  network: string | undefined;
  bindingPort: number;
  rpcToken: Redacted.Redacted<string> | undefined;
}

/** Drop the port Alchemy added for bindings from a services list. */
const withoutBindingPort = (
  services: FlyMachineService[] | undefined,
  bindingPort: number,
) =>
  (services ?? []).flatMap((service) => {
    const ports = (service.ports ?? []).filter(
      (entry) =>
        !(
          entry.port === bindingPort &&
          (entry.handlers ?? []).includes("http") &&
          !(entry.handlers ?? []).includes("tls")
        ),
    );
    return ports.length === 0 ? [] : [{ ...service, ports }];
  });

const endpointsOf = (set: ReplicaSet, access: Access) => {
  if (!hasPublishedService(set.services))
    return { url: undefined, privateUrl: undefined, endpoints: [] };
  const isPublic = !access.ownsApp || access.isPublic;
  const binding = bindingPortOf(portsOfFly(set.services), access.bindingPort);
  const visible = binding?.added
    ? withoutBindingPort(set.services, binding.port)
    : set.services;
  const endpoints = endpointListOf(
    `${set.appName}.${isPublic ? "fly.dev" : "flycast"}`,
    visible,
  );
  return {
    url: isPublic ? mainUrlOf(endpoints) : undefined,
    privateUrl:
      binding === undefined
        ? undefined
        : withPort(`http://${set.appName}.flycast`, binding.port, 80),
    endpoints,
  };
};

/**
 * The Service's Fly services plus the plain-HTTP port for bound callers,
 * when none of its published ports serves plain HTTP.
 */
const withBindingService = (
  services: FlyMachineService[],
  internalPort: number,
  bindingPort: number,
): { services: FlyMachineService[]; added: boolean } => {
  const binding = bindingPortOf(portsOfFly(services), bindingPort);
  if (binding?.added !== true) return { services, added: false };
  if (portsOfFly(services).some((entry) => entry.start === bindingPort))
    return { services, added: true };
  // Add the port to the first TCP service so it shares that service's
  // internal port and health checks (blue/green requires checks on every
  // published service).
  const index = services.findIndex(
    (service) => (service.protocol ?? "tcp") === "tcp",
  );
  if (index === -1) {
    return {
      added: true,
      services: [
        ...services,
        {
          protocol: "tcp",
          internal_port: internalPort,
          ports: [{ port: bindingPort, handlers: ["http"] }],
        },
      ],
    };
  }
  return {
    added: true,
    services: services.map((service, i) =>
      i === index
        ? {
            ...service,
            ports: [
              ...(service.ports ?? []),
              { port: bindingPort, handlers: ["http"] },
            ],
          }
        : service,
    ),
  };
};

/** Fly reports the organization's default network as `default`. */
const normalizeNetwork = (network: string | undefined | null) =>
  network === undefined ||
  network === null ||
  network === "" ||
  network === "default"
    ? undefined
    : network;

export class ServiceUnreachable extends Data.TaggedError(
  "Fly.ServiceUnreachable",
)<{
  service: string;
  target: string;
  network: string | undefined;
  targetNetwork: string | undefined;
}> {
  get message() {
    return `Fly Service ${this.service} binds ${this.target}, but ${this.service} is on the ${this.network ?? "default"} network and ${this.target} is on the ${this.targetNetwork ?? "default"} network. Put both on the same \`network\`.`;
  }
}

export class ServiceNotBindable extends Data.TaggedError(
  "Fly.ServiceNotBindable",
)<{
  service: string;
  target: string;
}> {
  get message() {
    return `Fly Service ${this.service} binds ${this.target}, which publishes no ports (\`services: []\`), so it has no private address.`;
  }
}

export class EndpointNotPublished extends Data.TaggedError(
  "Fly.EndpointNotPublished",
)<{
  service: string;
  target: string;
  port: number;
}> {
  get message() {
    return `Fly Service ${this.service} binds port ${this.port} of ${this.target}, which does not publish it.`;
  }
}

/** Check every Service this one binds is reachable from its network. */
const validateTargets = (
  service: string,
  network: string | undefined,
  targets: readonly BoundTarget[],
) =>
  Effect.gen(function* () {
    for (const target of targets) {
      const targetNetwork = normalizeNetwork(target.network);
      if (targetNetwork !== normalizeNetwork(network)) {
        return yield* new ServiceUnreachable({
          service,
          target: target.service,
          network: normalizeNetwork(network),
          targetNetwork,
        });
      }
      if (target.privateUrl === undefined) {
        return yield* new ServiceNotBindable({
          service,
          target: target.service,
        });
      }
      if (
        target.port !== undefined &&
        !(target.endpoints ?? []).some((entry) => entry.port === target.port)
      ) {
        return yield* new EndpointNotPublished({
          service,
          target: target.service,
          port: target.port,
        });
      }
    }
  });

/**
 * Fail when a Machine outside this Service already publishes one of its
 * ports in a shared App. Catches Machines the App's bindings do not list:
 * other stacks, the `fly` CLI, or plain `Fly.Machine`s.
 */
const validateObservedPorts = (
  appName: string,
  fqn: string,
  id: string,
  services: FlyMachineService[],
) =>
  Effect.gen(function* () {
    const listed = yield* machines
      .listMachines({ app_name: appName })
      .pipe(Effect.catchTag(["NotFound"], () => Effect.succeed([])));
    const others = new Map<string, FlyMachineService[] | undefined>();
    for (const machine of listed) {
      if (machine.state === "destroyed") continue;
      const owner =
        machine.config?.metadata?.[alchemyMetadataKeys.fqn] ?? machine.id ?? "";
      if (owner === fqn || others.has(owner)) continue;
      others.set(owner, machine.config?.services);
    }
    const mine = portsOfFly(services);
    for (const [owner, theirs] of others) {
      const conflict = findPortConflict(appName, [
        { id, ports: mine },
        { id: owner, ports: portsOfFly(theirs) },
      ]);
      if (
        conflict !== undefined &&
        conflict.publishers[0] !== conflict.publishers[1]
      )
        return yield* conflict;
    }
  });

const toAttrs = (
  set: ReplicaSet,
  codeHash: string,
  access: Access,
): Service["Attributes"] => ({
  appName: set.appName,
  ownsApp: access.ownsApp,
  network: normalizeNetwork(access.network),
  rpcToken: access.rpcToken,
  ...endpointsOf(set, access),
  rolloutPending: set.rolloutPending,
  machineId: set.machineId,
  machineIds: set.machineIds,
  name: set.name,
  baseName: set.baseName,
  region: set.region,
  regions: set.regions,
  state: set.state,
  imageRef: set.imageRef,
  count: Math.round(set.count / Math.max(1, set.regions.length)),
  mounts: set.mounts,
  replicas: set.replicas,
  code: { hash: codeHash },
});

const machineIdsOf = (output: Service["Attributes"] | undefined) =>
  output?.machineIds ??
  (output?.machineId !== undefined && output.machineId.length > 0
    ? [output.machineId]
    : []);

/** The private network the Service's Machines join. */
const networkOf = (props: ServiceProps) =>
  normalizeNetwork(
    props.app === undefined
      ? props.network
      : (props.app as { network?: string }).network,
  );

/**
 * Resolve the App the Service runs in. A Service that owns its App creates
 * it with its addresses; one placed in an App gets a Flycast address on it
 * so bound callers can reach it.
 */
const ensureServiceApp = Effect.fn(function* (
  id: string,
  props: ServiceProps,
  output: Service["Attributes"] | undefined,
) {
  yield* validateOwnership(props);
  const ownsApp = props.app === undefined;
  const isPublic = !ownsApp || props.public !== false;
  if (ownsApp) {
    const desired =
      props.name !== undefined
        ? sanitizeFlyAppName(props.name)
        : output?.ownsApp === true
          ? output.appName
          : yield* createFlyAppName(id);
    const app = yield* ensureApp({
      name: desired,
      network: props.network,
      previousName: output?.ownsApp === true ? output.appName : undefined,
    });
    const appName = app.name ?? desired;
    yield* syncOwnedAppAddresses(appName, isPublic, props.network);
    return { appName, ownsApp, isPublic, network: props.network };
  }
  const appName = appNameOf(props.app) ?? output?.appName;
  if (appName === undefined) {
    return yield* new ServiceAppNotResolved({
      message: "Fly.Service requires a resolved App with appName.",
    });
  }
  const network = networkOf(props);
  yield* ensureFlycastAddress(appName, network);
  return { appName, ownsApp, isPublic, network };
});

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
        stables: ["appName"],
        nuke: { dependsOn: ["Fly.App"] },

        diff: Effect.fn(function* ({ id, news, output }) {
          if (news === undefined) return;
          const shape = news as Partial<
            Pick<ServiceProps, "app" | "public" | "network">
          >;
          const ownsApp = shape.app === undefined;
          yield* validateOwnership(shape);
          if ("main" in news) {
            const settings: Input<
              Pick<
                ServiceProps,
                | "deploy"
                | "shutdown"
                | "checks"
                | "services"
                | "port"
                | "isExternal"
                | "public"
              >
            > = {
              deploy: news.deploy,
              shutdown: news.shutdown,
              services: news.services,
              checks: news.checks,
              port: news.port,
              isExternal: news.isExternal,
              public: news.public,
            };
            if (
              isResolved<
                Pick<
                  ServiceProps,
                  | "deploy"
                  | "shutdown"
                  | "checks"
                  | "services"
                  | "port"
                  | "isExternal"
                  | "public"
                >
              >(settings)
            ) {
              yield* validateDeployment(
                yield* deploymentPolicy(
                  settings.deploy,
                  settings.shutdown,
                  !settings.isExternal,
                ),
                {
                  services:
                    settings.services?.map(toFlyService) ??
                    defaultHttpServices(
                      settings.port ?? DEFAULT_PORT,
                      1,
                      !ownsApp || settings.public !== false,
                    ),
                  checks: settings.checks,
                },
                false,
              );
            }
          }
          if (output === undefined) return;
          // Moving into or out of a shared App changes the hostname.
          if (ownsApp !== (output.ownsApp === true)) {
            return { action: "replace" as const, deleteFirst: false };
          }
          if (ownsApp && isResolved(news)) {
            const desiredAppName =
              news.name !== undefined
                ? sanitizeFlyAppName(news.name)
                : output.appName;
            const nameChanged = desiredAppName !== output.appName;
            // Fly cannot move an App to another network.
            const networkChanged =
              normalizeNetwork(news.network) !==
              normalizeNetwork(output.network);
            if (nameChanged || networkChanged) {
              return {
                action: "replace" as const,
                // A pinned App name cannot exist twice.
                deleteFirst: !nameChanged && news.name !== undefined,
              };
            }
          }
          if (!ownsApp && isResolved(news)) {
            const desiredAppName = appNameOf(news.app);
            const appChanged =
              desiredAppName !== undefined && desiredAppName !== output.appName;
            const desiredName =
              news.name !== undefined
                ? sanitizeFlyAppName(news.name)
                : (output.baseName ?? output.name);
            const nameChanged =
              desiredName !== (output.baseName ?? output.name);
            if (appChanged || nameChanged) {
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
          return output.rolloutPending
            ? { action: "update" as const }
            : undefined;
        }),

        read: Effect.fn(function* ({ id, fqn, instanceId, olds, output }) {
          const ownsApp =
            output?.ownsApp ?? (olds !== undefined && olds.app === undefined);
          const appName = ownsApp
            ? (output?.appName ??
              (olds?.name !== undefined
                ? sanitizeFlyAppName(olds.name)
                : yield* createFlyAppName(id)))
            : (appNameOf(olds?.app) ?? output?.appName);
          const name = yield* resolveMachineName(
            id,
            ownsApp ? undefined : olds?.name,
            output?.baseName ?? output?.name,
          );
          const found = yield* observeReplicaSet({
            appName,
            id,
            type: "Fly.Service",
            fqn,
            resourceInstanceId: instanceId,
            machineIds: machineIdsOf(output),
            baseName: name,
          });
          if (found === undefined) return undefined;
          return toAttrs(found, output?.code.hash ?? "", {
            ownsApp,
            isPublic: ownsApp && (yield* hasPublicAddress(found.appName)),
            network: output?.network ?? (ownsApp ? olds?.network : undefined),
            bindingPort: olds?.bindingPort ?? DEFAULT_BINDING_PORT,
            rpcToken: output?.rpcToken,
          });
        }),

        list: Effect.fn(function* () {
          const sets = yield* listReplicaSets("Fly.Service");
          // Owned Apps are also listed (and nuked) as Fly.App rows.
          return sets.map((set) =>
            toAttrs(set, "", {
              ownsApp: false,
              isPublic: true,
              network: undefined,
              bindingPort: DEFAULT_BINDING_PORT,
              rpcToken: undefined,
            }),
          );
        }),

        reconcile: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          news,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const policy = yield* deploymentPolicy(
            props.deploy,
            props.shutdown,
            !props.isExternal,
          );
          yield* validateOwnership(props);
          const bound = collectBindingState(bindings ?? []);
          // Before creating anything: every bound Service must be reachable.
          yield* validateTargets(id, networkOf(props), bound.targets);
          const { appName, ownsApp, isPublic, network } =
            yield* ensureServiceApp(id, props, output);
          const name = yield* resolveMachineName(
            id,
            ownsApp ? undefined : props.name,
            output?.baseName ?? output?.name,
          );
          const regions = regionList(props.region, DEFAULT_REGION);
          const count = resolveCount(props.count);
          const port = props.port ?? DEFAULT_PORT;
          const bindingPort = props.bindingPort ?? DEFAULT_BINDING_PORT;
          const secretVersions: number[] = [];
          const redisVersion = yield* attachRedisSecrets(appName, bound.redis);
          if (redisVersion !== undefined) secretVersions.push(redisVersion);
          const bucketVersion = yield* attachBucketSecrets(
            appName,
            bound.buckets,
            {
              ...bound.env,
              ...toEnv(props.env),
            },
          );
          if (bucketVersion !== undefined) secretVersions.push(bucketVersion);
          for (const pg of bound.postgres) {
            const version = yield* attachPostgresSecrets(
              appName,
              pg.clusterId,
              pg.variableName,
            );
            if (version !== undefined) secretVersions.push(version);
          }
          const minSecretsVersion =
            secretVersions.length > 0 ? Math.max(...secretVersions) : undefined;
          const env = desiredEnv(props, bound.env, hosted.alchemyEnv, port);
          if (policy.shutdown && !props.isExternal) {
            env.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS = String(
              policy.shutdown.timeoutMs,
            );
          }
          const guest = toFlyGuest(props.guest);
          const published = withBindingService(
            props.services !== undefined
              ? props.services.map(toFlyService)
              : defaultHttpServices(port, count, isPublic),
            port,
            bindingPort,
          );
          const services = published.services;
          if (!ownsApp)
            yield* validateObservedPorts(appName, fqn, id, services);
          if (props.rpcToken !== undefined)
            env[RPC_TOKEN_ENV] = Redacted.value(props.rpcToken);
          for (const target of bound.targets) {
            const keys = boundTargetEnvKeys(target.service);
            env[keys.appName] = packEnvValue(target.appName);
            if (target.privateUrl !== undefined)
              env[keys.url] = packEnvValue(target.privateUrl);
            if (target.rpcToken !== undefined)
              env[keys.token] = packEnvValue(target.rpcToken);
          }
          env[RPC_ORG_ENV] = yield* resolveOrgSlug();
          if (published.added) env[BINDING_PORT_ENV] = String(bindingPort);
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
            fqn,
            resourceInstanceId: instanceId,
            policy,
            checks: props.checks,
            appName,
            baseName: name,
            regions,
            // `count` is per region.
            count: count * regions.length,
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
          return toAttrs(set, codeHash, {
            ownsApp,
            isPublic,
            network,
            bindingPort,
            rpcToken: props.rpcToken,
          });
        }),

        // Create the App, its addresses, and the caller token before any
        // Machine, so two Services that bind each other can both resolve
        // the other's private address and token.
        precreate: Effect.fn(function* ({ id, news }) {
          const props = news;
          // Precreate runs before dependencies resolve. A Service placed in
          // an App cannot see the App yet, so it has no stub to offer;
          // cycles are supported between Services that own their App.
          const inert =
            props.app !== undefined ||
            !isResolved(props.name) ||
            !isResolved(props.network) ||
            !isResolved(props.services) ||
            !isResolved(props.bindingPort);
          // No stub: a failed create then recovers through `read`, which
          // finds the App from the persisted props.
          if (inert) return undefined as unknown as Service["Attributes"];
          const { appName, ownsApp, isPublic, network } =
            yield* ensureServiceApp(id, props, undefined);
          const port = props.port ?? DEFAULT_PORT;
          const count = resolveCount(props.count);
          const bindingPort = props.bindingPort ?? DEFAULT_BINDING_PORT;
          const { services } = withBindingService(
            props.services !== undefined
              ? props.services.map(toFlyService)
              : defaultHttpServices(port, count, isPublic),
            port,
            bindingPort,
          );
          const name = yield* resolveMachineName(
            id,
            ownsApp ? undefined : props.name,
          );
          const stub: ReplicaSet = {
            appName,
            machineId: "",
            machineIds: [],
            name,
            baseName: name,
            region: regionList(props.region, DEFAULT_REGION)[0]!,
            regions: regionList(props.region, DEFAULT_REGION),
            state: "created",
            instanceId: undefined,
            privateIp: undefined,
            imageRef: undefined,
            guest: undefined,
            services,
            count: 0,
            mounts: [],
            replicas: [],
          };
          return toAttrs(stub, "", {
            ownsApp,
            isPublic,
            network,
            bindingPort,
            rpcToken: isResolved(props.rpcToken) ? props.rpcToken : undefined,
          });
        }),

        delete: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          olds,
          output,
          force,
        }) {
          const appName = output.appName || appNameOf(olds.app);
          // A precreate stub that never reached its App has nothing to delete.
          if (appName === undefined || appName.length === 0) return;
          yield* deleteReplicaSet({
            appName,
            id,
            type: "Fly.Service",
            fqn,
            resourceInstanceId: instanceId,
            machineIds: machineIdsOf(output),
            volumeIds: volumeIdsOf(output),
            force,
          });
          if (output.ownsApp === true) yield* deleteApp(appName);
        }),
      });
    }),
  ).pipe(Layer.provide(DockerLive));
