/**
 * Shared child-process ENTRY for framework dev servers.
 *
 * Executed only as a spawned process by `runDevChild` (`DevChild.ts`) —
 * never imported. `argv[2]` carries the JSON {@link DevChildPayload}: the
 * framework-integration module specifier, the options for its `make(...)`,
 * and the dev options. The process's working directory IS the project root
 * (the parent spawns it with `cwd = rootDir`), so toolchains that resolve
 * from the cwd — or `process.chdir` around startup — are isolated here and
 * never touch the process hosting other sites' dev servers.
 *
 * The parent sets `ALCHEMY_FRAMEWORK_DEV_CHILD=1` in this process's env, so
 * the integration's `dev` takes its in-process path instead of recursing
 * into another child.
 *
 * The runner prints the dev server's URL wrapped in the readiness marker,
 * then serves until SIGTERM/SIGINT aborts the main fiber (closing the scope
 * that owns the dev server).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { devChildUrlMarker, type DevChildPayload } from "./DevChild.ts";
import type { FrameworkDevServer } from "./Framework.ts";

/** The structural slice of a framework-integration module the runner drives. */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly dev: (options: {
        readonly root?: string;
        readonly port?: number;
        readonly host?: string;
      }) => Effect.Effect<FrameworkDevServer, unknown, Scope.Scope>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

const payload = JSON.parse(process.argv[2] ?? "{}") as DevChildPayload;

const program = Effect.scoped(
  Effect.gen(function* () {
    const module = (yield* Effect.promise(
      () => import(payload.module),
    )) as Partial<FrameworkModule>;
    if (typeof module.make !== "function") {
      return yield* Effect.die(
        new Error(
          `Dev child module ${payload.module} does not export a make function`,
        ),
      );
    }
    const service = yield* module.make(payload.makeOptions);
    const { url } = yield* service.dev(payload.devOptions);
    // Through the real stdout: the parent scans lines for this marker.
    process.stdout.write(`${devChildUrlMarker(url)}\n`);
    // Serve until the parent stops the process; the abort below interrupts
    // this fiber and the enclosing scope closes the dev server.
    return yield* Effect.never;
  }),
).pipe(Effect.provide(NodeServices.layer));

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

void Effect.runPromiseExit(program, { signal: controller.signal }).then(
  (exit) => {
    const code = Exit.match(exit, {
      onSuccess: () => 0,
      onFailure: (cause) => {
        if (Cause.hasInterrupts(cause)) {
          return 0;
        }
        console.error(cause);
        return 1;
      },
    });
    // The macrotask hop lets buffered stdout/stderr drain before exiting.
    setTimeout(() => process.exit(code), 0);
  },
);
