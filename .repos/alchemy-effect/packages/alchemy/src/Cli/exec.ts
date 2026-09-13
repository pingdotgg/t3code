import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { watchImport } from "@alchemy.run/node-utils/watch-import";
import { trackBunImports } from "@alchemy.run/node-utils/watch-import-bun";
import { fileURLToPath } from "node:url";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { StackModuleLoader } from "../Alchemist/Session.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import { makeDevLogOpener } from "../Local/DevLog.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import { forwardSidecarLogs } from "../Local/RpcSpawner.ts";
import { TelemetryLive } from "../Telemetry/Layer.ts";
import { initialCwd } from "../Util/Node.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import * as Stacks from "../Alchemist/routes/stack.ts";
import { DEV_RELOAD_EXIT_CODE, DevOptions } from "./DevOptions.ts";
import { ConsoleLogLive } from "./GlobalLog.ts";
import { handleCliErrors, installShutdownFeedback } from "./commands/errors.ts";
import { renderApply, renderPlanning } from "./commands/render.ts";
import * as CliKit from "./CliKit/index.ts";
import { stackOutputsView } from "./components/view/StackOutputs.tsx";
import { selectCliServices } from "./selectCli.ts";

// Interactive dev/deploy runs use the Sigil progress UI; CI, redirected output,
// and other non-interactive terminals still select the append-only renderer.
// `ALCHEMY_TUI` remains the explicit override in either direction.
const services = Layer.mergeAll(
  Layer.provideMerge(
    Layer.mergeAll(selectCliServices(), CliKit.CliKitInteraction),
    CliKit.layer(),
  ),
  RpcProviderProxy.fromEnv(),
  Layer.succeed(ArtifactStore, createArtifactStore()),
  // Dev runs live in this exec child, not the `alchemy` CLI process, so
  // without this layer they'd export no telemetry at all. No root
  // `cli.dev` span though: dev remains alive across reloads, so a wrapping
  // span would not end (and export) until shutdown — plan/apply spans are the
  // trace roots instead.
  //
  // Telemetry is layered *on top of* the console logger so the OTLP logger
  // merges with it. As `mergeAll` siblings the last `CurrentLoggers` wins,
  // and telemetry would replace the console logger — every `Effect.log*`
  // (plan, apply progress, stack outputs) silently vanished from the
  // terminal whenever telemetry was enabled.
  Layer.provideMerge(TelemetryLive, ConsoleLogLive),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(AlchemyContextLive, ProfileStoreLive, CredentialsStoreLive),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
    ),
  ),
);

/** `alchemy dev` normally parks forever; set for single-pass runs (tests). */
const devOnce = Config.String("ALCHEMY_DEV_ONCE").pipe(
  Config.withDefault(""),
  Effect.map((value) => value === "1" || value === "true"),
);

const runDev = Effect.fn(function* (options: DevOptions) {
  const target = {
    entrypoint: options.main,
    stage: options.stage,
    profile: options.profile,
    envFile: Option.getOrUndefined(options.envFile),
  };
  const snapshot = yield* Stacks.plan({
    target,
    operation: "deploy",
    force: options.force,
    updateStateStore: true,
    dev: true,
  }).pipe(renderPlanning({ operation: "Dev", stage: options.stage }));
  const once = yield* devOnce;
  const applyPlan = Stacks.apply(snapshot).pipe(
    renderApply(snapshot.native, {
      stage: options.stage,
      dev: !once,
    }),
  );
  const result = yield* once
    ? applyPlan
    : applyPlan.pipe(
        Effect.catchCause((cause) =>
          Console.error(
            describeFailure(
              "apply",
              cause,
              "keeping dev alive so healthy resources keep serving",
            ),
          ).pipe(Effect.as(undefined)),
        ),
      );
  if (result !== undefined && once) {
    const kit = yield* CliKit.CliKit;
    yield* kit.output.print(stackOutputsView(result));
  }
  return once ? undefined : yield* Effect.never;
});

/**
 * Resolves with the files behind the next debounced change batch. The
 * listener detaches itself on delivery — `Effect.callback` only runs its
 * cleanup on interruption, so a listener left behind would fire once per
 * past generation on every later change.
 */
const nextChange = (watcher: {
  subscribe: (
    listener: (change: { paths: ReadonlySet<string> }) => void,
  ) => () => void;
}) =>
  Effect.callback<ReadonlySet<string>>((resume) => {
    const unsubscribe = watcher.subscribe(({ paths }) => {
      unsubscribe();
      resume(Effect.succeed(paths));
    });
    return Effect.sync(unsubscribe);
  });

const logReload = Effect.fn(function* (paths: ReadonlySet<string>) {
  const path = yield* Path.Path;
  yield* Effect.logInfo(
    `Reloading stack: changed ${[...paths]
      .map((file) => path.relative(initialCwd, file))
      .join(", ")}`,
  );
});

/**
 * Node: one process, many generations. The Oxc loader imports the stack graph
 * under a fresh namespace each time; a change to any file it loaded
 * interrupts the parked run (whose scope tears down the dev widget) and the
 * loop imports the next generation.
 */
const runNodeDevWatcher = Effect.fn(function* (options: DevOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Node reports real paths for loaded files (symlinked checkouts, macOS
  // `/tmp`), so the project root the graph is scoped to must be real too.
  // Scope to the invocation directory, not the entrypoint's directory: a
  // config under `infra/` commonly imports application code from `src/`.
  const entrypoint = yield* fs.realPath(path.resolve(options.main));
  const root = yield* fs.realPath(initialCwd);
  const nodeModules = `${path.sep}node_modules${path.sep}`;
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      watchImport<{ readonly default?: unknown }>(entrypoint, {
        parentURL: import.meta.url,
        shouldInvalidate: (url) => {
          if (!url.startsWith("file:")) return false;
          const file = fileURLToPath(url);
          const relative = path.relative(root, file);
          return (
            !file.includes(nodeModules) &&
            (relative === "" ||
              (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)))
          );
        },
      }),
    ),
    (watcher) => Effect.promise(() => watcher.close()),
  ).pipe(
    Effect.flatMap((watcher) => {
      const generation = devKeepAlive(runDev(options)).pipe(
        Effect.provideService(StackModuleLoader, {
          import: () => watcher.import().then(({ value }) => value),
        }),
        Effect.scoped,
      );
      return Effect.forever(
        Effect.raceFirst(generation, nextChange(watcher)).pipe(
          Effect.flatMap((paths) =>
            paths === undefined ? Effect.void : logReload(paths),
          ),
        ),
      );
    }),
  );
});

/**
 * Bun: one process per generation. Bun cannot evict evaluated modules, so the
 * tracker only records which project files the stack graph loads; the first
 * change to one of them logs, lets the generation scope tear down the dev
 * widget, and exits with DEV_RELOAD_EXIT_CODE for the supervisor to respawn.
 */
const runBunDevWatcher = (options: DevOptions) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      // Match Node's project-wide graph: the stack entrypoint may live in a
      // subdirectory while importing sibling source trees.
      trackBunImports({ root: initialCwd }),
    ),
    (tracker) => Effect.promise(() => tracker.close()),
  ).pipe(
    Effect.flatMap((tracker) =>
      Effect.raceFirst(
        devKeepAlive(runDev(options)).pipe(Effect.scoped),
        nextChange(tracker),
      ),
    ),
    Effect.flatMap((paths) =>
      paths === undefined
        ? Effect.void
        : logReload(paths).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = DEV_RELOAD_EXIT_CODE;
              }),
            ),
          ),
    ),
  );

/**
 * A run that ended by itself with nothing but interruptions in its cause was
 * cancelled from the inside — a provider or engine race, never the user —
 * so it must be reported like any other failure. Ctrl+C is different: it
 * interrupts the fiber running this code, so `catchCause` never gets to
 * park it (a parked `Effect.never` is interrupted straight away too).
 */
const describeFailure = (
  what: string,
  cause: Cause.Cause<unknown>,
  next: string,
) =>
  Cause.hasInterruptsOnly(cause)
    ? `alchemy dev: ${what} was interrupted internally (a bug in a provider or the engine — please report it with the trace below); ${next}.\n${Cause.pretty(cause)}`
    : `alchemy dev: ${what} failed; ${next}.\n${Cause.pretty(cause)}`;

// A mid-edit import or planning failure must keep the watch process alive so
// the next save can restart it. Ctrl+C still tears the run down.
export const devKeepAlive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Console.error(
        describeFailure(
          "run",
          cause,
          "waiting for the next file change to retry",
        ),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  );

const makeExec = () => {
  const options = Schema.decodeSync(DevOptions)(
    JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
  );
  return Effect.gen(function* () {
    yield* installShutdownFeedback;
    // Subscribe to the spawner's sidecar log stream BEFORE the stack runs:
    // this process owns the terminal renderer, so sidecar output printed
    // here lands in chronological order with the run's own lines instead of
    // racing the shared tty. No-op outside dev. The mixed tail is also teed
    // to log/{stage}/{timestamp}.log; per-resource output lands in
    // log/{stage}/{fqn…}/ via the local providers.
    const devLog = yield* (yield* makeDevLogOpener)(options.stage);
    yield* forwardSidecarLogs((entry) =>
      devLog.writeLine(`[${entry.channel}] ${entry.line}`),
    );
    // Single-pass runs park nothing. Otherwise Node reloads the stack graph in
    // this process; Bun exits for the supervisor to respawn (see above).
    return yield* (yield* devOnce)
      ? devKeepAlive(runDev(options))
      : process.versions.bun !== undefined
        ? runBunDevWatcher(options)
        : runNodeDevWatcher(options);
  }).pipe(Effect.provide(services), Effect.scoped, handleCliErrors);
};

/** Fully wired sidecar CLI program. */
export const exec: () => Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof makeExec>>
> = makeExec;
