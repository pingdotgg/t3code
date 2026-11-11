import type * as cf from "@cloudflare/workers-types";
import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import type { ResourceClass, ResourceClassLike } from "alchemy/Resource";
import type { Rpc } from "alchemy/Rpc";
import { effectClass } from "alchemy/Util/effect";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Providers } from "../Providers.ts";
import { type WorkerShape } from "../Workers/Worker.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";
import {
  makeContainerHandle,
  type ContainerClient,
  type ReservedContainerKey,
} from "./ContainerClient.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

export const ContainerTypeId = "Cloudflare.Container";
export type ContainerTypeId = typeof ContainerTypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" && value !== null && "Type" in value && value.Type === ContainerTypeId;

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
export class NoContainerInstanceError extends Data.TaggedError("NoContainerInstanceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Cloudflare is rate limiting container starts ("too many containers per
 * second"). Mirrors `@cloudflare/containers`' `RATE_LIMITED_ERROR` (HTTP 429).
 * Hammering `start()` while rate limited only prolongs it, so callers should
 * back off rather than retry tightly.
 */
export class ContainerRateLimitedError extends Data.TaggedError("ContainerRateLimitedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The container instance exited/crashed while we were waiting for its port —
 * the entrypoint failed to bind or died. Mirrors native's "container exited"
 * detection (`!this.container.running` mid-wait); not curable by continuing to
 * poll the same instance.
 */
export class ContainerCrashedError extends Data.TaggedError("ContainerCrashedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The container is not running. Ports and RPC methods never start it; call
 * `start()` first.
 */
export class ContainerNotRunningError extends Data.TaggedError("ContainerNotRunningError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Upstream changed ContainerStartupOptions to an intersection with an
// image/containerSnapshot union, which an interface cannot extend.
export type ContainerStartupOptions = cf.ContainerStartupOptions;

import type {
  DurableObjectContainerProps,
  EffectfulContainerProps,
  ExternalContainerProps,
  RemoteContainerProps,
} from "./ContainerApplication.ts";

export type {
  DurableObjectContainerProps,
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
  | InputProps<DurableObjectContainerProps>
  | Effect.Effect<
      | InputProps<ExternalContainerProps>
      | InputProps<RemoteContainerProps>
      | InputProps<DurableObjectContainerProps>,
      Config.ConfigError,
      Req
    >;

/**
 * The handle `yield* MyContainer` returns inside a Durable Object. See
 * {@link ContainerClient}.
 */
export type Container<Id extends string = string> = Named<Id> & ContainerClient;

/** An RPC shape may not redeclare the container handle's own methods. */
type ContainerShape<Shape> = {
  [K in keyof Shape]: K extends ReservedContainerKey ? never : Shape[K];
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
 * See the [Runtime concept](/infrastructure-as-effects/runtime)
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
 *     shell: (cmd: string) => Effect.Effect<{
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
 *       shell: (command) =>
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
 * import type * as Cloudflare from "@alchemy.run/cloudflare";
 * import type { Worker } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: Cloudflare.InferEnv<typeof Worker>) {
 *     return getContainer(env.Sandbox, "default").fetch(request);
 *   },
 * };
 * ```
 *
 * ### Native Durable Object Containers
 * Use `schedulingPolicy: "durable_object"` to let a Durable Object pick its
 * image and instance size at runtime. One Container is one image: `image`
 * copies a registry image, `context`/`dockerfile` builds one. Alchemy pins the
 * image to a digest and prepares it before the Worker is uploaded.
 *
 * `yield* Node` returns the container's handle without starting it.
 * `start()` starts the Container's own image. Its `exec` takes an argument
 * vector and returns a scoped process with streams, an exit code, and an
 * `output()` collector.
 *
 * **Example:** Execute a command in a Container's image
 * ```typescript
 * export class Node extends Cloudflare.Container<Node>()("Node", {
 *   schedulingPolicy: "durable_object",
 *   image: "node:24-slim",
 * }) {}
 *
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const node = yield* Node;
 *     return Effect.succeed({
 *       exec: (args: string[]) =>
 *         Effect.gen(function* () {
 *           // Starts the Node image; a no-op when the container is running.
 *           yield* node.start({
 *             instance: "lite",
 *             entrypoint: ["sleep", "infinity"],
 *             enableInternet: false,
 *           });
 *           const process = yield* node.exec(args);
 *           const result = yield* process.output();
 *           return { text: new TextDecoder().decode(result.stdout), exitCode: result.exitCode };
 *         }).pipe(Effect.scoped),
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Several Images in One Durable Object
 * Cloudflare gives each Durable Object class one container application and
 * each object one container instance. Bind several Containers to choose
 * between their images. Every binding adds its image to the class's
 * application under the Container's id. Each handle's `start()` starts its
 * own image; start one at a time and `destroy()` before switching.
 *
 * **Example:** A Durable Object with Node and Python images
 * ```typescript
 * export class Node extends Cloudflare.Container<Node>()("Node", {
 *   schedulingPolicy: "durable_object",
 *   image: "node:24-slim",
 * }) {}
 *
 * export class Python extends Cloudflare.Container<Python>()("Python", {
 *   schedulingPolicy: "durable_object",
 *   context: "./python",
 * }) {}
 *
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const node = yield* Node;
 *     const python = yield* Python;
 *     const run = (cmd: string[]) =>
 *       Effect.scoped(Effect.flatMap(node.exec(cmd), (process) => process.output()));
 *     return Effect.succeed({
 *       node: (cmd: string[]) =>
 *         node
 *           .start({ entrypoint: ["sleep", "infinity"], enableInternet: false })
 *           .pipe(Effect.andThen(run(cmd))),
 *       python: (cmd: string[]) =>
 *         Effect.gen(function* () {
 *           // Every handle controls the same instance: switch images explicitly.
 *           if (yield* node.running) yield* node.destroy();
 *           yield* python.start({ entrypoint: ["sleep", "infinity"], enableInternet: false });
 *           return yield* Effect.scoped(
 *             Effect.flatMap(python.exec(cmd), (process) => process.output()),
 *           );
 *         }),
 *     });
 *   }),
 * ) {}
 * ```
 *
 * Application-wide settings (`ssh`, `authorizedKeys`, `observability`) may be
 * declared on any of the class's Containers. Two Containers declaring
 * different values fail the deploy with `ContainerApplicationSettingsConflict`.
 *
 * **Example:** Save and restore the writable filesystem
 * ```typescript
 * const snapshot = yield* node.snapshotContainer({ name: "workspace" });
 * // Persist this handle in Durable Object storage before stopping the instance.
 * yield* state.storage.put("snapshot", snapshot);
 * yield* node.destroy();
 * yield* node.start({
 *   containerSnapshot: snapshot,
 *   entrypoint: ["sleep", "infinity"],
 *   enableInternet: false,
 * });
 * ```
 *
 * Snapshots capture the writable root filesystem, not memory, processes, or
 * mounted filesystems. Restoring starts a new entrypoint process. Snapshot
 * handles expire after 30 days without a restore. `exec` does not start a
 * stopped container or invoke a shell; pass `['sh', '-c', command]` explicitly
 * when needed. Scope closure kills an unfinished exec process, but does not
 * signal its descendants. Use an Effect timeout to bound a command's lifetime.
 *
 * ### Native Durable Objects on Async Workers
 * A plain Durable Object class on an async Worker attaches its Containers
 * through its Durable Object binding:
 * `Cloudflare.DurableObject(className, { containers })`. Each Container adds
 * its image to the class's application, and the class reads it from
 * `ctx.container.images` under the Container's id. A Container may be listed
 * by several classes; each class gets its own copy of the image key.
 *
 * **Example:** Two classes sharing the Node image
 * ```typescript
 * // alchemy.run.ts
 * const Node = Cloudflare.Container("Node", {
 *   schedulingPolicy: "durable_object",
 *   image: "node:24-slim",
 * });
 * const Python = Cloudflare.Container("Python", {
 *   schedulingPolicy: "durable_object",
 *   image: "python:3.13-slim",
 * });
 * const Rust = Cloudflare.Container("Rust", {
 *   schedulingPolicy: "durable_object",
 *   image: "rust:1.90-slim",
 * });
 * export const Worker = Cloudflare.Worker("App", {
 *   main: "./src/worker.ts",
 *   env: {
 *     AGENT: Cloudflare.DurableObject("Agent", { containers: [Node, Python] }),
 *     REVIEWER: Cloudflare.DurableObject("Reviewer", { containers: [Node, Rust] }),
 *   },
 * });
 * ```
 *
 * A Durable Object-managed Container placed directly in `env` fails with
 * `DurableObjectContainerBindingError`; only fleet Containers bind that way.
 *
 * **Example:** Starting an image from the class
 * ```typescript
 * // src/worker.ts
 * import { DurableObject } from "cloudflare:workers";
 *
 * export class Agent extends DurableObject {
 *   async run(cmd: string[]) {
 *     const container = this.ctx.container!;
 *     if (!container.running) {
 *       container.start({
 *         image: container.images.Node,
 *         entrypoint: ["sleep", "infinity"],
 *         enableInternet: false,
 *       });
 *     }
 *     return (await container.exec(cmd)).output();
 *   }
 * }
 * ```
 *
 * Local development runs every image through workerd and Docker.
 *
 * Switching an existing application to this scheduling policy requires a new
 * application and a new Durable Object class/namespace. Alchemy rejects an
 * in-place policy change; existing Durable Object storage is not transferred.
 * Replacing only a wrapper with the native API while retaining the original
 * policy and class preserves the namespace. Deployment properties such as
 * `maxInstances`, `instanceType`, `env`, and `rollout` are not valid with the
 * new policy; pass per-instance settings to `start()`.
 *
 * ### Image Sources
 * A container's image comes from one of three sources, picked by which
 * prop you set:
 *
 * - `main` — bundle your Effect program into a generated image.
 * - `context` (+ optional `dockerfile`) — build your own Dockerfile.
 * - `image` — pull a pre-built image and re-push it.
 *
 * Only the `main` source bundles and injects an Effect runtime — so it
 * has a typed shape and a `.make(props, impl)` runtime. The other two
 * ship an arbitrary image as-is: they have no runtime to provide, so
 * you declare the class with its props inline and bind it with
 * `yield* MyContainer` from the hosting Durable Object.
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
 * **Example:** Build args and secrets
 * ```typescript
 * // Dockerfile:
 * //   ARG NODE_ENV
 * //   RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN npm ci
 * export class Api extends Cloudflare.Container<Api>()("Api", {
 *   context: `${import.meta.dirname}/api`,
 *   build: {
 *     args: { NODE_ENV: "production" },
 *     // Resolved at deploy time; mounted only into the `RUN` step that asks
 *     // for it, never written to a layer or the build history.
 *     secrets: { NPM_TOKEN: Config.Redacted("NPM_TOKEN") },
 *   },
 * }) {}
 * ```
 *
 * `build.args` are part of the image hash, so changing one rebuilds the
 * image. `build.secrets` are not: rotating a token reuses the published image.
 *
 * Builds are cached by default at
 * `registry.cloudflare.com/<account-id>/<application-physical-name>`.
 * The generated physical name includes the stage and resource instance, so
 * subsequent updates in that stage can reuse matching images. Replacement or
 * destroy/recreate can change the name and start a new cache. This does not
 * automatically share one repository across every container in the stage.
 * The same defaults apply to inline Dockerfiles and Effect-native `main` builds.
 *
 * **Example:** Reuse builds across stages
 * ```typescript
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   context: `${import.meta.dirname}/context`,
 *   publish: { repository: "web" },
 * }) {}
 * ```
 *
 * `repository: "web"` names the destination repository, not a source image or
 * the container application. With the default registry host, Alchemy lowercases
 * the name and expands it to `registry.cloudflare.com/<account-id>/web`.
 * Supply only the repository name, without a registry host, account ID, tag,
 * or digest. A build produces these references:
 *
 * ```text
 * Published build:  registry.cloudflare.com/<account-id>/web:<build-hash>
 * Build cache:      registry.cloudflare.com/<account-id>/web:buildcache
 * Deployed image:   registry.cloudflare.com/<account-id>/web@sha256:<manifest-digest>
 * ```
 *
 * The build hash identifies the inputs; the manifest digest identifies the
 * published artifact. Applications and stages in the same account can use
 * `publish: { repository: "web" }` to reuse matching published builds. Changed
 * inputs produce another hash tag in the same repository. Builds targeting
 * that repository import reusable layers from its shared `:buildcache` tag,
 * including when full input hashes differ. This mutable tag points to the
 * latest exported inline cache, not a combined cache of every historical
 * image. Reusing a finished image does not move the layer-cache tag.
 *
 * Pin base images and downloaded dependencies: changes outside the build
 * context cannot invalidate the input hash. Each stage still has its own
 * Container application, runtime settings, and instances; only images and
 * build layers are shared.
 *
 * **Example:** Publish an existing image into a named repository
 * ```typescript
 * export class Proxy extends Cloudflare.Container<Proxy>()("Proxy", {
 *   image: "nginx:alpine",
 *   publish: { repository: "web-proxy" },
 * }) {}
 * // Re-publishes nginx into registry.cloudflare.com/<account-id>/web-proxy
 * // and deploys registry.cloudflare.com/<account-id>/web-proxy@sha256:<manifest-digest>.
 * ```
 *
 * Remote images are re-published without building them. An image already in
 * the target registry keeps its existing repository; `publish.repository`
 * does not copy it into another one.
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
 * Alchemy pulls an `image` as `linux/amd64` on every deploy and every
 * `alchemy dev` start, so a mutable tag like `:latest` picks up a newly
 * pushed image. A private registry needs a `docker login` first.
 *
 * **Example:** Image built on this machine
 * ```typescript
 * // docker build --platform linux/amd64 -t local-only/app:dev .
 * export class App extends Cloudflare.Container<App>()("App", {
 *   image: "local-only/app:dev",
 * }) {}
 * ```
 *
 * An image only in the local Docker, built on this machine or loaded with
 * `docker load`, has no registry to pull from. When the pull fails and the
 * image is present locally, Alchemy uses the local copy, in `alchemy dev`
 * and on deploy. Build it with `--platform linux/amd64`, the platform
 * Cloudflare runs: deploy fails on an image built only for another
 * platform. When the image can be neither pulled nor found locally,
 * Alchemy fails with the image name and the commands that fix it. The
 * image name alone is the identity, so rebuilding under the same tag does
 * not redeploy; give each build its own tag.
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
 *       const { fetch } = yield* web.getTcpPort(8080);
 *       return {
 *         hello: () =>
 *           Effect.gen(function* () {
 *             yield* web.start();
 *             const res = yield* fetch(HttpClientRequest.get("http://container/"));
 *             return yield* res.text;
 *           }),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Unused code is
 * tree-shaken. `effect`, alchemy, and `@distilled.cloud` are marked
 * pure so unused parts prune more aggressively. Your app is not
 * marked pure.
 *
 * **Example:** Mark additional packages as pure
 * Only list packages with no top-level side effects.
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * }
 * ```
 *
 * **Example:** Turn it off
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
 *     return Sandbox.of({ shell: (cmd) => ... });
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
 * Either way, start it with `api.start({ enableInternet: true })` — without
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
 * `yield* Sandbox` binds the container to the Durable Object and returns
 * its handle: every method declared on the container's shape, plus
 * `start`, `running`, `destroy`, `getTcpPort`, `exec` and the rest of the
 * native container API. Binding never starts the container. Because only
 * the class is imported, the runtime implementation in
 * `Sandbox.runtime.ts` is tree-shaken out of the DO's bundle.
 *
 * `start()` is idempotent: it starts the container unless it is already
 * running, and concurrent calls start it once. Call it at the top of each
 * operation. Its options apply only when that call actually starts the
 * container. RPC methods and ports wait until the container's port accepts
 * connections, but never start it: a stopped container fails with
 * `ContainerNotRunningError`.
 *
 * **Example:** Starting a container from a DO
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *
 *     return Effect.gen(function* () {
 *       // An Effect is a lazy value: define "start" once, run it per call.
 *       const start = sandbox.start({ enableInternet: true });
 *       return {
 *         shell: (cmd: string) => start.pipe(Effect.andThen(sandbox.shell(cmd))),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * A container's shape cannot declare a method the handle already has
 * (`start`, `exec`, `image`, `getTcpPort`, …); declaring one is a type
 * error, because the handle's method would shadow the RPC call.
 *
 * ### Using a Container from a Layer
 * A Layer can `yield*` a container like any other service. It runs in the
 * Durable Object that hosts it, and starts the container when an operation
 * needs it. Layers never stop a shared container; let it sleep through
 * `setInactivityTimeout`, or stop it from the Durable Object that owns it.
 *
 * **Example:** A service backed by a container
 * ```typescript
 * export const WriteFileLive = Layer.effect(
 *   WriteFile,
 *   Effect.gen(function* () {
 *     const devBox = yield* DevBox;
 *     const start = devBox.start({ enableInternet: true });
 *
 *     return ({ path, contents }) =>
 *       start.pipe(Effect.andThen(devBox.writeFile(path, contents)));
 *   }),
 * );
 * ```
 *
 * ### HTTP Requests to Container Ports
 * Use `getTcpPort` to get a `fetch` handle for a port inside the
 * container. Each request waits until the port accepts connections, then
 * is sent once.
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
 *             yield* sandbox.start({ enableInternet: true });
 *             const response = yield* fetch(
 *               HttpClientRequest.get("http://container/health"),
 *             );
 *             return yield* response.text;
 *           }),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @resource
 * @product Containers
 * @category Workers & Compute
 */
export const Container: ResourceClassLike<ContainerApplication> &
  Pick<ResourceClass<ContainerApplication>, "ref"> & {
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
    <Self, Shape extends ContainerShape<Shape>>(): {
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
          // `yield* MyContainer` binds the container to the hosting Durable
          // Object and returns its handle. It never starts the container.
          // NOTE: no `~alchemy/Container/ClassName` marker here — an
          // effectful (`main`) container is not bindable on an async
          // Worker's `env` (its application is created by the `.make()`
          // Layer inside an Effect-native Durable Object host), so it must
          // not be picked up by bindWorkerAsyncBindings' container branch.
          return Object.assign(effectClass(makeContainerHandle(id, ContainerPlatform.bind(tag))), {
            "~alchemy/Id": id,
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
      return Object.assign(effectClass(makeContainerHandle(id, ContainerPlatform.bind(resource))), {
        "~alchemy/Id": id,
        // The Durable Object class name this container backs when bound on
        // an async Worker's `env` (see bindWorkerAsyncBindings). Defaults to
        // the binding name at bind time when no explicit `className` is set.
        // Effect-valued props cannot be read synchronously here, so carry
        // the unresolved lookup and let `bindContainerClass` await it.
        "~alchemy/Container/ClassName": Effect.isEffect(props)
          ? Effect.map(
              // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- props are untyped; Effect-valued props are resolved by the engine
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
    // Read `ContainerPlatform` lazily: this module and ContainerPlatform.ts
    // import each other, so it may not be initialized at module load.
    ref: (id: string, options?: { stage?: string; stack?: string }) =>
      (ContainerPlatform as unknown as Pick<ResourceClass<ContainerApplication>, "ref">).ref(
        id,
        options,
      ),
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
    readonly "~alchemy/Container/ClassName": string | undefined | Effect.Effect<string | undefined>;
    /**
     * The underlying {@link ContainerApplication} resource declaration —
     * `yield*` it to get the application's Output attributes.
     */
    Application: Effect.Effect<ContainerApplication<Self>, never, Providers | Req>;
    make: <InitReq = never, WorkerReq = never, PropsReq = never>(
      props:
        | InputProps<EffectfulContainerProps>
        | Effect.Effect<InputProps<EffectfulContainerProps>, Config.ConfigError, PropsReq>,
      impl: Effect.Effect<Shape & WorkerShape<WorkerReq>, Config.ConfigError, InitReq>,
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

  export type Instance<Shape = any> = Container & Shape;
}
