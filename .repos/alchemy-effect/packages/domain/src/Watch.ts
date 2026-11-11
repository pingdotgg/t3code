import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import { type Filter, matches } from "./Filter.ts";
import { decodeEnvelope, type Kernel } from "./Kernel.ts";
import * as Key from "./Key.ts";
import type {
  Json,
  Push,
  StoredEvent,
  StreamEntry,
  StreamMeta,
  Subscription,
  ViewEntry,
  ViewSnapshot,
} from "./Platform.ts";
import type * as Read from "./Read.ts";
import { contractOf, nameOf, readRpcs } from "./ReadRpcs.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";

/**
 * Pushing to live reads. A platform that holds subscriptions on its objects
 * (a WebSocket per `watch` or `events` read, on the Durable Object that owns
 * the key) asks these functions what to send after each commit. They judge
 * the change with the read's `validate`, apply its filter, and encode Effect
 * RPC messages, so a client reads a pushed stream exactly like a streamed
 * response.
 *
 * @internal
 */

interface Codecs {
  readonly chunk: (values: ReadonlyArray<unknown>) => Effect.Effect<Json, Schema.SchemaError>;
  readonly exit: (exit: Exit.Exit<void, unknown>) => Effect.Effect<Json, Schema.SchemaError>;
}

const codecCache = new WeakMap<object, Codecs>();

/** The JSON codecs Effect RPC uses for a stream RPC's chunks and exit. */
const codecsOf = (rpc: Rpc.Any): Codecs => {
  const cached = codecCache.get(rpc);
  if (cached) return cached;
  const props = rpc as Rpc.AnyWithProps;
  const success = RpcSchema.isStreamSchema(props.successSchema)
    ? props.successSchema.success
    : Schema.Any;
  const codecs: Codecs = {
    chunk: Schema.encodeUnknownEffect(
      Schema.toCodecJson(Schema.NonEmptyArray(success)),
    ) as Codecs["chunk"],
    exit: Schema.encodeUnknownEffect(
      Schema.toCodecJson(Rpc.exitSchema(rpc as Rpc.AnyWithProps)),
    ) as Codecs["exit"],
  };
  codecCache.set(rpc, codecs);
  return codecs;
};

/** Encode a read's refusal (a middleware error) as the `Exit` that ends it. */
export const refuse = (rpc: Rpc.Any, error: unknown): Effect.Effect<Json, Schema.SchemaError> =>
  codecsOf(rpc).exit(Exit.fail(error));

type Validate = (request: Read.Request<unknown>, state: unknown) => Effect.Effect<void, unknown>;

/** One item to push: the value to send (if the filter keeps it) and the state to judge. */
interface Item {
  readonly state: unknown;
  readonly value: Option.Option<unknown>;
  /** A marker (`CaughtUp`), sent as is: `validate` does not judge it. */
  readonly marker?: true;
}

/**
 * Judge each item in order and encode what passes: one `Chunk` of the kept
 * values, then, if `validate` rejected an item, the `Exit` that ends the read.
 */
const encode = (
  entry: View.Any | Aggregate.Any | DomainStream.Any,
  subscription: Subscription,
  ref: unknown,
  items: ReadonlyArray<Item>,
  cursor: number,
): Effect.Effect<Push> =>
  Effect.gen(function* () {
    const rpcs = readRpcs(entry);
    const rpc = subscription.mode === "watch" ? rpcs.watch : rpcs.events;
    const codecs = codecsOf(rpc);
    const validate = contractOf(entry).validate as Validate | undefined;
    const context = yield* RequestContext.restore(subscription.context);
    const values: Array<unknown> = [];
    let rejection: Option.Option<unknown> = Option.none();
    for (const item of items) {
      if (validate && !item.marker) {
        const judged = yield* validate({ mode: subscription.mode, key: ref }, item.state).pipe(
          Effect.provideContext(context),
          Effect.result,
        );
        if (judged._tag === "Failure") {
          rejection = Option.some(judged.failure);
          break;
        }
      }
      if (Option.isSome(item.value)) values.push(item.value.value);
    }
    const messages: Array<Json> = [];
    if (values.length > 0) {
      messages.push({
        _tag: "Chunk",
        requestId: subscription.requestId,
        values: yield* codecs.chunk(values),
      });
    }
    if (Option.isSome(rejection)) {
      messages.push({
        _tag: "Exit",
        requestId: subscription.requestId,
        exit: yield* codecs.exit(Exit.fail(rejection.value)),
      });
    }
    return {
      messages,
      subscription: { ...subscription, cursor },
      done: Option.isSome(rejection),
    };
  }).pipe(Effect.orDie);

/**
 * The first push of an `events` read is its history: mark its end once, with
 * a `CaughtUp` item after the history's items.
 */
const markCaughtUp = (subscription: Subscription, items: ReadonlyArray<Item>, cursor: number) =>
  subscription.caughtUpSent
    ? { subscription, items }
    : {
        subscription: { ...subscription, caughtUpSent: true },
        items: [
          ...items,
          {
            state: null,
            value: Option.some({ _tag: "CaughtUp", cursor }),
            marker: true,
          } satisfies Item,
        ],
      };

const where = (subscription: Subscription) => subscription.where as Filter<unknown> | undefined;

/** What a view key's subscriber receives after a commit (or when it connects). */
export const viewPush =
  (kernel: Kernel, view: View.Any) =>
  (
    key: string,
    subscription: Subscription,
    snapshot: ViewSnapshot,
    entries: ReadonlyArray<ViewEntry>,
  ): Effect.Effect<Push> =>
    Effect.gen(function* () {
      const ref = Key.refOf(view.definition.key, key);
      if (subscription.mode === "watch") {
        if (snapshot.version <= subscription.cursor) {
          return { messages: [], subscription, done: false };
        }
        const state = snapshot.state === null ? null : kernel.decodeViewState(view, snapshot.state);
        const visible = state !== null && matches(where(subscription), state) ? state : null;
        return yield* encode(
          view,
          subscription,
          ref,
          [{ state, value: Option.some({ state: visible, cursor: snapshot.seq }) }],
          snapshot.version,
        );
      }
      const fresh = entries.filter((entry) => entry.seq > subscription.cursor);
      const items = yield* Effect.forEach(fresh, (stored) =>
        Effect.map(kernel.decodeViewEntry(view, stored), (decoded): Item => ({
          state: decoded.state,
          value: matches(where(subscription), decoded.event) ? Option.some(decoded) : Option.none(),
        })),
      );
      const cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : subscription.cursor;
      const marked = markCaughtUp(subscription, items, cursor);
      return yield* encode(view, marked.subscription, ref, marked.items, cursor);
    });

/** What an aggregate instance's subscriber receives after a commit (or when it connects). */
export const aggregatePush =
  (kernel: Kernel, aggregate: Aggregate.Any) =>
  (
    id: string,
    subscription: Subscription,
    current: { readonly state: Json; readonly version: number },
    events: ReadonlyArray<StoredEvent>,
  ): Effect.Effect<Push> =>
    Effect.gen(function* () {
      const ref = { aggregate: nameOf(aggregate), id } as Aggregate.Ref;
      const state = kernel.decodeState(aggregate, current.state);
      if (subscription.mode === "watch") {
        if (current.version <= subscription.cursor) {
          return { messages: [], subscription, done: false };
        }
        return yield* encode(
          aggregate,
          subscription,
          ref,
          [{ state, value: Option.some({ state, cursor: current.version }) }],
          current.version,
        );
      }
      const fresh = events.filter((stored) => stored.envelope.seq > subscription.cursor);
      // Judged against the instance's state now, since events carry no state.
      const items = yield* Effect.forEach(fresh, (stored) =>
        Effect.map(kernel.decodeEvent(stored.event), (event): Item => ({
          state,
          value: Option.some({ event, envelope: decodeEnvelope(stored.envelope) }),
        })),
      );
      const cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.envelope.seq : subscription.cursor;
      const marked = markCaughtUp(subscription, items, cursor);
      return yield* encode(aggregate, marked.subscription, ref, marked.items, cursor);
    });

/** What a stream key's subscriber receives after an append (or when it connects). */
export const streamPush =
  (kernel: Kernel, stream: DomainStream.Any) =>
  (
    key: string,
    subscription: Subscription,
    meta: StreamMeta,
    entries: ReadonlyArray<StreamEntry>,
    latest: StreamEntry | undefined,
  ): Effect.Effect<Push> =>
    Effect.gen(function* () {
      const ref = Key.refOf(stream.definition.key, key);
      if (subscription.mode === "watch") {
        if (meta.seq <= subscription.cursor) {
          return { messages: [], subscription, done: false };
        }
        const decoded = latest ? yield* kernel.decodeStreamEntry(latest) : null;
        return yield* encode(
          stream,
          subscription,
          ref,
          [{ state: decoded, value: Option.some({ state: decoded, cursor: meta.seq }) }],
          meta.seq,
        );
      }
      const fresh = entries.filter((entry) => entry.seq > subscription.cursor);
      // Each entry is judged as the key's latest entry at that point.
      const items = yield* Effect.forEach(fresh, (stored) =>
        Effect.map(kernel.decodeStreamEntry(stored), (decoded): Item => ({
          state: decoded,
          value: matches(where(subscription), decoded.event) ? Option.some(decoded) : Option.none(),
        })),
      );
      const cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : subscription.cursor;
      const marked = markCaughtUp(subscription, items, cursor);
      return yield* encode(stream, marked.subscription, ref, marked.items, cursor);
    });
