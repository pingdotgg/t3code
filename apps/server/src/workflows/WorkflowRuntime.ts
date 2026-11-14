// Workflows in the running server: every file in one folder defines some, and the folder can
// change while the server runs. A file that loads replaces what it defined before; one that does
// not keeps its last good version running. With no definitions there is no engine at all.
import * as NodeURL from "node:url";

import type { WorkflowDefinitionFiles, WorkflowDefinitionProblem } from "@t3tools/contracts";
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

import * as ServerConfig from "../config.ts";
import { engineTag, text, type WorkflowDefinition } from "./workflow.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowAgentThreads from "./WorkflowAgentThreads.ts";
import * as Workflows from "./Workflows.ts";

/** A folder of definition files, or one file, in place of the folder in the T3 home. */
const definitionsOverride = Config.String("T3CODE_WORKFLOWS").pipe(Config.option);

// An editor saves in several writes, and a save from here is followed by its own file event.
const RELOAD_SETTLE = "300 millis";
// A leading dot is how a file is kept out: a draft being checked, an editor's swap file.
const DEFINITION_FILE = /^[^.][\w.-]*\.(ts|mts|js|mjs)$/;

export class WorkflowDefinitionsLoadError extends Schema.TaggedError<WorkflowDefinitionsLoadError>()(
  "WorkflowDefinitionsLoadError",
  { module: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not load workflow definitions from ${this.module}.`;
  }
}

/** The definition files of this server, for a person to read and change. */
export class WorkflowDefinitions extends Context.Service<
  WorkflowDefinitions,
  {
    /** The files as they are on disk now, with what is wrong with them. */
    readonly read: Effect.Effect<WorkflowDefinitionFiles>;
    /**
     * Verify `source` as the file `name`, and when nothing is wrong write it and run it from now
     * on. Returns what is wrong; nothing was written or changed when that is not empty.
     */
    readonly save: (
      name: string,
      source: string,
    ) => Effect.Effect<ReadonlyArray<WorkflowDefinitionProblem>>;
    /** Take a file away, unless runs still need what it defines. */
    readonly remove: (name: string) => Effect.Effect<ReadonlyArray<WorkflowDefinitionProblem>>;
  }
>()("t3/workflows/WorkflowRuntime/WorkflowDefinitions") {}

const isDefinition = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkflowDefinition).name === "string" &&
  typeof (value as WorkflowDefinition).version === "number" &&
  typeof (value as WorkflowDefinition).body === "function";

// The API is handed to a file as globals, which the whole process shares, so files load one at
// a time: each load's `T3.workflow` must register with that load and no other.
let loading: Promise<unknown> = Promise.resolve();

const evaluate = async (url: string): Promise<ReadonlyArray<unknown>> => {
  const api = await import("./api.ts");
  const { Duration, Effect: effect, Option: option, Schedule, Schema: schema, ...t3 } = api;
  const registered: Array<unknown> = [];
  const workflow = ((...input: Parameters<typeof api.workflow>) => {
    const definition = api.workflow(...input);
    registered.push(definition);
    return definition;
  }) as typeof api.workflow;
  Object.assign(globalThis, {
    T3: { ...t3, workflow },
    Effect: effect,
    Schema: schema,
    Option: option,
    Duration,
    Schedule,
  });
  const loaded = (await import(url)) as { readonly default?: unknown };
  // A file may also export what it defines, which is how one passes on what another file made.
  const exported = loaded.default;
  if (exported !== undefined && !Array.isArray(exported)) {
    throw new Error(
      "The default export is not a list of workflows. Call T3.workflow(…), or export a list of what it returned.",
    );
  }
  return [...new Set([...registered, ...(exported ?? [])])];
};

/**
 * The workflows a file defines: every `T3.workflow(…)` it calls, and any list it exports.
 * `load` tells one loading of a file from the next: Node keeps a module by its address, so the
 * same address would give back the file as it was the first time.
 */
export const loadDefinitions = Effect.fn("WorkflowRuntime.loadDefinitions")(function* (
  module: string,
  load = 0,
) {
  const path = yield* Path.Path;
  const url = NodeURL.pathToFileURL(path.resolve(module)).href + (load === 0 ? "" : `?${load}`);
  const definitions = yield* Effect.tryPromise({
    try: () => {
      const mine = loading.then(
        () => evaluate(url),
        () => evaluate(url),
      );
      loading = mine;
      return mine;
    },
    catch: (cause) => new WorkflowDefinitionsLoadError({ module, cause }),
  });
  if (!definitions.every(isDefinition)) {
    return yield* new WorkflowDefinitionsLoadError({
      module,
      cause: "Something it exports is not a workflow. Export only what `T3.workflow` returned.",
    });
  }
  return definitions;
});

/** What a load error says, with the line of `file` it points at when it names one. */
const loadProblem = (
  error: WorkflowDefinitionsLoadError,
  loadedFrom: string,
  file: string,
): WorkflowDefinitionProblem => {
  const cause = error.cause;
  const stack = cause instanceof Error ? (cause.stack ?? "") : "";
  const name = loadedFrom.split(/[\\/]/).at(-1) ?? loadedFrom;
  // Node names the place as `file:///…/name.ts:12` or `…/name.ts:12:5`, with a `?n` when reloaded.
  const at = stack.split(name).find((rest) => /^(\?\d+)?:\d+/.test(rest));
  const line = at === undefined ? undefined : Number(/^(?:\?\d+)?:(\d+)/.exec(at)?.[1]);
  return { message: text(cause), file, ...(line === undefined ? {} : { line }) };
};

/** What is wrong between files that each loaded, given the runs that have not ended. */
const definitionProblems = (
  files: ReadonlyArray<{
    readonly name: string;
    readonly definitions: ReadonlyArray<WorkflowDefinition>;
  }>,
  unfinished: ReadonlyArray<{ readonly workflow: string; readonly version: number }>,
): ReadonlyArray<WorkflowDefinitionProblem> => {
  const where = new Map<string, Array<string>>();
  for (const file of files) {
    for (const definition of file.definitions) {
      where.set(engineTag(definition), [...(where.get(engineTag(definition)) ?? []), file.name]);
    }
  }
  const waiting = new Map<string, number>();
  for (const run of unfinished) {
    const tag = engineTag({ name: run.workflow, version: run.version });
    if (!where.has(tag)) waiting.set(tag, (waiting.get(tag) ?? 0) + 1);
  }
  return [
    ...[...where]
      .filter(([, names]) => names.length > 1)
      .map(([tag, names]) => ({
        message: `${tag} is defined twice, in ${[...new Set(names)].join(" and ")}. A workflow's name and version name one body.`,
      })),
    ...[...waiting].map(([tag, runs]) => ({
      message: `${tag} is no longer defined, and ${runs} of its runs ${runs === 1 ? "has" : "have"} not ended. Keep that version until they end, or cancel them first.`,
    })),
  ];
};

/**
 * `engine` gives the layer that runs a set of definitions. It is asked for only once there is
 * something to run, since the engine's modules are not worth loading for nothing. `where` is the
 * folder of definition files, or one file.
 */
export const make = Effect.fn("WorkflowRuntime.make")(function* <E, R>(
  engine: Effect.Effect<
    (definitions: ReadonlyArray<WorkflowDefinition>) => Layer.Layer<Workflows.Workflows, E, R>
  >,
  where: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(where);
  const single = DEFINITION_FILE.test(path.basename(target));
  const directory = single ? path.dirname(target) : target;
  yield* Effect.ignore(fileSystem.makeDirectory(directory, { recursive: true }));
  const outer = yield* Scope.Scope;
  const services = yield* Effect.context<R | Path.Path>();

  // One reload at a time, and callers during one wait for the engine that comes out of it.
  const lock = yield* Semaphore.make(1);
  let ready = Deferred.makeUnsafe<Workflows.Workflows["Service"]>();
  let engineScope: Scope.Closeable | undefined;
  let running: ReadonlyArray<WorkflowDefinition> = [];
  let loads = 0;
  /** Each file as it was last looked at, so one that did not change is not loaded again. */
  const seen = new Map<string, string>();
  /** The last version of each file that loaded, which runs while a newer one does not. */
  const good = new Map<string, ReadonlyArray<WorkflowDefinition>>();
  const broken = new Map<string, WorkflowDefinitionProblem>();
  let between: ReadonlyArray<WorkflowDefinitionProblem> = [];
  const state = yield* SubscriptionRef.make<{ revision: number; problem: string | null }>({
    revision: 0,
    problem: null,
  });
  const told = (problem: WorkflowDefinitionProblem) =>
    problem.file === undefined ? problem.message : `${problem.file}: ${problem.message}`;
  const report = Effect.suspend(() => {
    const problems = [...broken.values(), ...between];
    return SubscriptionRef.update(state, (current) => ({
      revision: current.revision + 1,
      problem: problems.length === 0 ? null : problems.map(told).join("\n"),
    }));
  });

  const names = Effect.gen(function* () {
    if (single) {
      return (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)))
        ? [path.basename(target)]
        : [];
    }
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    return entries.filter((entry) => DEFINITION_FILE.test(entry)).toSorted();
  });

  const boot = Effect.fn("WorkflowRuntime.boot")(function* (
    definitions: ReadonlyArray<WorkflowDefinition>,
  ) {
    const next = Deferred.makeUnsafe<Workflows.Workflows["Service"]>();
    ready = next;
    if (engineScope !== undefined) yield* Scope.close(engineScope, Exit.void);
    engineScope = undefined;
    running = [];
    if (definitions.length === 0) {
      yield* Deferred.succeed(next, Workflows.disabled);
      return null;
    }
    engineScope = yield* Scope.fork(outer);
    const layerEngine = yield* engine;
    const built = yield* Layer.buildWithScope(layerEngine(definitions), engineScope).pipe(
      Effect.provideContext(services),
      Effect.exit,
    );
    if (Exit.isFailure(built)) {
      // Nobody may be left waiting on an engine that never came up.
      yield* Deferred.succeed(next, Workflows.disabled);
      return `The workflow engine did not start: ${text(Cause.squash(built.cause))}`;
    }
    running = definitions;
    yield* Deferred.succeed(next, Context.get(built.value, Workflows.Workflows));
    yield* Effect.logInfo("Workflows registered", {
      directory,
      workflows: definitions.map(engineTag),
    });
    return null;
  });

  const unfinished = Effect.suspend(() =>
    running.length === 0
      ? Effect.succeed([])
      : Effect.flatMap(Deferred.await(ready), (service) => service.list()).pipe(
          Effect.map((runs) => runs.filter((run) => run.endedAt === null)),
        ),
  );
  /** The workflows the file at `from` defines, or what is wrong with it as the file `name`. */
  const load = Effect.fn("WorkflowRuntime.load")(function* (from: string, name: string) {
    const definitions = yield* loadDefinitions(from, ++loads).pipe(
      Effect.provideContext(services),
      Effect.result,
    );
    return definitions._tag === "Failure"
      ? ({ problem: loadProblem(definitions.failure, from, name) } as const)
      : ({ definitions: definitions.success } as const);
  });
  /** What would run with these files, in the folder's order. */
  const gathered = (files: ReadonlyMap<string, ReadonlyArray<WorkflowDefinition>>) =>
    [...files]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, definitions]) => ({ name, definitions }));

  /** Take in what changed in the folder, and run the result unless something is wrong with it. */
  const reload = Effect.fn("WorkflowRuntime.reload")(function* () {
    const present = yield* names;
    let changed = false;
    for (const name of present) {
      const file = path.join(directory, name);
      const source = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (Option.isNone(source) || seen.get(name) === source.value) continue;
      seen.set(name, source.value);
      changed = true;
      const loaded = yield* load(file, name);
      if (loaded.definitions === undefined) {
        broken.set(name, loaded.problem);
        yield* Effect.logWarning("A workflow definitions file was not loaded", loaded.problem);
        continue;
      }
      broken.delete(name);
      good.set(name, loaded.definitions);
    }
    for (const name of [...seen.keys()].filter((known) => !present.includes(known))) {
      seen.delete(name);
      good.delete(name);
      broken.delete(name);
      changed = true;
    }
    // Asked again while something stands between files: the runs that held a version may be over.
    if (!changed && between.length === 0) return;
    const files = gathered(good);
    between = definitionProblems(files, yield* unfinished);
    if (between.length > 0) {
      yield* Effect.logWarning("Workflow definitions were not changed", { problems: between });
      return yield* report;
    }
    const failed = yield* boot(files.flatMap((file) => file.definitions));
    between = failed === null ? [] : [{ message: failed }];
    yield* report;
  });

  yield* lock.withPermits(1)(reload());
  // Nothing to run yet: the service answers as one with no workflows until a file defines some.
  if (running.length === 0) yield* Deferred.succeed(ready, Workflows.disabled);

  // The folder, not a file: an editor that saves by renaming replaces the file it was watching.
  yield* fileSystem.watch(directory).pipe(
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

  const alone = { message: `This server reads its workflows from ${target} alone.` };
  /** Why `name` cannot be a file here, if it cannot. */
  const refused = (name: string): WorkflowDefinitionProblem | undefined =>
    single && name !== path.basename(target)
      ? alone
      : DEFINITION_FILE.test(name)
        ? undefined
        : {
            message:
              "Name the file with letters, digits, dashes and dots, ending in .ts: for example release.ts.",
          };
  /** What is wrong with the folder once `change` is made to the files that load. */
  const wouldBreak = Effect.fn("WorkflowRuntime.wouldBreak")(function* (
    change: (files: Map<string, ReadonlyArray<WorkflowDefinition>>) => void,
  ) {
    const files = new Map(good);
    change(files);
    return definitionProblems(gathered(files), yield* unfinished);
  });

  const save = Effect.fn("WorkflowRuntime.save")(function* (name: string, source: string) {
    const no = refused(name);
    if (no !== undefined) return [no];
    const file = path.join(directory, name);
    // Beside the real file, so what it imports resolves the same way. The dot keeps it out.
    const draft = path.join(directory, `.${name}.check-${loads + 1}${path.extname(name)}`);
    const checked = yield* fileSystem.writeFileString(draft, source).pipe(
      Effect.andThen(load(draft, name)),
      Effect.ensuring(Effect.ignore(fileSystem.remove(draft))),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({
            problem: { message: `Could not write in ${directory}: ${text(error)}` },
          } as const),
      }),
    );
    if (!("definitions" in checked)) return [checked.problem];
    const definitions = checked.definitions;
    const problems = yield* wouldBreak((files) => files.set(name, definitions));
    if (problems.length > 0) return problems;
    const written = yield* fileSystem.writeFileString(file, source).pipe(Effect.result);
    if (written._tag === "Failure") {
      return [{ message: `Could not write ${file}: ${text(written.failure)}` }];
    }
    yield* reload();
    return [];
  });

  const remove = Effect.fn("WorkflowRuntime.remove")(function* (name: string) {
    const no = single ? alone : refused(name);
    if (no !== undefined) return [no];
    const problems = yield* wouldBreak((files) => files.delete(name));
    if (problems.length > 0) return problems;
    const removed = yield* fileSystem.remove(path.join(directory, name)).pipe(Effect.result);
    if (removed._tag === "Failure") {
      return [{ message: `Could not delete ${name}: ${text(removed.failure)}` }];
    }
    yield* reload();
    return [];
  });

  return Context.make(Workflows.Workflows, service).pipe(
    Context.add(
      WorkflowDefinitions,
      WorkflowDefinitions.of({
        read: Effect.gen(function* () {
          const files = yield* Effect.forEach(yield* names, (name) =>
            fileSystem.readFileString(path.join(directory, name)).pipe(
              Effect.orElseSucceed(() => ""),
              Effect.map((source) => {
                const problem = broken.get(name);
                return { name, source, problems: problem === undefined ? [] : [problem] };
              }),
            ),
          );
          const at = yield* SubscriptionRef.get(state);
          return { directory, single, files, problems: between, ...at };
        }),
        save: Effect.fn("WorkflowDefinitions.save")(function* (name, source) {
          return yield* lock.withPermits(1)(save(name, source));
        }),
        remove: Effect.fn("WorkflowDefinitions.remove")(function* (name) {
          return yield* lock.withPermits(1)(remove(name));
        }),
      }),
    ),
  );
});

/**
 * The workflow service for this server, and its definition files: those in the `workflows`
 * folder of the T3 home, or wherever `T3CODE_WORKFLOWS` points instead. A file that does not
 * load is reported and never stops the server.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const override = yield* definitionsOverride;
    const config = yield* ServerConfig.ServerConfig;
    return yield* make(
      Effect.map(
        Effect.promise((): Promise<typeof WorkflowEngine> => import("./WorkflowEngine.ts")),
        (engine) => (definitions) =>
          engine.layer(definitions).pipe(Layer.provide(WorkflowAgentThreads.layer)),
      ),
      Option.getOrElse(override, () => config.workflowsDir),
    );
  }),
);
