import type * as cf from "@cloudflare/workers-types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { InlineDockerfile } from "../../Docker/Dockerfile.ts";
import type { InputProps } from "../../Input.ts";
import type { Named } from "../../Named.ts";
import type { ResourceClassLike } from "../../Resource.ts";
import type { Rpc } from "../../Rpc.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Fetcher } from "../Fetcher.ts";
import type { Providers } from "../Providers.ts";
import { type WorkerShape } from "../Workers/Worker.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
} from "./ContainerApplication.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

export const ContainerTypeId = "Cloudflare.Container";
export type ContainerTypeId = typeof ContainerTypeId;

export const ContainerTag = (
  id: string,
): Context.Key<Container.Instance, Container.Instance> =>
  Context.Service<Container.Instance>(`Container<${id}>`);

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ContainerTypeId;

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * No container instance could be allocated within the start budget — the
 * account is at its concurrent-instance cap (`maxInstances`) or the platform
 * is still provisioning. Mirrors `@cloudflare/containers`'
 * `NO_CONTAINER_INSTANCE_ERROR` (surfaced as HTTP 503 by native).
 */
export class NoContainerInstanceError extends Data.TaggedError(
  "NoContainerInstanceError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Cloudflare is rate limiting container starts ("too many containers per
 * second"). Mirrors `@cloudflare/containers`' `RATE_LIMITED_ERROR` (HTTP 429).
 * Hammering `start()` while rate limited only prolongs it, so callers should
 * back off rather than retry tightly.
 */
export class ContainerRateLimitedError extends Data.TaggedError(
  "ContainerRateLimitedError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The container instance exited/crashed while we were waiting for its port —
 * the entrypoint failed to bind or died. Mirrors native's "container exited"
 * detection (`!this.container.running` mid-wait); not curable by continuing to
 * poll the same instance.
 */
export class ContainerCrashedError extends Data.TaggedError(
  "ContainerCrashedError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ContainerStartupOptions extends cf.ContainerStartupOptions {}

import type {
  EffectfulContainerProps,
  ExternalContainerProps,
  RemoteContainerProps,
} from "./ContainerApplication.ts";

export type {
  EffectfulContainerProps,
  ExternalContainerProps,
  RemoteContainerProps,
};

/**
 * Props for an image-backed container declaration — either the plain props
 * object, or an Effect that produces it.
 *
 * The Effect form is how a container reaches another resource's outputs. A
 * class body is module scope, so there is nowhere to `yield*` a database,
 * queue, or bucket; wrapping the props in `Effect.gen` moves the declaration
 * into an Effect where sibling resources resolve normally and their
 * attributes can be threaded into `env`:
 *
 * ```typescript
 * export class Api extends Cloudflare.Container<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const { connection } = yield* Db;
 *     return {
 *       context: `${import.meta.dirname}/api`,
 *       env: { DATABASE_URL: connection.databaseUrl },
 *     };
 *   }),
 * ) {}
 * ```
 *
 * A plain props object cannot do this: a module-scope resource declaration
 * is an Effect, not a resolved handle, so `Db.connectionString` is
 * `undefined` until something yields it.
 */
export type ImageContainerProps<Req = never> =
  | InputProps<ExternalContainerProps>
  | InputProps<RemoteContainerProps>
  | Effect.Effect<
      InputProps<ExternalContainerProps> | InputProps<RemoteContainerProps>,
      Config.ConfigError,
      Req
    >;

export type Container<Id extends string = string> = Named<Id> & {
  get running(): Effect.Effect<boolean, never, RuntimeContext>;
  start(
    options?: ContainerStartupOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  monitor(): Effect.Effect<void, ContainerError, RuntimeContext>;
  destroy(error?: any): Effect.Effect<void, never, RuntimeContext>;
  signal(signo: number): Effect.Effect<void, never, RuntimeContext>;
  getTcpPort(port: number): Effect.Effect<Fetcher, never, RuntimeContext>;
  setInactivityTimeout(
    durationMs: number | bigint,
  ): Effect.Effect<void, never, RuntimeContext>;
  interceptOutboundHttp(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, never, RuntimeContext>;
  interceptAllOutboundHttp(
    binding: Fetcher,
  ): Effect.Effect<void, never, RuntimeContext>;
};

/**
 * A Cloudflare Container that runs a long-lived process alongside a
 * Durable Object.
 *
 * Containers always use the **Container Layer** pattern — the class
 * and `.make()` must live in separate files. A Container must be
 * bound to a Durable Object, and the DO imports the class to get a
 * typed handle. If the class and `.make()` lived in the same file,
 * the DO's bundle would pull in all of the container's runtime
 * dependencies (process spawners, Node APIs, SDKs, etc.), which
 * would bloat the bundle and likely break the Cloudflare Workers
 * runtime. Keeping them separate ensures the bundler only includes
 * the tiny class in the DO's output.
 *
 * See the [Platform concept](/infrastructure-as-effects/functions-and-servers)
 * page for how this fits into the async / effect / layer
 * progression.
 * ### Container Layer
 * Define the class and `.make()` in separate files. The class
 * declares the container's identity, configuration, and typed
 * shape. `.make()` provides the runtime implementation as a
 * default export. Use `Container.of` to construct the typed
 * shape — it ensures your implementation matches the methods
 * declared on the class.
 *
 * **Example:** Container class
 * ```typescript
 * // src/Sandbox.ts — the tag carries only the name + typed shape;
 * // configuration lives on `.make()`.
 * export class Sandbox extends Cloudflare.Container<
 *   Sandbox,
 *   {
 *     exec: (cmd: string) => Effect.Effect<{
 *       exitCode: number;
 *       stdout: string;
 *       stderr: string;
 *     }>;
 *   }
 * >()("Sandbox") {}
 * ```
 *
 * **Example:** Container .make()
 * ```typescript
 * // src/Sandbox.runtime.ts — props are the first argument to `.make()`
 * export default Sandbox.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const cp = yield* ChildProcessSpawner;
 *
 *     return Sandbox.of({
 *       exec: (command) =>
 *         cp.spawn(ChildProcess.make(command, { shell: true })).pipe(
 *           Effect.flatMap(({ exitCode, stdout, stderr }) =>
 *             Effect.all({
 *               exitCode,
 *               stdout: stdout.pipe(Stream.decodeText, Stream.mkString),
 *               stderr: stderr.pipe(Stream.decodeText, Stream.mkString),
 *             }),
 *           ),
 *           Effect.scoped,
 *         ),
 *       fetch: Effect.succeed(
 *         HttpServerResponse.text("Hello from container!"),
 *       ),
 *     });
 *   }),
 * );
 * ```
 *
 * ### Async Workers
 * An async Worker can host a container-backed Durable Object class that
 * ships as plain JavaScript — `@cloudflare/sandbox`'s `Sandbox`, or your
 * own class extending `@cloudflare/containers`' `Container`. The class
 * lives in the worker script; `Container` (the npm one) handles the
 * lifecycle and forwards `fetch` to the port inside the container.
 *
 * **Example:** The worker script exports the container-backed class
 * ```typescript
 * // src/worker.ts
 * import { Container } from "@cloudflare/containers";
 *
 * export class Sandbox extends Container {
 *   defaultPort = 8080;
 * }
 * ```
 *
 * Declare it in the stack by binding a `Cloudflare.Container` in the
 * Worker's `env` — the Container **is** the Durable Object binding and its
 * ContainerApplication together. Alchemy emits the
 * `durable_object_namespace` binding, marks the class as container-backed
 * in the script metadata, provisions the ContainerApplication, and attaches
 * it to the class's namespace. The Durable Object class name defaults to
 * the binding name (the `env` key); set `className` when the exported class
 * is named differently.
 *
 * **Example:** Binding the container-backed class in the stack
 * ```typescript
 * // alchemy.run.ts
 * import type { Sandbox } from "./src/worker.ts";
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
 *       image: "docker.io/cloudflare/sandbox:0.1.3",
 *     }),
 *   },
 * });
 * ```
 *
 * The type parameter (`Container<Sandbox>`) is the class from `worker.ts` —
 * it types `env.Sandbox` as `DurableObjectNamespace<Sandbox>` via
 * `Cloudflare.InferEnv`, so the handler reaches the container with full
 * types.
 *
 * **Example:** Reaching the container from the async handler
 * ```typescript
 * // src/worker.ts
 * import { getContainer } from "@cloudflare/containers";
 * import type * as Cloudflare from "alchemy/Cloudflare";
 * import type { Worker } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: Cloudflare.InferEnv<typeof Worker>) {
 *     return getContainer(env.Sandbox, "default").fetch(request);
 *   },
 * };
 * ```
 *
 * ### Image Sources
 * A container's image comes from one of three sources, picked by which
 * prop you set:
 *
 * - `main` — bundle your Effect program into a generated image.
 * - `context` (+ optional `dockerfile`) — build your own Dockerfile.
 * - `image` — pull a pre-built remote image and re-push it.
 *
 * Only the `main` source bundles and injects an Effect runtime — so it
 * has a typed shape and a `.make(props, impl)` runtime. The other two
 * ship an arbitrary image as-is: they have no runtime to provide, so
 * you declare the class with its props inline and register it purely
 * via `Cloudflare.Containers.layer` from the hosting Durable Object.
 *
 * **Example:** Effect-native image (`main`)
 * ```typescript
 * // Alchemy bundles this file's Effect program and bakes it into a
 * // generated image as the entrypoint.
 * export class Sandbox extends Cloudflare.Container<
 *   Sandbox,
 *   { ping: () => Effect.Effect<string> }
 * >()("Sandbox") {}
 *
 * export default Sandbox.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Sandbox.of({
 *       ping: () => Effect.succeed("pong"),
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     });
 *   }),
 * );
 * ```
 *
 * **Example:** Build your own Dockerfile (`context` / `dockerfile`)
 * ```typescript
 * // Alchemy builds the Dockerfile against the context directory — no
 * // Effect bundling, no `.make()`. `dockerfile` defaults to
 * // `<context>/Dockerfile`. The props are declared inline on the tag.
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   context: `${import.meta.dirname}/context`,
 * }) {}
 * ```
 *
 * **Example:** Remote image (`image`)
 * ```typescript
 * // Alchemy pulls the public image and re-pushes it to Cloudflare's
 * // registry — no build, no bundling, no `.make()`.
 * export class Echo extends Cloudflare.Container<Echo>()("Echo", {
 *   image: "mendhak/http-https-echo:latest",
 * }) {}
 * ```
 *
 * **Example:** Reaching an arbitrary image's port from a Durable Object
 * ```typescript
 * // `external` and `remote` images expose no RPC methods, so the DO
 * // talks to them purely over their TCP port via `getTcpPort`.
 * export class WebObject extends Cloudflare.DurableObject<WebObject>()(
 *   "WebObject",
 *   Effect.gen(function* () {
 *     const web = yield* Web;
 *     return Effect.gen(function* () {
 *       return {
 *         hello: () =>
 *           Effect.gen(function* () {
 *             const { fetch } = yield* web.getTcpPort(8080);
 *             const res = yield* fetch(HttpClientRequest.get("http://container/"));
 *             return yield* res.text;
 *           }),
 *       };
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Containers.layer(Web))),
 * ) {}
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Top-level calls in the
 * `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`, and
 * `@distilled.cloud/*` packages receive `#__PURE__` annotations by
 * default, so anything the container program doesn't use from those packages is
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
 * ### Configuration
 * The props object — the first argument to `.make()` — accepts `main`
 * (entrypoint file), `instanceType` (compute size), `runtime`
 * (`"bun"` or `"node"`), and `observability` settings. Use
 * `Stack.useSync` to read the surrounding stack and pick a beefier
 * `instanceType` in prod while keeping the cheap `dev` instance for
 * preview environments.
 *
 * **Example:** Stage-dependent configuration
 * ```typescript
 * export const SandboxLive = Sandbox.make(
 *   Stack.useSync((stack) => ({
 *     main: import.meta.url,
 *     instanceType: stack.stage === "prod" ? "standard-1" : "dev",
 *     observability: { logs: { enabled: true } },
 *   })),
 *   Effect.gen(function* () {
 *     return Sandbox.of({ exec: (cmd) => ... });
 *   }),
 * );
 * ```
 *
 * ### Environment Variables
 * A container is a process, not a Worker: it has no bindings, so every
 * piece of configuration reaches it through `env`. Each entry lands on
 * the deployment and shows up in `process.env` inside the image —
 * generated (`main`), built (`context`), or pre-built (`image`) alike.
 * Wrap a secret in `Redacted` to keep it encrypted in state and out of
 * plan output; the container still reads a plain string.
 *
 * **Example:** Plain and secret env values
 * ```typescript
 * export class Api extends Cloudflare.Container<Api>()("Api", {
 *   context: `${import.meta.dirname}/api`,
 *   ports: [{ name: "http", port: 8080 }],
 *   env: {
 *     PORT: "8080",
 *     SESSION_KEY: Redacted.make(process.env.SESSION_KEY!),
 *   },
 * }) {}
 * ```
 *
 * ### Props from Other Resources
 * A class body is module scope, so there is nowhere to `yield*` the
 * database, queue, or bucket whose output you need — and a bare
 * declaration is an Effect, not a resolved handle, so
 * `Uploads.bucketName` reads as `undefined`. Pass the props as an
 * `Effect.gen` instead: inside it sibling resources resolve normally,
 * and the reference orders the deploy.
 *
 * **Example:** Threading a sibling resource's output into `env`
 * ```typescript
 * export const Uploads = Cloudflare.R2.Bucket("Uploads");
 *
 * export class Api extends Cloudflare.Container<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const uploads = yield* Uploads;
 *     return {
 *       context: `${import.meta.dirname}/api`,
 *       env: { BUCKET_NAME: uploads.bucketName },
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Database Connections
 * An effectful (`main`) container runs your Effect program, so it
 * resolves a database capability the same way a Worker does — you never
 * name `DATABASE_URL`. The container has no bindings (it is a process,
 * not a Worker), so `Prisma.Connect` writes the connection's outputs
 * onto the deployment as environment variables and reads them back at
 * runtime; the capability owns both ends.
 *
 * **Example:** Binding a Prisma connection inside the container runtime
 * ```typescript
 * export default Api.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(Connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *
 *     return Api.of({
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     });
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * An image you brought yourself knows nothing about alchemy, so there is
 * no capability to bind — name the variable and hand it the provider's
 * **pooled** connection string.
 *
 * **Example:** Passing a pooled database URL to an arbitrary image
 * ```typescript
 * export class Web extends Cloudflare.Container<Web>()(
 *   "Web",
 *   Effect.gen(function* () {
 *     const connection = yield* Connection;
 *     return {
 *       context: `${import.meta.dirname}/web`,
 *       env: { DATABASE_URL: connection.databaseUrl },
 *     };
 *   }),
 * ) {}
 * ```
 *
 * Either way, start it with
 * `Cloudflare.Containers.layer(Api, { enableInternet: true })` — without
 * outbound networking the container never reaches the database.
 * `Cloudflare.Hyperdrive.Connect` is the one that cannot work here: it
 * *is* a workerd binding, so no container process can resolve it.
 *
 * ### Stack-level wiring
 * The `.make()` `export default` is the side-effect that registers
 * the container's runtime. It must be reachable from your
 * `alchemy.run.ts` so the bundler emits the runtime entrypoint.
 * Provide it on the Stack's generator with `Effect.provide`.
 *
 * **Example:** Wiring SandboxLive into the Stack
 * ```typescript
 * // alchemy.run.ts
 * import SandboxLive from "./src/Sandbox.runtime.ts";
 *
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     return { url: worker.url };
 *   }).pipe(Effect.provide(SandboxLive)),
 * );
 * ```
 *
 * ### Calling from a Durable Object
 * `yield* Sandbox` resolves a **running** container instance — every
 * method declared on the container's shape **plus** a `getTcpPort`
 * helper. Provide `Cloudflare.Containers.layer(Sandbox, …)` on the
 * DO's init to configure how the container runs; that layer binds,
 * starts, and monitors it and satisfies the `Sandbox` tag. Because
 * only the class is imported, the runtime implementation in
 * `Sandbox.runtime.ts` is tree-shaken out of the DO's bundle.
 *
 * **Example:** Running a container from a DO
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *
 *     return Effect.gen(function* () {
 *       return {
 *         exec: (cmd: string) => sandbox.exec(cmd),
 *       };
 *     });
 *   }).pipe(
 *     Effect.provide(
 *       Cloudflare.Containers.layer(Sandbox, { enableInternet: true }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### HTTP Requests to Container Ports
 * Use `getTcpPort` on the running container instance to get a `fetch`
 * handle for a specific port. This lets you make HTTP requests to
 * servers running inside the container process.
 *
 * **Example:** Fetching from a container port
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *
 *     return Effect.gen(function* () {
 *       const { fetch } = yield* sandbox.getTcpPort(3000);
 *
 *       return {
 *         health: () =>
 *           Effect.gen(function* () {
 *             const response = yield* fetch(
 *               HttpClientRequest.get("http://container/health"),
 *             );
 *             return yield* response.text;
 *           }),
 *       };
 *     });
 *   }).pipe(
 *     Effect.provide(
 *       Cloudflare.Containers.layer(Sandbox, { enableInternet: true }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @resource
 * @product Containers
 * @category Workers & Compute
 */
export const Container: ResourceClassLike<ContainerApplication> & {
  <DOShape = unknown, const Id extends string = string, PropsReq = never>(
    id: Id,
    props: ImageContainerProps<PropsReq>,
  ): Container.Decl<Container<Id>, {}, Id, PropsReq, DOShape>;
  <Self>(): {
    <const Id extends string, PropsReq = never>(
      id: Id,
      props: ImageContainerProps<PropsReq>,
    ): Container.Decl<Self, {}, Id, PropsReq>;
  };
  <Self, Shape>(): {
    <const Id extends string>(
      id: Id,
    ): Container.Decl<Self, Shape, Id, Container.Application<Self>>;
  };
} = Object.assign(
  (...args: any[]) => {
    if (args.length === 0) {
      return (...args: any[]) => {
        if (args.length === 1) {
          const [id] = args as [string];
          const tag = ContainerPlatform()(id);
          // `yield* MyContainer` resolves the *started* instance tag, which is
          // provided by `layer(MyContainer)`. The bind effect (which
          // registers the DO + Worker bindings and produces the runtime
          // handle) is stashed so `startContainer` can run it from inside that
          // layer — see ContainerPlatform.bind / StartContainer.ts.
          // NOTE: no `~alchemy/Container/ClassName` marker here — an
          // effectful (`main`) container is not bindable on an async
          // Worker's `env` (its application is created by the `.make()`
          // Layer inside an Effect-native Durable Object host), so it must
          // not be picked up by bindWorkerAsyncBindings' container branch.
          return Object.assign(effectClass(ContainerTag(id)), {
            "~alchemy/Id": id,
            "~alchemy/Container/Binding": ContainerPlatform.bind(tag),
            make: (props: any, impl: any) => tag.make(props, impl),
            // yield* MyContainer.Application to get the ContainerApplication Resource Outputs
            Application: tag,
            of: (shape: any) => shape,
          });
        } else {
          return Container(...(args as [string, any]));
        }
      };
    } else {
      const [id, props] = args as [string, any];
      const resource = ContainerPlatform(id, props);
      return Object.assign(effectClass(ContainerTag(id)), {
        "~alchemy/Id": id,
        "~alchemy/Container/Binding": ContainerPlatform.bind(resource),
        // The Durable Object class name this container backs when bound on
        // an async Worker's `env` (see bindWorkerAsyncBindings). Defaults to
        // the binding name at bind time when no explicit `className` is set.
        // Effect-valued props cannot be read synchronously here, so carry
        // the unresolved lookup and let `bindContainerClass` await it.
        "~alchemy/Container/ClassName": Effect.isEffect(props)
          ? Effect.map(
              props as Effect.Effect<{ className?: string } | undefined>,
              (resolved) => resolved?.className,
            )
          : (props as { className?: string })?.className,
        // yield* MyContainer.Application to get the ContainerApplication Resource Outputs
        Application: resource,
        of: (shape: any) => shape,
      });
    }
  },
  {
    Type: ContainerTypeId,
  },
) as any;

export declare namespace Container {
  export interface Decl<
    Self = any,
    Shape = any,
    Id extends string = string,
    Req = never,
    DOShape = unknown,
  >
    extends Effect.Effect<Self, never, Providers | Req>, Rpc<Shape>, Named<Id> {
    new (): Container<Id> & Shape;
    /**
     * @internal phantom — the Durable Object class type backing this
     * container when it is bound on an async Worker's `env`. Drives
     * `InferEnv` (`env.NAME` becomes `DurableObjectNamespace<DOShape>`).
     */
    readonly "~alchemy/Container/Shape": DOShape;
    /**
     * @internal — the explicit `className` from props (`undefined` defaults
     * to the binding name at bind time). Doubles as the runtime marker that
     * identifies an async-bindable Container declaration in a Worker's `env`
     * (see `bindWorkerAsyncBindings`).
     */
    readonly "~alchemy/Container/ClassName":
      | string
      | undefined
      | Effect.Effect<string | undefined>;
    /**
     * The underlying {@link ContainerApplication} resource declaration —
     * `yield*` it to get the application's Output attributes.
     */
    Application: Effect.Effect<ContainerApplication<Self>, never, Providers>;
    make: <InitReq = never, WorkerReq = never, PropsReq = never>(
      props:
        | InputProps<EffectfulContainerProps>
        | Effect.Effect<
            InputProps<EffectfulContainerProps>,
            Config.ConfigError,
            PropsReq
          >,
      impl: Effect.Effect<
        Shape & WorkerShape<WorkerReq>,
        Config.ConfigError,
        InitReq
      >,
    ) => Layer.Layer<Application<Self>, never, Providers>;
    of(shape: Shape & WorkerShape): Shape;
  }
  export namespace Decl {
    export type Any = Decl<any, any, string, any, any>;
  }

  export interface Application<Self> {
    "~alchemy/Kind": "ContainerApplication";
    "~alchemy/Self": Self;
  }

  export type Instance<Shape = any> = Container &
    Shape & {
      getTcpPort: (portNumber: number) => Effect.Effect<{
        fetch: {
          (
            request: HttpClientRequest.HttpClientRequest,
          ): Effect.Effect<HttpClientResponse.HttpClientResponse>;
          (
            request: HttpServerRequest.HttpServerRequest,
          ): Effect.Effect<HttpServerResponse.HttpServerResponse>;
        };
      }>;
    };
}
