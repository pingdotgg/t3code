import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeNet from "node:net";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as LocalProvider from "../Local/LocalProvider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { initialCwd } from "../Util/Node.ts";
import { sha256Object } from "../Util/sha256.ts";

/**
 * The structural slice of a framework-integration module
 * (`@alchemy.run/frontend-frameworks/nuxt`, `@alchemy.run/frontend-frameworks/astro`, ...) this resource
 * drives. Typed structurally so alchemy carries no dependency on
 * `@distilled.cloud/framework-core` — the *project's* install is always the
 * one loaded. Requirement channels are erased (the module is loaded
 * dynamically, so its effects are typed post-hoc): `build` is
 * requirement-free and `dev` runs in the caller's ambient Scope.
 */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly build: (options?: {
        readonly root?: string;
        readonly env?: Record<string, string>;
      }) => Effect.Effect<FrameworkBuildOutputSlice, unknown>;
      readonly dev: (options?: {
        readonly root?: string;
        readonly port?: number;
        readonly host?: string;
      }) => Effect.Effect<{ readonly url: string }, unknown>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

/** The structural slice of framework-core's `BuildOutput` this resource reads. */
interface FrameworkBuildOutputSlice {
  readonly distDirectory?: string | undefined;
  readonly clientDirectory: string | undefined;
  readonly serverModules: Array<{ readonly name: string }> | undefined;
}

export class FrameworkServerError extends Data.TaggedError(
  "FrameworkServerError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Drops `undefined`-valued entries from {@link ServerProps.env}. */
const definedEnv = (
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );

/**
 * Options for the local dev server that runs a framework site under
 * `alchemy dev`.
 *
 * Use `{ mode: "external" }` to skip starting a dev server entirely —
 * useful when an external dev server (e.g. one you run yourself in
 * another terminal) is serving the site instead.
 */
export type ServerDevProps =
  | {
      /**
       * Run the framework's own dev server locally (the default).
       * @default "server"
       */
      mode?: "server";
      /**
       * Host the dev server binds to. Defaults to the framework's own
       * choice (localhost).
       */
      host?: string;
      /**
       * Preferred port for the dev server. Defaults to an ephemeral port.
       * If the port is unavailable, the next free port is used unless
       * {@link strictPort} is `true`.
       */
      port?: number;
      /**
       * When `true`, fail instead of falling back to another port if
       * {@link port} is already in use.
       * @default false
       */
      strictPort?: boolean;
    }
  | {
      /**
       * Don't start a dev server; an external dev server is running instead.
       */
      mode: "external";
      /**
       * URL the external dev server is reachable at, if applicable.
       * This will be returned as the `url` attribute of the Server resource.
       */
      url?: string;
    };

export interface ServerProps {
  /**
   * Module specifier of the framework-integration package that implements
   * the build and dev server (e.g. `"@alchemy.run/frontend-frameworks/nuxt"`). Must be
   * installed in your project — it is loaded dynamically at deploy time and
   * drives your project's own framework toolchain.
   */
  framework: string;
  /**
   * Project root directory (the directory containing the framework config),
   * relative to the process working directory.
   * @default "."
   */
  root?: string;
  /**
   * The deploy target the build is produced for: a module specifier
   * resolved from your project's `node_modules`
   * (e.g. `"@alchemy.run/frontend-frameworks/nuxt/aws"`).
   */
  target: string;
  /**
   * Framework-integration options forwarded to the module's `make()`
   * (e.g. `{ nuxt: { ... } }` config overrides). Must be JSON-serializable —
   * the value participates in the memo hash and is persisted in state.
   */
  options?: Record<string, unknown>;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`. See {@link ServerDevProps}.
   */
  dev?: ServerDevProps;
  /**
   * Environment variables for the framework server. On deploy the
   * composite sets these on the Lambda; during `alchemy dev` they are
   * applied to the dev server's process environment (the dev sidecar and
   * any child it spawns) so server code reads the same values in both
   * modes. Changing a value restarts the dev server.
   *
   * Entries whose value is `undefined` are dropped — this lets website
   * composites forward optional values (e.g. an `Output` service URL that
   * resolves to `undefined`) without filtering first.
   */
  env?: Record<string, string | undefined>;
  /**
   * Controls which files are hashed to decide whether the build should
   * re-run. By default every non-gitignored file in the root is hashed,
   * plus the nearest lockfile. Set `false` to rebuild on every deploy.
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface Server extends Resource<
  "Website.Server",
  ServerProps,
  {
    /**
     * Root output directory of the build (e.g. `.output`), relative to the
     * process's initial working directory. `undefined` in dev mode (no
     * production build runs).
     */
    distDir: string | undefined;
    /**
     * Static-assets directory of the build (prerendered pages included),
     * relative to the initial working directory. `undefined` when the build
     * produced no client assets, and in dev mode.
     */
    clientDir: string | undefined;
    /**
     * The server entry module on disk (e.g. `.output/server/index.mjs`),
     * relative to the initial working directory. `undefined` for
     * assets-only builds, and in dev mode.
     */
    serverEntry: string | undefined;
    /**
     * The framework dev server's local URL (e.g. `http://localhost:3000`)
     * during `alchemy dev`. `undefined` on deploys.
     */
    url: string | undefined;
    hash: {
      /**
       * Hash of the input files (plus framework/target/options) that
       * produced this build. `undefined` in dev mode.
       */
      input: string | undefined;
      /**
       * Hash of the build output files. `undefined` in dev mode.
       */
      output: string | undefined;
    };
  }
> {}

/**
 * The framework toolchain half of a website: on `alchemy deploy` it
 * runs the framework's production build with a platform deploy target and
 * tracks the on-disk output in state; on `alchemy dev` it runs the
 * framework's OWN dev server (native HMR via the framework's kit) in the
 * dev sidecar and exposes its local URL. Shared by AWS, Fly, Hetzner, and
 * Railway website composites.
 *
 * The framework package and the target module are loaded from *your*
 * project's `node_modules`, so your project's framework version drives the
 * build. Build inputs are content-hashed so an unchanged project skips the
 * rebuild entirely.
 *
 * ### Building Frameworks
 * **Example:** Nuxt For AWS Lambda
 * ```typescript
 * const server = yield* Server("Server", {
 *   framework: "@alchemy.run/frontend-frameworks/nuxt",
 *   target: "@alchemy.run/frontend-frameworks/nuxt/aws",
 *   root: "./app",
 * });
 * // deploy: server.serverEntry -> .output/server/index.mjs (Lambda handler)
 * //         server.clientDir   -> .output/public (static assets for the CDN)
 * // dev:    server.url         -> http://localhost:<port> (framework HMR server)
 * ```
 *
 * @resource
 */
export const Server = Resource<Server>("Website.Server", {
  aliases: ["AWS.Website.Server", "AWS.Website.FrameworkBuild"],
});

const importFrameworkModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<Partial<FrameworkModule>>,
    catch: (cause) =>
      new FrameworkServerError({
        framework: specifier,
        message:
          `Failed to import the framework integration "${specifier}". ` +
          "It must be installed in your project (it is loaded dynamically at deploy time).",
        cause,
      }),
  }).pipe(
    Effect.flatMap((module_) =>
      typeof module_.make === "function"
        ? Effect.succeed(module_ as FrameworkModule)
        : Effect.fail(
            new FrameworkServerError({
              framework: specifier,
              message: `"${specifier}" does not export the framework-integration contract (a "make" function)`,
            }),
          ),
    ),
  );

const makeFramework = (props: ServerProps, root: string) =>
  importFrameworkModule(props.framework).pipe(
    Effect.flatMap((module_) =>
      Effect.mapError(
        module_.make({
          ...props.options,
          root,
          target: props.target,
        }),
        (cause) =>
          new FrameworkServerError({
            framework: props.framework,
            message: "Failed to initialize the framework integration",
            cause,
          }),
      ),
    ),
  );

export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    live: ServerProviderLive,
    local: ServerProviderLocal,
  });

export const ServerProviderLive = () =>
  Provider.effect(
    Server,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const runBuild = Effect.fn(function* (props: ServerProps) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const service = yield* makeFramework(props, root);
        return yield* Effect.mapError(
          service.build({ root, env: definedEnv(props.env) }),
          (cause) =>
            new FrameworkServerError({
              framework: props.framework,
              message: `The ${props.framework} build failed`,
              cause,
            }),
        );
      });

      const hashInput = (props: ServerProps, root: string) =>
        hashDirectory({
          cwd: root,
          memo:
            props.memo === true ||
            props.memo === undefined ||
            props.memo === false
              ? {}
              : props.memo,
        }).pipe(
          Effect.flatMap((files) =>
            sha256Object({
              files,
              framework: props.framework,
              target: props.target,
              options: props.options,
            }),
          ),
        );

      const makeOutput = Effect.fn(function* (
        props: ServerProps,
        built: FrameworkBuildOutputSlice,
      ) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const distDir = built.distDirectory ?? path.join(root, "dist");
        if (!(yield* fs.exists(distDir))) {
          return yield* Effect.fail(
            new FrameworkServerError({
              framework: props.framework,
              message: `The build produced no output directory at ${distDir}`,
            }),
          );
        }
        const entryName = built.serverModules?.[0]?.name;
        return {
          distDir: path.relative(initialCwd, distDir),
          clientDir:
            built.clientDirectory !== undefined
              ? path.relative(initialCwd, built.clientDirectory)
              : undefined,
          serverEntry:
            entryName !== undefined
              ? path.relative(initialCwd, path.join(distDir, entryName))
              : undefined,
          url: undefined,
          hash:
            props.memo === false
              ? { input: undefined, output: undefined }
              : yield* Effect.all(
                  {
                    input: hashInput(props, root),
                    output: hashDirectory({
                      cwd: distDir,
                      memo: { exclude: [], lockfile: false },
                    }),
                  },
                  { concurrency: "unbounded" },
                ),
        };
      });

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.memo === false || !output.hash.input || !output.hash.output)
            return { action: "update" };
          if (havePropsChanged(olds, news)) return { action: "update" };
          const root = path.resolve(initialCwd, news.root ?? ".");
          // Cheap check: same inputs + output still on disk with the same
          // content hash -> noop without re-running the build.
          const input = yield* hashInput(news, root);
          if (input !== output.hash.input) return { action: "update" };
          if (output.distDir === undefined) return { action: "update" };
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return { action: "update" };
          const outHash = yield* hashDirectory({
            cwd: distDir,
            memo: { exclude: [], lockfile: false },
          });
          return {
            action: Equal.equals(outHash, output.hash.output)
              ? "noop"
              : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const built = yield* runBuild(news);
          return yield* makeOutput(news, built);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.distDir === undefined) return;
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return;
          yield* fs.remove(distDir, { recursive: true });
        }),
      };
    }),
  );

/**
 * Try to bind `port` on `host`; resolves `true` when the port is free.
 * The listener is closed immediately — the port is only observed
 * available, not reserved, so the caller should bind promptly and the
 * framework still handles the (tiny) race window itself.
 */
const isPortFree = (port: number, host: string) =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, host, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
  });

/**
 * Resolve the dev server's port from the `dev` props: probe the preferred
 * port and either fail (`strictPort`) or walk forward to the next free
 * port when it is taken.
 */
const resolveDevPort = Effect.fn(function* (options: {
  readonly framework: string;
  readonly port: number;
  readonly host: string;
  readonly strictPort: boolean;
}) {
  const { framework, port, host, strictPort } = options;
  if (yield* isPortFree(port, host)) return port;
  if (strictPort) {
    return yield* Effect.fail(
      new FrameworkServerError({
        framework,
        message: `Port ${port} is already in use and \`dev.strictPort\` is set`,
      }),
    );
  }
  for (let candidate = port + 1; candidate <= port + 100; candidate++) {
    if (yield* isPortFree(candidate, host)) return candidate;
  }
  return yield* Effect.fail(
    new FrameworkServerError({
      framework,
      message: `No free port found between ${port} and ${port + 100}`,
    }),
  );
});

/**
 * A framework dev server may advertise its *bind* address — nuxt echoes the
 * host it was told to listen on, so a Router-attached site (which binds
 * `0.0.0.0` to be reachable from the emulator container) reports
 * `http://0.0.0.0:{port}/`. The unspecified address is not a connectable
 * host: normalize it to `localhost` for the `url` attribute (browser links,
 * Router dev routing, the emulated CloudFront edge dialing the origin). The
 * server itself still listens on every interface.
 */
const normalizeAdvertisedUrl = (url: string) =>
  url.replace(
    /^(https?:\/\/)(?:0\.0\.0\.0|\[::\]|\[0+(?::0+){7}\])(?=[:/]|$)/,
    "$1localhost",
  );

/**
 * The `alchemy dev` variant: runs the framework's own dev server (native
 * HMR through the framework's kit — nuxt, astro, ...) inside the dev
 * sidecar, so it survives user-code hot reloads. Restarts when the
 * framework/target/root/options config changes.
 */
export const ServerProviderLocal = () =>
  LocalProvider.make(
    Server,
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./ServerLocal.ts" : "./ServerLocal.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      return {
        start: Effect.fn(function* ({ news: props }) {
          // External mode: an external dev server (run out-of-band by the
          // user) serves the site — don't import the framework or spawn
          // anything, just surface the external URL as the attribute.
          if (props.dev?.mode === "external") {
            return {
              distDir: undefined,
              clientDir: undefined,
              serverEntry: undefined,
              url: props.dev.url,
              hash: { input: undefined, output: undefined },
            };
          }
          const dev = props.dev;
          const root = path.resolve(initialCwd, props.root ?? ".");
          // Dev/live env parity: the composite sets these on the Lambda on
          // deploy; in dev the framework server runs inside the sidecar
          // (or as its child — `next dev`), so the sidecar's process env
          // is what SSR code reads. `env` is part of the restart surface,
          // so a changed value restarts the dev server with the new
          // environment. Values are not unset on stop: sibling dev servers
          // share the process, so clearing could clobber their keys.
          if (props.env !== undefined) {
            yield* Effect.sync(() => {
              for (const [key, value] of Object.entries(props.env!)) {
                if (value === undefined) continue;
                process.env[key] = String(value);
              }
            });
          }
          const service = yield* makeFramework(props, root).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          // Resolve the port BEFORE handing off to the framework: probe
          // the preferred port, fail on `strictPort`, otherwise walk
          // forward to the next free port. Without a preferred port the
          // framework picks its own (ephemeral) port.
          const port =
            dev?.port !== undefined
              ? yield* resolveDevPort({
                  framework: props.framework,
                  port: dev.port,
                  host: dev.host ?? "127.0.0.1",
                  strictPort: dev.strictPort ?? false,
                })
              : undefined;
          // `dev` is scoped: the server lives in the instance scope the
          // LocalProvider helper provides and is torn down on
          // restart/delete. It resolves at readiness with the local URL.
          const { url } = yield* Effect.mapError(
            service.dev({ root, port, host: dev?.host }),
            (cause) =>
              new FrameworkServerError({
                framework: props.framework,
                message: `The ${props.framework} dev server failed to start`,
                cause,
              }),
          );
          return {
            distDir: undefined,
            clientDir: undefined,
            serverEntry: undefined,
            url: normalizeAdvertisedUrl(url),
            hash: { input: undefined, output: undefined },
          };
        }),
      } satisfies LocalProvider.LocalProviderSpec<Server>;
    }),
  );
