// Workflows in the running server: definitions come from one file the operator names, and
// without one nothing here starts. The file can change while the server runs: a version of it
// that verifies replaces the engine, and one that does not leaves the last good one running.
import * as NodeURL from "node:url";

import type { WorkflowDefinitionProblem, WorkflowDefinitionSource } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { engineTag, text, type WorkflowDefinition } from "./workflow.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowAgentThreads from "./WorkflowAgentThreads.ts";
import * as Workflows from "./Workflows.ts";

/** The file whose default export is the list of workflow definitions to register. */
const definitionsModule = Config.String("T3CODE_WORKFLOWS").pipe(Config.option);

// An editor saves in several writes, and a save from here is followed by its own file event.
const RELOAD_SETTLE = "300 millis";

export class WorkflowDefinitionsLoadError extends Schema.TaggedError<WorkflowDefinitionsLoadError>()(
  "WorkflowDefinitionsLoadError",
  { module: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not load workflow definitions from ${this.module}.`;
  }
}

/** The definitions file of this server, for a person to read and change. */
export class WorkflowDefinitions extends Context.Service<
  WorkflowDefinitions,
  {
    /** The file as it is on disk now. Nothing, on a server that names no definitions file. */
    readonly read: Effect.Effect<WorkflowDefinitionSource | null>;
    /**
     * Verify `source`, and when nothing is wrong with it write it to the file and run it from
     * now on. Returns what is wrong; nothing was written or changed when that is not empty.
     */
    readonly save: (source: string) => Effect.Effect<ReadonlyArray<WorkflowDefinitionProblem>>;
  }
>()("t3/workflows/WorkflowRuntime/WorkflowDefinitions") {}

const isDefinition = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkflowDefinition).name === "string" &&
  typeof (value as WorkflowDefinition).version === "number" &&
  typeof (value as WorkflowDefinition).body === "function";

/**
 * A definitions module exports its workflows, or a function from the author API to them. `load`
 * tells one loading of a file from the next: Node keeps a module by its address, so the same
 * address would give back the file as it was the first time.
 */
export const loadDefinitions = Effect.fn("WorkflowRuntime.loadDefinitions")(function* (
  module: string,
  load = 0,
) {
  const path = yield* Path.Path;
  const url = NodeURL.pathToFileURL(path.resolve(module)).href + (load === 0 ? "" : `?${load}`);
  const definitions = yield* Effect.tryPromise({
    try: async () => {
      const loaded = (await import(url)) as { readonly default?: unknown };
      return typeof loaded.default === "function"
        ? ((await loaded.default(await import("./api.ts"))) as unknown)
        : loaded.default;
    },
    catch: (cause) => new WorkflowDefinitionsLoadError({ module, cause }),
  });
  if (!Array.isArray(definitions) || !definitions.every(isDefinition)) {
    return yield* new WorkflowDefinitionsLoadError({
      module,
      cause: "It does not export an array of workflow definitions, or a function that returns one.",
    });
  }
  return definitions as ReadonlyArray<WorkflowDefinition>;
});

/** What a load error says, with the line of `file` it points at when it names one. */
const loadProblem = (
  error: WorkflowDefinitionsLoadError,
  file: string,
): WorkflowDefinitionProblem => {
  const cause = error.cause;
  const stack = cause instanceof Error ? (cause.stack ?? "") : "";
  const name = file.split(/[\\/]/).at(-1) ?? file;
  // Node names the place as `file:///…/name.ts:12` or `…/name.ts:12:5`, with a `?n` when reloaded.
  const at = stack.split(name).find((rest) => /^(\?\d+)?:\d+/.test(rest));
  const line = at === undefined ? undefined : Number(/^(?:\?\d+)?:(\d+)/.exec(at)?.[1]);
  return { message: text(cause), ...(line === undefined ? {} : { line }) };
};

/** What is wrong with definitions that loaded, given the runs that have not ended. */
const definitionProblems = (
  definitions: ReadonlyArray<WorkflowDefinition>,
  unfinished: ReadonlyArray<{ readonly workflow: string; readonly version: number }>,
): ReadonlyArray<WorkflowDefinitionProblem> => {
  const tags = definitions.map(engineTag);
  const twice = [...new Set(tags.filter((tag, index) => tags.indexOf(tag) !== index))];
  const waiting = new Map<string, number>();
  for (const run of unfinished) {
    const tag = engineTag({ name: run.workflow, version: run.version });
    if (!tags.includes(tag)) waiting.set(tag, (waiting.get(tag) ?? 0) + 1);
  }
  return [
    ...twice.map((tag) => ({
      message: `${tag} is defined twice. A workflow's name and version name one body.`,
    })),
    ...[...waiting].map(([tag, runs]) => ({
      message: `${tag} is gone from the file, and ${runs} of its runs ${runs === 1 ? "has" : "have"} not ended. Keep that version until they end, or cancel them first.`,
    })),
  ];
};

/**
 * `engine` gives the layer that runs a set of definitions. It is asked for only once a
 * definitions file is named, since the engine's modules are not worth loading without one.
 */
export const make = Effect.fn("WorkflowRuntime.make")(function* <E, R>(
  engine: Effect.Effect<
    (definitions: ReadonlyArray<WorkflowDefinition>) => Layer.Layer<Workflows.Workflows, E, R>
  >,
) {
  const module = yield* definitionsModule;
  if (Option.isNone(module)) {
    return Context.make(Workflows.Workflows, Workflows.disabled).pipe(
      Context.add(
        WorkflowDefinitions,
        WorkflowDefinitions.of({
          read: Effect.succeed(null),
          save: Effect.fn("WorkflowDefinitions.save")(function* () {
            return yield* Effect.succeed([
              { message: "This server names no definitions file. Start it with T3CODE_WORKFLOWS." },
            ]);
          }),
        }),
      ),
    );
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(module.value);
  const outer = yield* Scope.Scope;
  const services = yield* Effect.context<R | Path.Path>();
  const layerEngine = yield* engine;

  // One reload at a time, and callers during one wait for the engine that comes out of it.
  const lock = yield* Semaphore.make(1);
  let ready = Deferred.makeUnsafe<Workflows.Workflows["Service"]>();
  let engineScope: Scope.Closeable | undefined;
  let running: ReadonlyArray<WorkflowDefinition> | undefined;
  let loaded: string | undefined;
  let loads = 0;
  const state = yield* SubscriptionRef.make<{ revision: number; problem: string | null }>({
    revision: 0,
    problem: null,
  });
  const report = (problem: string | null) =>
    SubscriptionRef.update(state, (current) => ({ revision: current.revision + 1, problem }));

  const boot = Effect.fn("WorkflowRuntime.boot")(function* (
    definitions: ReadonlyArray<WorkflowDefinition>,
  ) {
    const next = Deferred.makeUnsafe<Workflows.Workflows["Service"]>();
    ready = next;
    if (engineScope !== undefined) yield* Scope.close(engineScope, Exit.void);
    engineScope = yield* Scope.fork(outer);
    const built = yield* Layer.buildWithScope(layerEngine(definitions), engineScope).pipe(
      Effect.provideContext(services),
      Effect.exit,
    );
    if (Exit.isFailure(built)) {
      // Nobody may be left waiting on an engine that never came up.
      running = undefined;
      yield* Deferred.succeed(next, Workflows.disabled);
      return `The workflow engine did not start: ${text(Cause.squash(built.cause))}`;
    }
    running = definitions;
    yield* Deferred.succeed(next, Context.get(built.value, Workflows.Workflows));
    yield* Effect.logInfo("Workflows registered", {
      module: file,
      workflows: definitions.map(engineTag),
    });
    return null;
  });

  const unfinished = Effect.suspend(() =>
    running === undefined
      ? Effect.succeed([])
      : Effect.flatMap(Deferred.await(ready), (service) => service.list()).pipe(
          Effect.map((runs) => runs.filter((run) => run.endedAt === null)),
        ),
  );
  /** The definitions in `target`, or what is wrong with them. Problems point into `target`. */
  const verify = Effect.fn("WorkflowRuntime.verify")(function* (target: string) {
    const definitions = yield* loadDefinitions(target, ++loads).pipe(
      Effect.provideContext(services),
      Effect.result,
    );
    if (definitions._tag === "Failure") {
      return { problems: [loadProblem(definitions.failure, target)] } as const;
    }
    const problems = definitionProblems(definitions.success, yield* unfinished);
    return problems.length > 0 ? ({ problems } as const) : { definitions: definitions.success };
  });

  /** Run the file as it is now, unless that is what runs already or something is wrong with it. */
  const reload = Effect.fn("WorkflowRuntime.reload")(function* () {
    const source = yield* fileSystem.readFileString(file).pipe(Effect.option);
    if (Option.isNone(source)) return yield* report(`${file} cannot be read.`);
    if (source.value === loaded) return;
    const verified = yield* verify(file);
    loaded = source.value;
    if (verified.definitions === undefined) {
      const problem = verified.problems.map((found) => found.message).join("\n");
      yield* Effect.logWarning("Workflow definitions were not loaded", { module: file, problem });
      return yield* report(problem);
    }
    yield* report(yield* boot(verified.definitions));
  });

  yield* lock.withPermits(1)(reload());
  // The first load found nothing to run. Workflows are off until the file is fixed.
  if (running === undefined) yield* Deferred.succeed(ready, Workflows.disabled);

  // The folder, not the file: an editor that saves by renaming replaces the file it was watching.
  yield* fileSystem.watch(path.dirname(file)).pipe(
    Stream.debounce(RELOAD_SETTLE),
    Stream.runForEach(() =>
      lock
        .withPermits(1)(reload())
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Reloading workflow definitions failed", Cause.pretty(cause)),
          ),
        ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Workflow definitions are not watched for changes", Cause.pretty(cause)),
    ),
    Effect.forkIn(outer),
  );

  const current = Effect.suspend(() => Deferred.await(ready));
  // A watcher outlives the engine it began on: each reload hands it the next one's stream.
  const followed = <A>(pick: (service: Workflows.Workflows["Service"]) => Stream.Stream<A>) =>
    SubscriptionRef.changes(state).pipe(
      Stream.switchMap((at) =>
        Stream.unwrap(Effect.map(current, pick)).pipe(Stream.map((value) => [value, at] as const)),
      ),
    );
  const service = Workflows.Workflows.of({
    start: Effect.fn("Workflows.start")(function* (...input) {
      return yield* (yield* current).start(...input);
    }),
    signal: Effect.fn("Workflows.signal")(function* (...input) {
      return yield* (yield* current).signal(...input);
    }),
    resume: Effect.fn("Workflows.resume")(function* (...input) {
      return yield* (yield* current).resume(...input);
    }),
    cancel: Effect.fn("Workflows.cancel")(function* (...input) {
      return yield* (yield* current).cancel(...input);
    }),
    get: Effect.fn("Workflows.get")(function* (...input) {
      return yield* (yield* current).get(...input);
    }),
    list: Effect.fn("Workflows.list")(function* (...input) {
      return yield* (yield* current).list(...input);
    }),
    waitFor: Effect.fn("Workflows.waitFor")(function* (...input) {
      return yield* (yield* current).waitFor(...input);
    }),
    questions: Effect.flatMap(current, (live) => live.questions),
    hooks: Effect.flatMap(current, (live) => live.hooks),
    deliver: Effect.fn("Workflows.deliver")(function* (...input) {
      return yield* (yield* current).deliver(...input);
    }),
    stored: Effect.fn("Workflows.stored")(function* (...input) {
      return yield* (yield* current).stored(...input);
    }),
    storeSet: Effect.fn("Workflows.storeSet")(function* (...input) {
      return yield* (yield* current).storeSet(...input);
    }),
    storeDelete: Effect.fn("Workflows.storeDelete")(function* (...input) {
      return yield* (yield* current).storeDelete(...input);
    }),
    watch: followed((live) => live.watch).pipe(
      Stream.map(([snapshot, at]) => ({ ...snapshot, definition: at })),
    ),
    counts: followed((live) => live.counts).pipe(Stream.map(([counts]) => counts)),
    sweep: Effect.flatMap(current, (live) => live.sweep),
  });

  const save = Effect.fn("WorkflowRuntime.save")(function* (source: string) {
    // Beside the real file, so what it imports resolves the same way.
    const draft = path.join(
      path.dirname(file),
      `.${path.basename(file, path.extname(file))}.check-${loads + 1}${path.extname(file)}`,
    );
    const verified = yield* fileSystem.writeFileString(draft, source).pipe(
      Effect.andThen(verify(draft)),
      Effect.ensuring(Effect.ignore(fileSystem.remove(draft))),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({
            problems: [{ message: `Could not write beside ${file}: ${text(error)}` }],
          }),
      }),
    );
    if (!("definitions" in verified)) return verified.problems;
    const written = yield* fileSystem.writeFileString(file, source).pipe(Effect.result);
    if (written._tag === "Failure") {
      return [{ message: `Could not write ${file}: ${text(written.failure)}` }];
    }
    yield* reload();
    return [];
  });

  return Context.make(Workflows.Workflows, service).pipe(
    Context.add(
      WorkflowDefinitions,
      WorkflowDefinitions.of({
        read: Effect.gen(function* () {
          const source = yield* fileSystem.readFileString(file).pipe(Effect.option);
          const at = yield* SubscriptionRef.get(state);
          return {
            path: file,
            source: Option.getOrElse(source, () => ""),
            revision: at.revision,
            problem: at.problem,
          };
        }),
        save: Effect.fn("WorkflowDefinitions.save")(function* (source) {
          return yield* lock.withPermits(1)(save(source));
        }),
      }),
    ),
  );
});

/**
 * The workflow service for this server, and its definitions file. With no file named it is the
 * service with nothing registered and no engine behind it, so a server that uses no workflows
 * pays nothing. Definitions that do not load are reported and never stop the server.
 */
export const layer = Layer.effectContext(
  make(
    Effect.map(
      Effect.promise((): Promise<typeof WorkflowEngine> => import("./WorkflowEngine.ts")),
      (engine) => (definitions) =>
        engine.layer(definitions).pipe(Layer.provide(WorkflowAgentThreads.layer)),
    ),
  ),
);
