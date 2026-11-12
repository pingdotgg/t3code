// What a step's own code may use besides plain Effect: state shared between runs, and a way to
// wake a run that waits. Both touch the world, so they are for inside `step` and `onEnd`.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WorkflowInputError } from "./Workflows.ts";
import type { SignalAddress } from "./WorkflowStore.ts";

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

/** Signals from the step that is running. Its signals are numbered, so a retry sends the same ones. */
export class Signals extends Context.Service<
  Signals,
  {
    readonly send: (
      address: SignalAddress,
      value: Schema.Json,
      options?: { readonly id?: string; readonly ttl?: Duration.Input },
    ) => Effect.Effect<"delivered" | "buffered", WorkflowInputError>;
  }
>()("t3/workflows/stepServices/Signals") {}

export type InStep = KeyValues | Signals;

/**
 * The engine's way to send a signal, which exists only once the engine does, while the workflows
 * that use it are registered before. The engine fills this in when it starts.
 */
export class SignalSender extends Context.Service<
  SignalSender,
  { current: SendSignal | undefined }
>()("t3/workflows/stepServices/SignalSender") {}
export const layerSignalSender = Layer.sync(SignalSender, () => ({ current: undefined }));

/** The services for one step. `owner` names it, and each signal it sends is `owner` and a number. */
export const forStep = (
  keyValues: KeyValues["Service"],
  sender: SignalSender["Service"],
  owner: string,
): Context.Context<InStep> => {
  let sent = 0;
  return Context.make(KeyValues, keyValues).pipe(
    Context.add(
      Signals,
      Signals.of({
        send: Effect.fn("Signals.send")(function* (address, value, options) {
          const send = sender.current;
          if (send === undefined)
            return yield* Effect.die(new Error("The workflow engine is not up."));
          return yield* send(address, value, {
            id: options?.id ?? `${owner}/signal/${sent++}`,
            ...(options?.ttl === undefined ? {} : { ttl: options.ttl }),
          });
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

/**
 * Wake a run that waits: `{ runId, wait }` for one wait of one run, `{ workflow, key }` for
 * whichever run of a workflow waits on a key. Inside `step` or `onEnd` only.
 */
export const signal = (
  address: SignalAddress,
  value: Schema.Json,
  options?: { readonly id?: string; readonly ttl?: Duration.Input },
) => Effect.flatMap(Signals, (signals) => signals.send(address, value, options));
