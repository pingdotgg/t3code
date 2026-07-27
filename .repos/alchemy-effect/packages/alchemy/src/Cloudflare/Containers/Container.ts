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
 * @resource
 * @product Containers
 * @category Workers & Compute
 * @section Container Layer
 * Define the class and `.make()` in separate files. The class
 * declares the container's identity, configuration, and typed
 * shape. `.make()` provides the runtime implementation as a
 * default export. Use `Container.of` to construct the typed
 * shape — it ensures your implementation matches the methods
 * declared on the class.
 *
 * @example Container class
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
 * @example Container .make()
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
 * @section Image Sources
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
 * @example Effect-native image (`main`)
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
 * @example Build your own Dockerfile (`context` / `dockerfile`)
 * ```typescript
 * // Alchemy builds the Dockerfile against the context directory — no
 * // Effect bundling, no `.make()`. `dockerfile` defaults to
 * // `<context>/Dockerfile`. The props are declared inline on the tag.
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   context: `${import.meta.dirname}/context`,
 * }) {}
 * ```
 *
 * @example Remote image (`image`)
 * ```typescript
 * // Alchemy pulls the public image and re-pushes it to Cloudflare's
 * // registry — no build, no bundling, no `.make()`.
 * export class Echo extends Cloudflare.Container<Echo>()("Echo", {
 *   image: "mendhak/http-https-echo:latest",
 * }) {}
 * ```
 *
 * @example Reaching an arbitrary image's port from a Durable Object
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
 * @section Configuration
 * The props object — the first argument to `.make()` — accepts `main`
 * (entrypoint file), `instanceType` (compute size), `runtime`
 * (`"bun"` or `"node"`), and `observability` settings. Use
 * `Stack.useSync` to read the surrounding stack and pick a beefier
 * `instanceType` in prod while keeping the cheap `dev` instance for
 * preview environments.
 *
 * @example Stage-dependent configuration
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
 * @section Stack-level wiring
 * The `.make()` `export default` is the side-effect that registers
 * the container's runtime. It must be reachable from your
 * `alchemy.run.ts` so the bundler emits the runtime entrypoint.
 * Provide it on the Stack's generator with `Effect.provide`.
 *
 * @example Wiring SandboxLive into the Stack
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
 * @section Calling from a Durable Object
 * `yield* Sandbox` resolves a **running** container instance — every
 * method declared on the container's shape **plus** a `getTcpPort`
 * helper. Provide `Cloudflare.Containers.layer(Sandbox, …)` on the
 * DO's init to configure how the container runs; that layer binds,
 * starts, and monitors it and satisfies the `Sandbox` tag. Because
 * only the class is imported, the runtime implementation in
 * `Sandbox.runtime.ts` is tree-shaken out of the DO's bundle.
 *
 * @example Running a container from a DO
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
 * @section HTTP Requests to Container Ports
 * Use `getTcpPort` on the running container instance to get a `fetch`
 * handle for a specific port. This lets you make HTTP requests to
 * servers running inside the container process.
 *
 * @example Fetching from a container port
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
 */
export const Container: ResourceClassLike<ContainerApplication> & {
  <const Id extends string>(
    id: Id,
    props:
      | InputProps<ExternalContainerProps>
      | InputProps<RemoteContainerProps>,
  ): Container.Decl<Container<Id>, {}, Id>;
  <Self>(): {
    <
      const Id extends string,
      Props extends
        | InputProps<ExternalContainerProps>
        | InputProps<RemoteContainerProps>,
    >(
      id: Id,
      props: Props,
    ): Container.Decl<Self, {}, Id>;
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
  >
    extends Effect.Effect<Self, never, Providers | Req>, Rpc<Shape>, Named<Id> {
    new (): Container<Id> & Shape;
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
    export type Any = Decl<any, any, string, any>;
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
