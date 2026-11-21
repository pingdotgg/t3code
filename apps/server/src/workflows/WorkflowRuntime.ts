// Workflows in the running server: every file in one folder defines some, and the folder can
// change while the server runs. A file that loads replaces what it defined before; one that does
// not keeps its last good version running. With no definitions there is no engine, unless runs
// from before are kept: then one with nothing registered serves their history.
import * as NodeAsyncHooks from "node:async_hooks";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the CommonJS cache is cleared in the same tick as the import.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import type {
  WorkflowDefinitionChangeResult,
  WorkflowDefinitionFiles,
  WorkflowDefinitionProblem,
} from "@t3tools/contracts";
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
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { engineTag, text, type WorkflowDefinition } from "./workflow.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowAgentThreads from "./WorkflowAgentThreads.ts";
import * as WorkflowForge from "./WorkflowForge.ts";
import * as Workflows from "./Workflows.ts";

/** A folder of definition files, or one file, in place of the folder in the T3 home. */
const definitionsOverride = Config.String("T3CODE_WORKFLOWS").pipe(Config.option);

// An editor saves in several writes, and a save from here is followed by its own file event.
const RELOAD_SETTLE = "300 millis";
// How often a change held back by unfinished runs is tried again, so it goes in once they end.
const HELD_RETRY = "15 seconds";
// A folder that could not be listed is looked at again, since no file event may follow.
const LIST_RETRY = "30 seconds";
// A leading dot is how a file is kept out: a draft being checked, an editor's swap file.
// One name in the folder, never a path: the name is also the key a save and a removal go by.
const DEFINITION_FILE = /^[A-Za-z0-9_][\w.-]*\.(ts|mts|js|mjs)$/;
const NAMING =
  "Name the file with letters, digits, dashes, underscores and dots, ending in .ts: for example release.ts.";

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
     * on. A file that was written can still fail to run, and then says why.
     */
    readonly save: (name: string, source: string) => Effect.Effect<WorkflowDefinitionChangeResult>;
    /** Take a file away, unless runs still need what it defines. */
    readonly remove: (name: string) => Effect.Effect<WorkflowDefinitionChangeResult>;
  }
>()("t3/workflows/WorkflowRuntime/WorkflowDefinitions") {}

const isDefinition = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkflowDefinition).name === "string" &&
  typeof (value as WorkflowDefinition).version === "number" &&
  typeof (value as WorkflowDefinition).body === "function" &&
  // The engine walks these at start, and a file can export an object that only looks like one.
  Array.isArray((value as WorkflowDefinition).triggers) &&
  Array.isArray((value as WorkflowDefinition).resumeAfter);

// The API is handed to a file as globals, which the whole process shares, so files load one at
// a time. A load that was given up on still runs, so `T3.workflow` registers with the load whose
// code calls it, and with none once that load is over.
const loading = Semaphore.makeUnsafe(1);
// A file whose top-level code never settles would otherwise hold every later load. Real time,
// since importing a module is.
const LOAD_DEADLINE_MS = 20_000;

interface Evaluation {
  readonly registered: Array<unknown>;
  open: boolean;
}
const evaluating = new NodeAsyncHooks.AsyncLocalStorage<Evaluation>();
const required = NodeModule.createRequire(import.meta.url);

/** A file with no `import` or `export` loads as CommonJS, which Node keeps by path, not address. */
const forget = (file: string) => {
  delete required.cache[file];
  try {
    delete required.cache[NodeFS.realpathSync(file)];
  } catch {
    // Gone already, so nothing can be kept under its real path either.
  }
};

const within = <A>(work: Promise<A>, ms: number): Promise<A | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off -- an import runs on real time, not a test clock.
    timer = setTimeout(resolve, ms, undefined);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

const evaluate = async (url: string, evaluation: Evaluation): Promise<ReadonlyArray<unknown>> => {
  const api = await import("./api.ts");
  const { Duration, Effect: effect, Option: option, Schedule, Schema: schema, ...t3 } = api;
  const workflow = ((...input: Parameters<typeof api.workflow>) => {
    const current = evaluating.getStore();
    if (current === undefined || !current.open) {
      throw new Error(
        "T3.workflow was called after its file finished loading. Call it at the top of the file.",
      );
    }
    const definition = api.workflow(...input);
    current.registered.push(definition);
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
  const loaded = (await evaluating.run(evaluation, () => import(url))) as {
    readonly default?: unknown;
    "module.exports"?: unknown;
  };
  // A file with no `import` or `export` loads as CommonJS, whose default is its `module.exports`:
  // an empty object unless the file set one, which says nothing about what it defines.
  const commonJs = "module.exports" in loaded;
  const exported =
    commonJs &&
    typeof loaded.default === "object" &&
    loaded.default !== null &&
    !Array.isArray(loaded.default) &&
    Object.keys(loaded.default).length === 0
      ? undefined
      : loaded.default;
  // One workflow exported by itself is as good as a list of one.
  const listed =
    exported === undefined
      ? []
      : Array.isArray(exported)
        ? exported
        : isDefinition(exported)
          ? [exported]
          : undefined;
  if (listed === undefined) {
    throw new Error(
      "The default export is not a workflow or a list of them. Call T3.workflow(…), or export what it returned.",
    );
  }
  return [...new Set([...evaluation.registered, ...listed])];
};

/**
 * The workflows a file defines: every `T3.workflow(…)` it calls, and any list it exports.
 * `load` tells one loading of a file from the next: Node keeps a module by its address, so the
 * same address would give back the file as it was the first time.
 */
export const loadDefinitions = Effect.fn("WorkflowRuntime.loadDefinitions")(function* (
  module: string,
  load = 0,
  deadlineMs = LOAD_DEADLINE_MS,
) {
  const path = yield* Path.Path;
  const file = path.resolve(module);
  const url = NodeURL.pathToFileURL(file).href + (load === 0 ? "" : `?${load}`);
  const definitions = yield* Effect.tryPromise({
    try: () => {
      const evaluation: Evaluation = { registered: [], open: true };
      forget(file);
      return within(evaluate(url, evaluation), deadlineMs).finally(() => {
        evaluation.open = false;
        forget(file);
      });
    },
    catch: (cause) => new WorkflowDefinitionsLoadError({ module, cause }),
  }).pipe(loading.withPermits(1));
  if (definitions === undefined) {
    return yield* new WorkflowDefinitionsLoadError({
      module,
      cause: `It did not finish loading within ${deadlineMs / 1000} seconds. Something at the top of the file waits for good.`,
    });
  }
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

/**
 * What is wrong between files that each loaded, given the runs that have not ended, with the
 * files that could each be the cause.
 */
const definitionProblems = (
  files: ReadonlyArray<{
    readonly name: string;
    readonly definitions: ReadonlyArray<WorkflowDefinition>;
  }>,
  unfinished: ReadonlyArray<{ readonly workflow: string; readonly version: number }>,
  before: ReadonlyMap<string, ReadonlyArray<WorkflowDefinition>> = new Map(),
): ReadonlyArray<{
  readonly problem: WorkflowDefinitionProblem;
  readonly files: ReadonlyArray<string>;
  readonly clash: boolean;
}> => {
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
        problem: {
          message: `${tag} is defined twice, in ${[...new Set(names)].join(" and ")}. A workflow's name and version name one body.`,
        },
        files: [...new Set(names)],
        clash: true,
      })),
    ...[...waiting].map(([tag, runs]) => ({
      problem: {
        message: `${tag} is no longer defined, and ${runs} of its runs ${runs === 1 ? "has" : "have"} not ended. Keep that version until they end, or cancel them first.`,
      },
      files: [...before]
        .filter(([, definitions]) =>
          definitions.some((definition) => engineTag(definition) === tag),
        )
        .map(([name]) => name),
      clash: false,
    })),
  ];
};

/**
 * `engine` gives the layer that runs a set of definitions. It is asked for only once there is
 * something to run or `kept` says there are runs to read, since the engine's modules are not worth
 * loading for nothing. `where` is the folder of definition files, or one file.
 */
export const make = Effect.fn("WorkflowRuntime.make")(function* <E, R>(
  engine: Effect.Effect<
    (definitions: ReadonlyArray<WorkflowDefinition>) => Layer.Layer<Workflows.Workflows, E, R>
  >,
  where: string,
  kept: Effect.Effect<boolean>,
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
  let imported = false;
  /** Each file as it was last looked at, so one that did not change is not loaded again. */
  const seen = new Map<string, string>();
  /** The last version of each file that loaded, which runs while a newer one does not. */
  const good = new Map<string, ReadonlyArray<WorkflowDefinition>>();
  /** Files that loaded or went away since, kept apart until the change as a whole is taken. */
  const pending = new Map<string, ReadonlyArray<WorkflowDefinition> | null>();
  const broken = new Map<string, WorkflowDefinitionProblem>();
  /** Files whose change clashes with another file or drops what a run needs, and why. */
  const held = new Map<string, Array<WorkflowDefinitionProblem>>();
  let between: ReadonlyArray<WorkflowDefinitionProblem> = [];
  /** Code files in the folder that are not loaded because of their name. */
  let misnamed: ReadonlyArray<WorkflowDefinitionProblem> = [];
  let retrying = false;
  let unstarted = false;
  const state = yield* SubscriptionRef.make<{ revision: number; problem: string | null }>({
    revision: 0,
    problem: null,
  });
  const told = (problem: WorkflowDefinitionProblem) =>
    problem.file === undefined ? problem.message : `${problem.file}: ${problem.message}`;
  const report = Effect.suspend(() => {
    const problems = [...broken.values(), ...[...held.values()].flat(), ...misnamed, ...between];
    return SubscriptionRef.update(state, (current) => ({
      revision: current.revision + 1,
      problem: problems.length === 0 ? null : problems.map(told).join("\n"),
    }));
  });

  /** Every name in the folder, or the one file. */
  const entries = Effect.gen(function* () {
    if (single) {
      return (yield* fileSystem.exists(target)) ? [path.basename(target)] : [];
    }
    // A folder that is not there yet is empty. One that cannot be read just now is not: it
    // fails, and what was loaded stays.
    if (!(yield* fileSystem.exists(directory))) return [];
    return (yield* fileSystem.readDirectory(directory)).toSorted();
  });
  const definitionNames = (all: ReadonlyArray<string>) =>
    all.filter((entry) => DEFINITION_FILE.test(entry));
  const names = Effect.map(entries, definitionNames);

  /** A fresh engine for these definitions in its own scope, or the failure that stopped it. */
  const build = Effect.fn("WorkflowRuntime.build")(function* (
    definitions: ReadonlyArray<WorkflowDefinition>,
  ) {
    const scope = yield* Scope.fork(outer);
    const layerEngine = yield* engine;
    imported = true;
    const built = yield* Effect.suspend(() =>
      Layer.buildWithScope(layerEngine(definitions), scope),
    ).pipe(Effect.provideContext(services), Effect.exit);
    if (Exit.isFailure(built)) yield* Scope.close(scope, Exit.void);
    else engineScope = scope;
    return built;
  });

  const boot = Effect.fn("WorkflowRuntime.boot")(
    function* (definitions: ReadonlyArray<WorkflowDefinition>) {
      const next = Deferred.makeUnsafe<Workflows.Workflows["Service"]>();
      ready = next;
      const previous = running;
      if (engineScope !== undefined) yield* Scope.close(engineScope, Exit.void);
      engineScope = undefined;
      running = [];
      if (definitions.length === 0 && !imported && !(yield* kept)) {
        yield* Deferred.succeed(next, Workflows.disabled);
        return null;
      }
      const built = yield* build(definitions);
      if (Exit.isSuccess(built)) {
        running = definitions;
        yield* Deferred.succeed(next, Context.get(built.value, Workflows.Workflows));
        if (definitions.length > 0) {
          yield* Effect.logInfo("Workflows registered", {
            directory,
            workflows: definitions.map(engineTag),
          });
        }
        return null;
      }
      // What ran before comes back, so definitions that cannot start take nothing down.
      const restored = yield* build(previous);
      if (Exit.isSuccess(restored)) {
        running = previous;
        yield* Deferred.succeed(next, Context.get(restored.value, Workflows.Workflows));
      } else {
        // Nobody may be left waiting on an engine that never came up.
        yield* Deferred.succeed(next, Workflows.disabled);
      }
      return `The workflow engine did not start: ${text(Cause.squash(built.cause))}`;
    },
    // Once `ready` is replaced it must be settled, or every caller waits on it for good.
    Effect.uninterruptible,
  );

  const unfinished = Effect.suspend(() =>
    running.length === 0
      ? Effect.succeed([])
      : Effect.flatMap(Deferred.await(ready), (service) => service.unfinished),
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

  // Set once `reload` exists, which it schedules again; the indirection keeps its type inferred.
  let retryLater: Effect.Effect<void> = Effect.void;
  /** Take in what changed in the folder, and run the result unless something is wrong with it. */
  const reload = Effect.fn("WorkflowRuntime.reload")(function* () {
    const listed = yield* Effect.option(entries);
    if (Option.isNone(listed)) {
      yield* Effect.logWarning(
        "The workflows folder could not be read; its workflows stay as they are",
      );
      yield* retryLater;
      return false;
    }
    const present = definitionNames(listed.value);
    // A leading dot keeps a file out on purpose; any other code file left out is a surprise.
    const wasMisnamed = misnamed;
    misnamed = listed.value
      .filter((entry) => /^[^.].*\.(ts|mts|js|mjs)$/.test(entry) && !DEFINITION_FILE.test(entry))
      .map((entry) => ({ message: `It is not loaded. ${NAMING}`, file: entry }));
    const renamed =
      misnamed.map((problem) => problem.file).join("/") !==
      wasMisnamed.map((problem) => problem.file).join("/");
    let changed = false;
    for (const problem of misnamed) {
      if (!wasMisnamed.some((known) => known.file === problem.file)) {
        yield* Effect.logWarning(
          "A file in the workflows folder is not loaded because of its name",
          problem,
        );
      }
    }
    for (const name of present) {
      const file = path.join(directory, name);
      const source = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (Option.isNone(source) || seen.get(name) === source.value) continue;
      seen.set(name, source.value);
      changed = true;
      const loaded = yield* load(file, name);
      if (loaded.definitions === undefined) {
        broken.set(name, loaded.problem);
        pending.delete(name);
        yield* Effect.logWarning("A workflow definitions file was not loaded", loaded.problem);
        continue;
      }
      broken.delete(name);
      pending.set(name, loaded.definitions);
    }
    for (const name of [...seen.keys()].filter((known) => !present.includes(known))) {
      seen.delete(name);
      pending.set(name, null);
      broken.delete(name);
      changed = true;
    }
    // Asked again while something stands between files: the runs that held a version may be over.
    if (!changed && between.length === 0 && held.size === 0) {
      if (renamed) yield* report;
      return true;
    }
    const runs = yield* unfinished;
    // A change that clashes is held back like a file that does not load: that file keeps its last
    // good version, a new one stays out, and every other change is taken.
    held.clear();
    let next = new Map(good);
    let problems: ReturnType<typeof definitionProblems> = [];
    let blamed = true;
    while (blamed) {
      blamed = false;
      next = new Map(good);
      for (const [name, definitions] of pending) {
        if (held.has(name)) continue;
        if (definitions === null) next.delete(name);
        else next.set(name, definitions);
      }
      problems = definitionProblems(gathered(next), runs, good);
      for (const { problem, files: involved, clash } of problems) {
        const changing = involved.filter((name) => pending.has(name) && !held.has(name));
        // Between new files that define the same workflow, the first in the folder's order stays.
        const culprits =
          clash && changing.length === involved.length ? changing.slice(1) : changing;
        for (const name of culprits) {
          held.set(name, [...(held.get(name) ?? []), { ...problem, file: name }]);
          blamed = true;
        }
      }
    }
    if (held.size > 0) {
      yield* Effect.logWarning("Some workflow definition changes were not taken", {
        problems: [...held.values()].flat(),
      });
    }
    // What is left was so before any of these changes, so it holds none of them back.
    const standing = problems.map((entry) => entry.problem);
    if (standing.length > 0) {
      yield* Effect.logWarning("Workflow definitions have problems", { problems: standing });
    }
    const taking = [...pending.keys()].filter((name) => !held.has(name));
    // An engine that did not start is tried again, as the runs it tripped on may have ended.
    if (taking.length === 0 && !unstarted) {
      between = standing;
      yield* report;
      return true;
    }
    good.clear();
    for (const [name, definitions] of next) good.set(name, definitions);
    for (const name of taking) pending.delete(name);
    const failed = yield* boot(gathered(next).flatMap((file) => file.definitions));
    unstarted = failed !== null;
    between = failed === null ? standing : [...standing, { message: failed }];
    yield* report;
    return true;
  });

  retryLater = Effect.suspend(() => {
    if (retrying) return Effect.void;
    retrying = true;
    return Effect.suspend(() => {
      retrying = false;
      return lock.withPermits(1)(reload());
    }).pipe(
      Effect.delay(LIST_RETRY),
      Effect.catchCause((cause) =>
        Effect.logWarning("Reloading workflow definitions failed", Cause.pretty(cause)),
      ),
      Effect.forkIn(outer),
      Effect.asVoid,
    );
  });

  yield* lock.withPermits(1)(reload());
  // No file defines anything yet, though runs kept from before may still be read.
  if (!(yield* Deferred.isDone(ready))) yield* boot([]);

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

  yield* Effect.sleep(HELD_RETRY).pipe(
    Effect.andThen(
      Effect.suspend(() => (held.size > 0 ? lock.withPermits(1)(reload()) : Effect.void)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Reloading workflow definitions failed", Cause.pretty(cause)),
    ),
    Effect.forever,
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
    answer: Effect.fn("Workflows.answer")(function* (...input) {
      return yield* (yield* current).answer(...input);
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
      // A reload replaces the engine, and a wait on the old one would never hear of the run again.
      while (true) {
        // Noted before the engine is read, so a reload that lands in between is still heard of.
        const { revision } = yield* SubscriptionRef.get(state);
        const live = yield* current;
        const reloaded = SubscriptionRef.changes(state).pipe(
          Stream.filter((at) => at.revision !== revision),
          Stream.runHead,
        );
        const waited = yield* live
          .waitFor(...input)
          .pipe(Effect.asSome, Effect.raceFirst(Effect.as(reloaded, Option.none())));
        if (Option.isSome(waited)) return waited.value;
      }
    }),
    questions: Effect.flatMap(current, (live) => live.questions),
    unfinished: Effect.flatMap(current, (live) => live.unfinished),
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
        : { message: NAMING };
  /** What is wrong with the folder once `change` is made to the files that load. */
  const wouldBreak = Effect.fn("WorkflowRuntime.wouldBreak")(function* (
    change: (files: Map<string, ReadonlyArray<WorkflowDefinition>>) => void,
  ) {
    const files = new Map(good);
    change(files);
    return definitionProblems(gathered(files), yield* unfinished, good).map(
      (entry) => entry.problem,
    );
  });

  const refusal = (problems: ReadonlyArray<WorkflowDefinitionProblem>) => ({
    changed: false,
    problems,
  });
  /** What keeps a change to the file `name` from running, once it is made on disk. */
  const taken = Effect.fn("WorkflowRuntime.taken")(function* (name: string) {
    const listed = yield* reload();
    const problem = broken.get(name);
    return {
      changed: true,
      problems: listed
        ? [...(problem === undefined ? [] : [problem]), ...(held.get(name) ?? []), ...between]
        : [{ message: `${directory} could not be read just now, so the change does not run yet.` }],
    };
  });

  const save = Effect.fn("WorkflowRuntime.save")(function* (name: string, source: string) {
    const no = refused(name);
    if (no !== undefined) return refusal([no]);
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
    if (!("definitions" in checked)) return refusal([checked.problem]);
    const definitions = checked.definitions;
    const problems = yield* wouldBreak((files) => files.set(name, definitions));
    if (problems.length > 0) return refusal(problems);
    const written = yield* fileSystem.writeFileString(file, source).pipe(Effect.result);
    if (written._tag === "Failure") {
      return refusal([{ message: `Could not write ${file}: ${text(written.failure)}` }]);
    }
    return yield* taken(name);
  });

  const remove = Effect.fn("WorkflowRuntime.remove")(function* (name: string) {
    const no = single ? alone : refused(name);
    if (no !== undefined) return refusal([no]);
    const problems = yield* wouldBreak((files) => files.delete(name));
    if (problems.length > 0) return refusal(problems);
    const removed = yield* fileSystem.remove(path.join(directory, name)).pipe(Effect.result);
    if (removed._tag === "Failure") {
      return refusal([{ message: `Could not delete ${name}: ${text(removed.failure)}` }]);
    }
    return yield* taken(name);
  });

  return Context.make(Workflows.Workflows, service).pipe(
    Context.add(
      WorkflowDefinitions,
      WorkflowDefinitions.of({
        read: Effect.gen(function* () {
          const files = yield* Effect.forEach(
            yield* Effect.orElseSucceed(names, () => []),
            (name) =>
              fileSystem.readFileString(path.join(directory, name)).pipe(
                Effect.orElseSucceed(() => ""),
                Effect.map((source) => {
                  const problem = broken.get(name);
                  return {
                    name,
                    source,
                    workflows: (good.get(name) ?? []).map(engineTag),
                    problems: [
                      ...(problem === undefined ? [] : [problem]),
                      ...(held.get(name) ?? []),
                    ],
                  };
                }),
              ),
          );
          const at = yield* SubscriptionRef.get(state);
          // A file held back after it was deleted has no entry of its own to say so.
          const gone = [...held]
            .filter(([name]) => !files.some((file) => file.name === name))
            .flatMap(([, problems]) => problems);
          return { directory, single, files, problems: [...misnamed, ...between, ...gone], ...at };
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
    const forge = Layer.succeed(WorkflowForge.WorkflowForge, yield* WorkflowForge.WorkflowForge);
    const sql = yield* SqlClient.SqlClient;
    return yield* make(
      Effect.map(
        Effect.promise((): Promise<typeof WorkflowEngine> => import("./WorkflowEngine.ts")),
        (engine) => (definitions) =>
          engine
            .layer(definitions)
            .pipe(Layer.provide(WorkflowAgentThreads.layer), Layer.provide(forge)),
      ),
      Option.getOrElse(override, () => config.workflowsDir),
      sql`SELECT 1 FROM workflow_runs LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => true),
      ),
    );
  }),
);
