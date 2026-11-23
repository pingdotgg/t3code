// What a step's own code may use besides plain Effect: state shared between runs, and a way to
// wake a run that waits. Both touch the world, so they are for inside `step` and `onEnd`.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { checkOptions } from "./options.ts";
import { type StepReferences, stepReferences } from "./runReferences.ts";
import type { WorkflowDefinition } from "./workflow.ts";
import { WorkflowForge } from "./WorkflowForge.ts";
import type { WorkflowError, WorkflowInputError } from "./Workflows.ts";
import type {
  RunParent,
  SignalAddress,
  WorkflowRunStatus,
  WorkflowStore,
} from "./WorkflowStore.ts";

/** The shared store as rows of JSON text. `store` puts schemas on top. */
export class KeyValues extends Context.Service<
  KeyValues,
  {
    readonly get: (key: string) => Effect.Effect<string | undefined>;
    readonly set: (key: string, valueJson: string) => Effect.Effect<void>;
    readonly delete: (key: string) => Effect.Effect<void>;
    readonly list: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly key: string; readonly valueJson: string }>>;
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/workflows/stepServices/KeyValues") {}

export type SendSignal = (
  address: SignalAddress,
  value: Schema.Json,
  options: { readonly id: string; readonly ttl?: Duration.Input },
) => Effect.Effect<"delivered" | "buffered", WorkflowInputError>;

/** Everyone who waits on a key, in one workflow or in all of them. */
export interface EveryoneAt {
  readonly channel: string;
  readonly workflow?: string | undefined;
}
export type SendSignalToAll = (address: EveryoneAt, value: Schema.Json) => Effect.Effect<number>;

/** A run as a step of another run sees it. `key` is what it was started with. */
export interface RunSummary {
  readonly id: string;
  readonly workflow: string;
  readonly key: string;
  readonly title: string;
  readonly status: WorkflowRunStatus;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface RunFilter {
  readonly workflow?: string | undefined;
  readonly status?: WorkflowRunStatus | undefined;
  readonly keyPrefix?: string | undefined;
}

/** Signals from the step that is running. Its signals are numbered, so a retry sends the same ones. */
export class Signals extends Context.Service<
  Signals,
  {
    readonly sendAll: SendSignalToAll;
    readonly send: (
      address: SignalAddress,
      value: Schema.Json,
      options?: { readonly id?: string; readonly ttl?: Duration.Input },
    ) => Effect.Effect<"delivered" | "buffered", WorkflowInputError>;
  }
>()("t3/workflows/stepServices/Signals") {}

export type StartRun = (
  workflow: string,
  input: unknown,
  options: {
    readonly idempotencyKey: string;
    readonly parent?: RunParent;
    /** The version the caller was written against. Without it, the newest registered. */
    readonly version?: number;
  },
) => Effect.Effect<{ readonly runId: string }, WorkflowError>;

export type CancelRun = (runId: string, reason: string) => Effect.Effect<void, WorkflowError>;
export type ListRuns = (filter: RunFilter) => Effect.Effect<ReadonlyArray<RunSummary>>;

/** Other runs, from the step that is running: starting, finding and cancelling them. */
export class Runs extends Context.Service<
  Runs,
  { readonly start: StartRun; readonly cancel: CancelRun; readonly list: ListRuns }
>()("t3/workflows/stepServices/Runs") {}

export type InStep = KeyValues | Signals | Runs | WorkflowForge | StepReferences;

/**
 * What a step needs of the engine, which exists only once the engine does, while the workflows
 * that use it are registered before. The engine fills this in when it starts.
 */
export class EngineLink extends Context.Service<
  EngineLink,
  {
    current:
      | {
          readonly signal: SendSignal;
          readonly signalAll: SendSignalToAll;
          readonly start: StartRun;
          readonly cancel: CancelRun;
          readonly list: ListRuns;
          /** Tell the run that invoked `runId`, if one did, how it ended. */
          readonly ended: (runId: string) => Effect.Effect<void>;
        }
      | undefined;
    /** The steps of each run that are running in this process right now. */
    readonly inFlight: InFlight;
  }
>()("t3/workflows/stepServices/EngineLink") {}
export interface InFlight {
  readonly track: <A, E, R>(
    runId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Whether a step of `runId` is running now. */
  readonly busy: (runId: string) => boolean;
  /** Waits until no step of `runId` is running. */
  readonly settled: (runId: string) => Effect.Effect<void>;
}

// A step cannot be interrupted, so whatever cleans up after a cancelled run waits for it here.
const makeInFlight = (): InFlight => {
  const running = new Map<string, { count: number; idle: Deferred.Deferred<void> }>();
  return {
    track: (runId, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = running.get(runId) ?? { count: 0, idle: Deferred.makeUnsafe<void>() };
          entry.count++;
          running.set(runId, entry);
          return entry;
        }),
        () => effect,
        (entry) =>
          Effect.suspend(() => {
            if (--entry.count > 0) return Effect.void;
            running.delete(runId);
            return Deferred.succeed(entry.idle, undefined);
          }),
      ),
    busy: (runId) => running.has(runId),
    settled: (runId) =>
      Effect.suspend(() => {
        const entry = running.get(runId);
        return entry === undefined ? Effect.void : Deferred.await(entry.idle);
      }),
  };
};

export const layerEngineLink = Layer.sync(EngineLink, () => ({
  current: undefined,
  inFlight: makeInFlight(),
}));

const engineOf = (link: EngineLink["Service"]) =>
  link.current === undefined
    ? Effect.die(new Error("The workflow engine is not up."))
    : Effect.succeed(link.current);

/**
 * The services for the step `name` of `runId`. Each signal it sends is the two, where it goes,
 * and how many it sent there before, so a retry that sends the same again is not new. What it
 * touches through the forge is kept against it.
 */
export const forStep = (
  store: WorkflowStore["Service"],
  keyValues: KeyValues["Service"],
  link: EngineLink["Service"],
  forge: WorkflowForge["Service"],
  runId: string,
  name: string,
): Context.Context<InStep> => {
  const owner = `${runId}/${name}`;
  const sent = new Map<string, number>();
  return Context.make(KeyValues, keyValues).pipe(
    Context.add(WorkflowForge, forge),
    Context.merge(stepReferences(store, runId, name)),
    Context.add(
      Signals,
      Signals.of({
        send: Effect.fn("Signals.send")(function* (address, value, options) {
          const { signal: send } = yield* engineOf(link);
          const to = (
            "runId" in address
              ? ["run", address.runId, address.wait]
              : ["key", address.workflow, address.channel]
          )
            .map(encodeURIComponent)
            .join("/");
          const before = sent.get(to) ?? 0;
          sent.set(to, before + 1);
          return yield* send(address, value, {
            id: options?.id ?? `${owner}/signal/${to}/${before}`,
            ...(options?.ttl === undefined ? {} : { ttl: options.ttl }),
          });
        }),
        sendAll: Effect.fn("Signals.sendAll")(function* (address, value) {
          const engine = yield* engineOf(link);
          return yield* engine.signalAll(address, value);
        }),
      }),
    ),
    Context.add(
      Runs,
      Runs.of({
        start: Effect.fn("Runs.start")(function* (workflow, input, options) {
          const engine = yield* engineOf(link);
          return yield* engine.start(workflow, input, options);
        }),
        cancel: Effect.fn("Runs.cancel")(function* (target, reason) {
          // Cancelling interrupts the run, and this step is the run: it would cut itself off
          // halfway through the cancel.
          if (target === runId) {
            return yield* Effect.die(
              new Error("A run cannot cancel itself. End it from its body with `stop`."),
            );
          }
          const engine = yield* engineOf(link);
          return yield* engine.cancel(target, reason);
        }),
        list: Effect.fn("Runs.list")(function* (filter) {
          const engine = yield* engineOf(link);
          return yield* engine.list(filter);
        }),
      }),
    ),
  );
};

export const layerKeyValues = Layer.effect(
  KeyValues,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // LIKE would read `%` and `_` in a prefix as patterns; a range does not.
    const after = (prefix: string) => `${prefix}\u{10FFFF}`;
    return KeyValues.of({
      get: Effect.fn("KeyValues.get")(function* (key) {
        const rows = yield* sql<{ value_json: string }>`
          SELECT value_json FROM workflow_store WHERE key = ${key}
        `.pipe(Effect.orDie);
        return rows[0]?.value_json;
      }),
      set: Effect.fn("KeyValues.set")(function* (key, valueJson) {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO workflow_store (key, value_json, updated_at)
          VALUES (${key}, ${valueJson}, ${at})
          ON CONFLICT (key) DO UPDATE
          SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `.pipe(Effect.orDie);
      }),
      delete: Effect.fn("KeyValues.delete")(function* (key) {
        yield* sql`DELETE FROM workflow_store WHERE key = ${key}`.pipe(Effect.orDie);
      }),
      list: Effect.fn("KeyValues.list")(function* (prefix) {
        const rows = yield* sql<{ key: string; value_json: string }>`
          SELECT key, value_json FROM workflow_store
          WHERE key >= ${prefix} AND key < ${after(prefix)} ORDER BY key
        `.pipe(Effect.orDie);
        return rows.map((row) => ({ key: row.key, valueJson: row.value_json }));
      }),
      transaction: Effect.fn("KeyValues.transaction")(function* (effect) {
        return yield* sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));
      }),
    });
  }),
);

/** A value that no longer fits its schema, or never did. */
export class StoreValueError extends Schema.TaggedError<StoreValueError>()("StoreValueError", {
  key: Schema.String,
  problem: Schema.String,
}) {
  override get message(): string {
    return `The stored value at ${this.key} does not fit its schema: ${this.problem}`;
  }
}

/**
 * One key of the store, with the schema of what it holds. `update` reads and writes as one
 * action, so two runs counting on the same key never lose a count; returning `undefined` from it
 * deletes the key.
 */
const entry = <A, I>(key: string, schema: Schema.Codec<A, I>) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  const decode = Schema.decodeEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const invalid = (error: unknown) => new StoreValueError({ key, problem: String(error) });
  const read = (store: KeyValues["Service"]) =>
    Effect.flatMap(store.get(key), (text) =>
      text === undefined
        ? Effect.succeed(Option.none<A>())
        : Effect.mapBoth(decode(text), { onFailure: invalid, onSuccess: Option.some }),
    );
  const write = (store: KeyValues["Service"], value: A) =>
    encode(value).pipe(
      Effect.mapError(invalid),
      Effect.flatMap((text) => store.set(key, text)),
    );
  return {
    key,
    get: Effect.flatMap(KeyValues, read),
    set: (value: A) => Effect.flatMap(KeyValues, (store) => write(store, value)),
    delete: Effect.flatMap(KeyValues, (store) => store.delete(key)),
    update: (change: (current: Option.Option<A>) => A | undefined) =>
      Effect.flatMap(KeyValues, (store) =>
        store.transaction(
          Effect.gen(function* () {
            const next = change(yield* read(store));
            if (next === undefined) {
              yield* store.delete(key);
              return Option.none<A>();
            }
            yield* write(store, next);
            return Option.some(next);
          }),
        ),
      ),
  };
};

/** Every key that starts with `prefix`, in key order, with what it holds. */
const entries = <A, I>(prefix: string, schema: Schema.Codec<A, I>) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  const decode = Schema.decodeEffect(codec);
  return Effect.flatMap(KeyValues, (store) =>
    Effect.flatMap(store.list(prefix), (rows) =>
      Effect.forEach(rows, (row) =>
        Effect.mapBoth(decode(row.valueJson), {
          onFailure: (error) => new StoreValueError({ key: row.key, problem: String(error) }),
          onSuccess: (value) => ({ key: row.key, value }),
        }),
      ),
    ),
  );
};

/** Several reads and writes as one: all of them happen, or none. */
const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(KeyValues, (store) => store.transaction(effect));

/**
 * State that outlives a run and is shared by every workflow on this server. Use it inside `step`
 * or `onEnd`: what it returns changes over time, so the body itself must not read it.
 */
export const store = { entry, entries, transaction };

/** A workflow by its name or its definition, wherever one is named. */
export type WorkflowName = string | Pick<WorkflowDefinition, "name">;
const nameOf = (workflow: WorkflowName) =>
  typeof workflow === "string" ? workflow : workflow.name;

/**
 * Wake a run that waits: `{ runId, wait }` for one wait of one run, `{ workflow, channel }` for
 * whichever run of a workflow waits on a channel. Inside `step` or `onEnd` only.
 */
export const signal = (
  address:
    | { readonly runId: string; readonly wait: string }
    | { readonly workflow: WorkflowName; readonly channel: string },
  value: Schema.Json,
  options?: { readonly id?: string; readonly ttl?: Duration.Input },
) =>
  Effect.flatMap(Signals, (signals) => {
    checkOptions(
      "signal's address",
      address,
      "runId" in address ? ["runId", "wait"] : ["workflow", "channel"],
    );
    checkOptions("signal", options, ["id", "ttl"]);
    return signals.send(
      "runId" in address
        ? address
        : { workflow: nameOf(address.workflow), channel: address.channel },
      value,
      options,
    );
  });

/**
 * Start a run of another workflow and go on without it. The same `key` is the same run. Inside
 * `step` or `onEnd` only; to wait for the run's result, use `invoke` in the body instead.
 */
export const start = <P>(
  workflow: WorkflowDefinition<P>,
  payload: P,
  options: { readonly key: string },
) =>
  Effect.flatMap(Runs, (runs) => {
    checkOptions("start", options, ["key"]);
    return runs.start(workflow.name, payload, {
      idempotencyKey: options.key,
      version: workflow.version,
    });
  });

/**
 * Wake every run that waits on `channel`, in one workflow or, without `workflow`, in all of them.
 * Returns how many it woke. Nothing is kept for a wait that opens later, so a run that waits on
 * a condition checks the condition in a step first, and gives its wait a timeout to check again.
 * Inside `step` or `onEnd` only.
 */
export const signalAll = (
  address: { readonly channel: string; readonly workflow?: WorkflowName },
  value: Schema.Json,
) =>
  Effect.flatMap(Signals, (signals) => {
    checkOptions("signalAll's address", address, ["channel", "workflow"]);
    return signals.sendAll(
      {
        channel: address.channel,
        workflow: address.workflow === undefined ? undefined : nameOf(address.workflow),
      },
      value,
    );
  });

/**
 * Cancel another run, as a person would: its agents are stopped, its questions withdrawn, what
 * it invoked is cancelled, and its `onEnd` runs. A run that has ended is left alone. Inside
 * `step` or `onEnd` only.
 */
export const cancel = (runId: string, reason: string) =>
  Effect.flatMap(Runs, (runs) => runs.cancel(runId, reason));

/**
 * Find runs: of one workflow, in one status, or started with a key that begins with `keyPrefix`.
 * Newest first, 500 at most. Inside `step` or `onEnd` only: the answer changes over time.
 */
export const runs = (filter?: {
  readonly workflow?: WorkflowName;
  readonly status?: WorkflowRunStatus;
  readonly keyPrefix?: string;
}) =>
  Effect.flatMap(Runs, (all) => {
    checkOptions("runs", filter, ["workflow", "status", "keyPrefix"]);
    return all.list({
      workflow: filter?.workflow === undefined ? undefined : nameOf(filter.workflow),
      status: filter?.status,
      keyPrefix: filter?.keyPrefix,
    });
  });
