/**
 * Child-process isolation for framework DEV servers.
 *
 * Several framework toolchains require `cwd === project root` at dev-server
 * startup (SolidStart resolves the app from the cwd at config-load time,
 * Waku resolves its html shell and relative inputs from the cwd), so their
 * integrations `process.chdir` around startup — and SvelteKit's plugin
 * construction races when several projects load `@sveltejs/kit` graphs
 * concurrently in one process. None of that may run in a process hosting
 * MANY dev servers (the alchemy dev sidecar serves every website of a run):
 * concurrent chdir windows interleave, cwd-relative reads and spawns race,
 * and a transient chdir into a since-deleted temp root breaks unrelated
 * sites. The same class of problem production builds solved with
 * `core/BuildChild.ts` (and Next.js dev solved with its `next dev` child).
 *
 * Instead, each such dev server runs in a DEDICATED child process whose
 * working directory IS the project root — no chdir anywhere, no lock:
 *
 * - The **parent** ({@link runDevChild}) spawns the shared
 *   `core/DevChildRunner.ts` entry with `cwd = rootDir`, forwards the dev
 *   server's output, and resolves once the child prints the
 *   {@link DEV_CHILD_URL_REGEX} readiness marker. The child lives in the
 *   ambient Scope — the same lifetime an in-process dev handle has — and
 *   is stopped (SIGTERM, then SIGKILL) when that scope closes.
 * - The **child** (`DevChildRunner`) imports the framework-integration
 *   module (a bare specifier, self-resolved within this package), calls
 *   `make(config.makeOptions).dev(config.devOptions)`, prints the marker,
 *   and serves until SIGTERM interrupts it. The runner sets
 *   {@link DEV_CHILD_ENV_KEY} so the integration's `dev` takes its
 *   in-process path inside the child instead of recursing.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { FrameworkError, type FrameworkDevServer } from "./Framework.ts";

/**
 * Set on the spawned runner (and inherited by its descendants) so a
 * framework integration's `dev` runs the dev server IN-PROCESS when it is
 * already inside a dev child.
 */
export const DEV_CHILD_ENV_KEY = "ALCHEMY_FRAMEWORK_DEV_CHILD";

/** `true` when this process IS a spawned dev child (or one of its children). */
export const isInsideDevChild = (): boolean =>
  process.env[DEV_CHILD_ENV_KEY] === "1";

/** The runner's `argv[2]` payload (JSON). */
export interface DevChildPayload {
  /**
   * Framework-integration module specifier (e.g.
   * `"@alchemy.run/frontend-frameworks/waku"`). Imported by the runner —
   * a bare self-reference resolves within this package.
   */
  readonly module: string;
  /** JSON-serializable options handed to the module's `make(...)`. */
  readonly makeOptions: Record<string, unknown>;
  /** Options handed to the built service's `dev(...)`. */
  readonly devOptions: {
    readonly root: string;
    readonly port?: number | undefined;
    readonly host?: string | undefined;
  };
}

/** Marker line the child prints once the dev server is listening. */
export const DEV_CHILD_URL_REGEX =
  /<ALCHEMY_DEV_CHILD_URL>(.+)<\/ALCHEMY_DEV_CHILD_URL>/;

export const devChildUrlMarker = (url: string) =>
  `<ALCHEMY_DEV_CHILD_URL>${url}</ALCHEMY_DEV_CHILD_URL>`;

/**
 * `true` when `value` survives a JSON round-trip losslessly — i.e. it
 * contains no functions, symbols, bigints, class instances, or cycles a
 * child process could not reconstruct. Integrations use this to decide
 * whether their `make` options can cross the process boundary; when they
 * cannot (e.g. the e2e harness passes deploy-target VALUES or live vite
 * plugins), `dev` falls back to the in-process path.
 */
export const isJsonSerializable = (value: unknown): boolean => {
  const check = (input: unknown): boolean => {
    if (input === null) return true;
    switch (typeof input) {
      case "string":
      case "number":
      case "boolean":
      case "undefined":
        return true;
      case "object":
        break;
      default:
        return false;
    }
    if (Array.isArray(input)) return input.every(check);
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(input as Record<string, unknown>).every(check);
  };
  try {
    return check(value);
  } catch {
    // cyclic structures overflow the recursion — not serializable
    return false;
  }
};

/**
 * Node CLI flags that transparently strip TypeScript types, so the `.ts`
 * runner entry works when running from `src/` under plain Node (Bun handles
 * `.ts` natively). Mirrors `core/BuildChild.ts`.
 */
const transformTypesFlags = (): Array<string> => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26)
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];
};

export interface DevChildOptions {
  /** Framework name for error attribution (e.g. "solidstart", "waku"). */
  readonly framework: string;
  /** Bare module specifier the runner imports (see {@link DevChildPayload}). */
  readonly module: string;
  /**
   * `import.meta.url` of the CALLING framework module. The shared runner
   * entry is resolved as `../core/DevChildRunner.*` relative to it — which
   * lands on the stable entry file in both layouts
   * (`src/{fw}/X.ts` → `src/core/DevChildRunner.ts`,
   * `dist/_chunks/X.js` → `dist/core/DevChildRunner.js`).
   */
  readonly callerUrl: string;
  /** Project root — becomes the child's working directory. */
  readonly rootDir: string;
  /** JSON-serializable options for the module's `make(...)`. */
  readonly makeOptions: Record<string, unknown>;
  /** Options for the built service's `dev(...)`. */
  readonly devOptions: DevChildPayload["devOptions"];
}

interface DevChildHandle {
  readonly child: NodeChildProcess.ChildProcess;
  exited: boolean;
  output: string;
}

/**
 * Start a framework dev server in a dedicated child process with
 * `cwd = rootDir` and resolve with its local URL at readiness. The child
 * lives in the ambient Scope; closing it stops the dev server.
 */
export const runDevChild = (
  options: DevChildOptions,
): Effect.Effect<FrameworkDevServer, FrameworkError, Scope.Scope> =>
  Effect.gen(function* () {
    const fail =
      (message: string) =>
      (cause?: unknown): FrameworkError =>
        new FrameworkError({
          framework: options.framework,
          message,
          cause,
        });

    const entry = fileURLToPath(
      new URL(
        options.callerUrl.endsWith(".ts")
          ? "../core/DevChildRunner.ts"
          : "../core/DevChildRunner.js",
        options.callerUrl,
      ),
    );
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    const payload: DevChildPayload = {
      module: options.module,
      makeOptions: options.makeOptions,
      devOptions: options.devOptions,
    };
    const args = [
      ...(isBun ? ["run"] : entry.endsWith(".ts") ? transformTypesFlags() : []),
      entry,
      JSON.stringify(payload),
    ];

    const handle = yield* Effect.acquireRelease(
      Effect.try({
        try: (): DevChildHandle => {
          const child = NodeChildProcess.spawn(process.execPath, args, {
            cwd: options.rootDir,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
            env: { ...process.env, [DEV_CHILD_ENV_KEY]: "1" },
          });
          const handle: DevChildHandle = { child, exited: false, output: "" };
          child.once("exit", () => {
            handle.exited = true;
          });
          return handle;
        },
        catch: fail(
          `Failed to spawn the ${options.framework} dev child (${process.execPath})`,
        ),
      }),
      ({ child }) =>
        Effect.callback<void>((resume) => {
          if (child.exitCode !== null) {
            resume(Effect.void);
            return;
          }
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
          child.once("exit", () => {
            clearTimeout(killTimer);
            resume(Effect.void);
          });
          child.kill("SIGTERM");
        }),
    );

    const url = yield* Effect.callback<string, FrameworkError>((resume) => {
      const { child } = handle;
      let lineBuffer = "";
      let ready = false;
      const capture = (text: string) => {
        handle.output += text;
        if (handle.output.length > 65536) {
          handle.output = handle.output.slice(-32768);
        }
      };
      // Dev-server logs are re-emitted through the parent's own JS streams
      // (not `stdio: "inherit"`) so in-process capture (a test runner's log
      // buffer, the dev renderer) sees them.
      child.stdout?.on("data", (chunk: unknown) => {
        const text = String(chunk);
        capture(text);
        if (ready) {
          process.stdout.write(text);
          return;
        }
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(DEV_CHILD_URL_REGEX);
          if (match !== null) {
            ready = true;
            resume(Effect.succeed(match[1]));
          } else {
            process.stdout.write(`${line}\n`);
          }
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        const text = String(chunk);
        capture(text);
        process.stderr.write(text);
      });
      child.once("exit", (code) => {
        if (!ready) {
          resume(
            Effect.fail(
              fail(
                `The ${options.framework} dev child exited with code ${String(code)} before becoming ready:\n${handle.output.slice(-4000)}`,
              )(undefined),
            ),
          );
        }
      });
    });

    return { url };
  });
