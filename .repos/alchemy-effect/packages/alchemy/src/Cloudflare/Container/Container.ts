import type * as cf from "@cloudflare/workers-types";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import * as Server from "../../Server/index.ts";
import type { Fetcher } from "../Fetcher.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";
import { bindContainer } from "./ContainerBinding.ts";

export const ContainerTypeId = "Cloudflare.Container";
export type ContainerTypeId = typeof ContainerTypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ContainerTypeId;

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ContainerStartupOptions extends cf.ContainerStartupOptions {}

export interface ContainerProps extends ContainerApplicationProps {
  main: string;
}

export type Container = {
  get running(): Effect.Effect<boolean>;
  start(options?: ContainerStartupOptions): Effect.Effect<void>;
  monitor(): Effect.Effect<void, ContainerError>;
  destroy(error?: any): Effect.Effect<void>;
  signal(signo: number): Effect.Effect<void>;
  getTcpPort(port: number): Effect.Effect<Fetcher>;
  setInactivityTimeout(durationMs: number | bigint): Effect.Effect<void>;
  interceptOutboundHttp(addr: string, binding: Fetcher): Effect.Effect<void>;
  interceptAllOutboundHttp(binding: Fetcher): Effect.Effect<void>;
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
 * See the {@link https://alchemy.run/concepts/platform | Platform
 * concept} page for how this fits into the async / effect / layer
 * progression.
 *
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
 * // src/Sandbox.ts
 * export class Sandbox extends Cloudflare.Container<
 *   Sandbox,
 *   {
 *     exec: (cmd: string) => Effect.Effect<{
 *       exitCode: number;
 *       stdout: string;
 *       stderr: string;
 *     }>;
 *   }
 * >()(
 *   "Sandbox",
 *   { main: import.meta.filename },
 * ) {}
 * ```
 *
 * @example Container .make()
 * ```typescript
 * // src/Sandbox.runtime.ts
 * export default Sandbox.make(
 *   Effect.gen(function* () {
 *     const cp = yield* ChildProcessSpawner;
 *
 *     return Sandbox.of({
 *       exec: (cmd) =>
 *         cp.spawn(ChildProcess.make(cmd, { shell: true })).pipe(
 *           Effect.map(({ exitCode, stdout, stderr }) => ({
 *             exitCode, stdout, stderr,
 *           })),
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
 * @section Configuration
 * The props object accepts `main` (entrypoint file), `instanceType`
 * (compute size), `runtime` (`"bun"` or `"node"`), and
 * `observability` settings. Use `Stack.useSync` to read the
 * surrounding stack at declaration time and pick a beefier
 * `instanceType` in prod while keeping the cheap `dev` instance for
 * preview environments.
 *
 * @example Stage-dependent configuration
 * ```typescript
 * export class Sandbox extends Cloudflare.Container<Sandbox>()(
 *   "Sandbox",
 *   Stack.useSync((stack) => ({
 *     main: import.meta.filename,
 *     instanceType: stack.stage === "prod" ? "standard-1" : "dev",
 *     observability: { logs: { enabled: true } },
 *   })),
 * ) {}
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
 * Use `Cloudflare.Container.bind(Sandbox)` in the **outer** init
 * phase of a Durable Object — only the class is imported, so the
 * DO bundle stays tiny. Then `Cloudflare.start(sandbox)` in the
 * **inner** per-instance phase ensures the container is running
 * and gives you a typed handle that exposes every method declared
 * on the container's shape **plus** a `getTcpPort` helper.
 *
 * @example Binding and starting a container from a DO
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     // OUTER (init): only the class is referenced — the runtime
 *     // implementation in `Sandbox.runtime.ts` is tree-shaken out
 *     // of this DO's bundle.
 *     const sandbox = yield* Cloudflare.Container.bind(Sandbox);
 *
 *     return Effect.gen(function* () {
 *       // INNER (per-instance): start the container and expose RPC.
 *       const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
 *
 *       return {
 *         exec: (cmd: string) => container.exec(cmd),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Starting from a Durable Object
 * Use `Cloudflare.Container.bind` in the outer init phase to bind
 * the container class, then `Cloudflare.start` in the inner
 * per-instance phase to start it. Because the DO only imports the
 * class, the runtime implementation is completely excluded from the
 * DO's bundle.
 *
 * @example Binding and starting a container
 * ```typescript
 * // init (outer Effect) — only imports the class
 * const sandbox = yield* Cloudflare.Container.bind(Sandbox);
 *
 * // per-instance (inner Effect)
 * return Effect.gen(function* () {
 *   const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
 *
 *   return {
 *     exec: (cmd: string) => container.exec(cmd),
 *   };
 * });
 * ```
 *
 * @section HTTP Requests to Container Ports
 * Use `getTcpPort` to get a `fetch` handle for a specific port on
 * the running container. This lets you make HTTP requests to
 * servers running inside the container process.
 *
 * @example Fetching from a container port
 * ```typescript
 * const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
 * const { fetch } = yield* container.getTcpPort(3000);
 *
 * const response = yield* fetch(
 *   HttpClientRequest.get("http://container/health"),
 * );
 * ```
 */
export const Container: Platform<
  ContainerApplication,
  ContainerServices,
  ContainerShape,
  Server.ProcessContext,
  Container
> & {
  bind: typeof bindContainer;
} = Platform(
  "Cloudflare.Container",
  {
    createRuntimeContext: (id: string): Server.ProcessContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      const serve = <Req = never>(handler: HttpEffect<Req>) =>
        Effect.sync(() => {
          runners.push(
            Effect.gen(function* () {
              const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (httpServer) {
                yield* httpServer.serve(handler);
                yield* Effect.never;
              } else {
                // this should only happen at plantime, validate?
              }
            }).pipe(Effect.orDie),
          );
        });

      return {
        Type: ContainerTypeId,
        LogicalId: id,
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            env[key] = output.pipe(
              Output.map((value) => JSON.stringify(value)),
            );
            return key;
          }),
        get: <T>(key: string) =>
          Config.string(key)

            .pipe(
              Effect.flatMap((value) =>
                Effect.try({
                  try: () => JSON.parse(value) as T,
                  catch: (error) => error as Error,
                }),
              ),
              Effect.catch((cause) =>
                Effect.die(
                  new Error(`Failed to get environment variable: ${key}`, {
                    cause,
                  }),
                ),
              ),
            ),
        run: ((effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          })) as unknown as Server.ProcessContext["run"],
        serve,
        exports: Effect.sync(() => ({
          default: Effect.all(
            runners.map((eff) =>
              Effect.forever(
                eff.pipe(
                  // Log and ignore errors (daemon mode, it should just re-run)
                  Effect.tapError((err) => Effect.logError(err)),
                  Effect.ignore,
                  // TODO(sam): ignore cause? for now, let that actually kill the server
                  // Effect.ignoreCause
                ),
              ),
            ),
            {
              concurrency: "unbounded",
            },
          ),
        })),
      } as Server.ProcessContext;
    },
  },
  {
    bind: bindContainer,
  },
);
