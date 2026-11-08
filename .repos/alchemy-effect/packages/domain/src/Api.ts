import type { HttpEffect } from "alchemy/Http";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Exit from "effect/Exit";
import type * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMessage from "effect/rpc/RpcMessage";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import type * as Aggregate from "./Aggregate.ts";
import * as Command from "./Command.ts";
import { DefinitionError, NotInModel, Unreadable, UnroutedCommand } from "./DefinitionError.ts";
import { type Filter, matches } from "./Filter.ts";
import { decodeEnvelope } from "./Kernel.ts";
import * as Key from "./Key.ts";
import * as Middleware from "./Middleware.ts";
import * as Model from "./Model.ts";
import {
  type AggregateStore,
  captureContext,
  type StreamStore,
  type Subscription,
  type ViewStore,
} from "./Platform.ts";
import type * as Read from "./Read.ts";
import { contractOf, nameOf, readRpcs } from "./ReadRpcs.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";
import * as Watch from "./Watch.ts";

/**
 * What an Api exposes: commands (writes); views, streams, and aggregates that
 * declare a `read` contract (reads).
 */
export type Servable = Command.Any | View.Any | Aggregate.Any | DomainStream.Any;

/** The names of the commands a model holds: their tags. */
export type CommandName<M extends Model.Any> = M["commands"][number]["tag"];
/** The names of the views a model holds. */
export type ViewName<M extends Model.Any> = M["views"][number]["viewName"];
/** The names of the streams a model holds. */
export type StreamName<M extends Model.Any> = M["streams"][number]["streamName"];
/** The names of the aggregates a model holds that declare `read`, so an Api may serve them. */
export type AggregateName<M extends Model.Any> = ReadableName<M["aggregates"][number]>;

/** An aggregate's name, unless its type says it declared no `read`. */
type ReadableName<A> = A extends Aggregate.Any
  ? [A["definition"]["read"]] extends [undefined]
    ? never
    : A["aggregateName"]
  : never;

/**
 * What {@link make} takes: the model, and the names of what of it the Api
 * serves. A kind it does not list is served whole: every command, view and
 * stream of the model, and every aggregate that declares `read`. `[]` serves
 * none of a kind.
 */
export interface Options<
  M extends Model.Any,
  C extends ReadonlyArray<CommandName<M>>,
  V extends ReadonlyArray<ViewName<M>>,
  S extends ReadonlyArray<StreamName<M>>,
  A extends ReadonlyArray<AggregateName<M>>,
> {
  /** The model the Api is over. */
  readonly model: M;
  /** The commands a client may send. Every command of the model by default. */
  readonly commands?: C;
  /** The views a client may read. Every view of the model by default. */
  readonly views?: V;
  /** The streams a client may read. Every stream of the model by default. */
  readonly streams?: S;
  /** The aggregates a client may read directly, through their `read` contract. Every one that declares `read` by default. */
  readonly aggregates?: A;
}

/** What an Api over `M` serves, from the names it lists. */
export type ServedBy<
  M extends Model.Any,
  C extends ReadonlyArray<string>,
  V extends ReadonlyArray<string>,
  S extends ReadonlyArray<string>,
  A extends ReadonlyArray<string>,
> =
  | Extract<M["commands"][number], { readonly tag: C[number] }>
  | Extract<M["views"][number], { readonly viewName: V[number] }>
  | Extract<M["streams"][number], { readonly streamName: S[number] }>
  | Extract<M["aggregates"][number], { readonly aggregateName: A[number] }>;

type Commands<E extends Servable> = Extract<E, Command.Any>;
type Views<E extends Servable> = Extract<E, View.Any>;
type Streams<E extends Servable> = Extract<E, DomainStream.Any>;
type Aggregates<E extends Servable> = Exclude<E, Command.Any | View.Any | DomainStream.Any>;

// ---------------------------------------------------------------- client types

type ContractOf<D> = D extends Read.AnyContract ? D : never;
type RejectionOf<D> = Aggregate.InstanceOf<NonNullable<ContractOf<D>["rejects"]>[number]>;
type MiddlewareOf<D> = NonNullable<ContractOf<D>["middleware"]>;

/** Everything a read can fail with: the declared rejections, the middleware's errors, transport. */
export type ReadError<D> =
  | RejectionOf<D>
  | Middleware.Errors<MiddlewareOf<D>>
  | RpcClientError.RpcClientError;

interface CallOptions {
  readonly headers?: Headers.Input;
}

/** The typed client of a view exposed in an Api. */
export interface ViewClient<V extends View.Any> {
  /** The key's current state (`null` if it does not exist or the filter excludes it). */
  readonly get: (
    key: Key.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly where?: Filter<View.StateOf<V>>;
    },
  ) => Effect.Effect<View.StateOf<V> | null, ReadError<V["definition"]> | View.ConsistencyTimeout>;
  /**
   * The key's state with its cursor, then every change. Ends with a rejection
   * when `validate` stops allowing it.
   */
  readonly watch: (
    key: Key.IdOf<View.KeyOf<V>>,
    options?: CallOptions & { readonly where?: Filter<View.StateOf<V>> },
  ) => Stream.Stream<Read.Snapshot<View.StateOf<V> | null>, ReadError<V["definition"]>>;
  /**
   * The events the key emitted, each with the state after it: history from
   * `after` (a cursor), a {@link Read.CaughtUp} frame, then live events.
   */
  readonly events: (
    key: Key.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      readonly after?: number;
      readonly where?: Filter<View.EventOf<V>>;
    },
  ) => Stream.Stream<
    View.Entry<View.StateOf<V>, View.EventOf<V>, Key.IdOf<View.KeyOf<V>>> | Read.CaughtUp,
    ReadError<V["definition"]>
  >;
  /** A page of the key's emitted events. */
  readonly list: (
    key: Key.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly where?: Filter<View.EventOf<V>>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: number;
    },
  ) => Effect.Effect<
    View.Page<View.Entry<View.StateOf<V>, View.EventOf<V>, Key.IdOf<View.KeyOf<V>>>>,
    ReadError<V["definition"]> | View.ConsistencyTimeout
  >;
  /**
   * The key's state and the cursor it is valid at, read together. Render the
   * state, then follow `events(key, { after: cursor })`: every later change
   * arrives once, and none is missed.
   */
  readonly snapshot: (
    key: Key.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly where?: Filter<View.StateOf<V>>;
    },
  ) => Effect.Effect<
    Read.Snapshot<View.StateOf<V> | null>,
    ReadError<V["definition"]> | View.ConsistencyTimeout
  >;
}

/** The typed client of a stream exposed in an Api. */
export interface StreamClient<S extends DomainStream.Any> {
  /** The key's latest entry, or `null` if nothing was appended. */
  readonly peek: (
    key: Key.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      /** Wait until the stream's writer has handled this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
    },
  ) => Effect.Effect<
    DomainStream.Entry<DomainStream.EventOf<S>, Key.IdOf<DomainStream.KeyOf<S>>> | null,
    ReadError<S["definition"]> | View.ConsistencyTimeout
  >;
  /**
   * The key's latest entry (`null` before any) with its cursor, then each new
   * one. Ends with a rejection when `validate` stops allowing it.
   */
  readonly watch: (
    key: Key.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions,
  ) => Stream.Stream<
    Read.Snapshot<DomainStream.Entry<
      DomainStream.EventOf<S>,
      Key.IdOf<DomainStream.KeyOf<S>>
    > | null>,
    ReadError<S["definition"]>
  >;
  /** The key's entries from `after` (a cursor), a {@link Read.CaughtUp} frame, then live ones. */
  readonly events: (
    key: Key.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      readonly after?: number;
      readonly where?: Filter<DomainStream.EventOf<S>>;
    },
  ) => Stream.Stream<
    DomainStream.Entry<DomainStream.EventOf<S>, Key.IdOf<DomainStream.KeyOf<S>>> | Read.CaughtUp,
    ReadError<S["definition"]>
  >;
  /** A page of the key's entries. */
  readonly list: (
    key: Key.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      readonly where?: Filter<DomainStream.EventOf<S>>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: number;
    },
  ) => Effect.Effect<
    View.Page<DomainStream.Entry<DomainStream.EventOf<S>, Key.IdOf<DomainStream.KeyOf<S>>>>,
    ReadError<S["definition"]>
  >;
}

/** A committed event of an aggregate, as a client receives it. */
export interface Recorded<E, Id> {
  readonly event: E;
  readonly envelope: Aggregate.Envelope<Id>;
}

/** The typed client of an aggregate exposed in an Api (through its `read` contract). */
export interface AggregateClient<A extends Aggregate.Any> {
  /** The instance's current state. */
  readonly get: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions,
  ) => Effect.Effect<Aggregate.StateOf<A>, ReadError<A["definition"]["read"]>>;
  /** The instance's state with its cursor, then its state after every commit. */
  readonly watch: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions,
  ) => Stream.Stream<Read.Snapshot<Aggregate.StateOf<A>>, ReadError<A["definition"]["read"]>>;
  /**
   * The instance's committed events: history from `after` (a cursor), a
   * {@link Read.CaughtUp} frame, then live.
   */
  readonly events: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions & { readonly after?: number },
  ) => Stream.Stream<
    Recorded<Aggregate.EventOf<A>, Aggregate.IdOf<A>> | Read.CaughtUp,
    ReadError<A["definition"]["read"]>
  >;
}

/** How a command is sent: its idempotency key and the call's headers. */
export interface CommandOptions extends CallOptions {
  /** A resend with the same id returns the first receipt instead of deciding again. */
  readonly commandId?: string;
}

/** The input and options after a command's target. The input may be left out when it has no required field. */
type CommandArgs<Input> = {} extends Input
  ? [input?: Input, options?: CommandOptions]
  : [input: Input, options?: CommandOptions];

/** The typed client of a command exposed in an Api: `bank.WithdrawMoney(target, input, options)`. */
export type CommandClient<C extends Command.Any> =
  C["rpc"] extends Rpc.Rpc<
    infer _Tag,
    infer Payload,
    infer Success,
    infer Error,
    infer Middleware,
    infer _Requires
  >
    ? Payload["Type"] extends { readonly target: infer Target; readonly input: infer Input }
      ? (
          target: Target,
          ...args: CommandArgs<Input>
        ) => Effect.Effect<
          Success["Type"],
          | Error["Type"]
          | Middleware["error"]["Type"]
          | Middleware["~ClientError"]
          | RpcClientError.RpcClientError,
          | Payload["EncodingServices"]
          | Success["DecodingServices"]
          | Error["DecodingServices"]
          | Middleware["error"]["DecodingServices"]
        >
      : never
    : never;

/**
 * The typed client of an Api: commands as methods (`bank.WithdrawMoney(...)`),
 * views and aggregates as namespaces (`bank.AccountSummary.watch(...)`).
 */
export type ApiClient<E extends Servable> = {
  readonly [C in Commands<E> as C["tag"]]: CommandClient<C>;
} & {
  readonly [V in Views<E> as V["viewName"]]: ViewClient<V>;
} & {
  readonly [S in Streams<E> as S["streamName"]]: StreamClient<S>;
} & {
  readonly [A in Aggregates<E> as A["aggregateName"]]: AggregateClient<A>;
};

/** Type-level identity of an Api's client service. */
export interface ClientKey<Name extends string> {
  readonly "~alchemy/Domain/Api/Client": Name;
}

/** What `yield* MyApi` gives a Worker: the Api served over HTTP. */
export interface ApiServer {
  /** Use as the Worker's `fetch`. Commands and reads over HTTP; live reads over WebSockets. */
  readonly fetch: HttpEffect;
}

/**
 * The class type returned by {@link make}. The class is itself an Effect:
 * `yield* MyApi` serves it, requiring the hosted Domain and the Layers of every
 * middleware what it serves declares.
 */
export interface ApiClass<
  Name extends string,
  Serves extends ReadonlyArray<Servable>,
> extends Effect.Effect<ApiServer, never, Model.Internals | MiddlewareServices<Serves>> {
  new (_: never): {};
  readonly kind: "Api";
  readonly apiName: Name;
  /** The model this Api is over. */
  readonly model: Model.Any;
  /** The commands, views, streams and aggregates this Api serves. */
  readonly serves: Serves;
  /** The command classes this Api exposes, in the order it lists them. */
  readonly commands: ReadonlyArray<Commands<Serves[number]>>;
  /**
   * One Schema for every rejection this Api's commands declare: a union of the
   * rejection classes, each once, decoding to class instances as the client
   * fails with them. `Schema.Never` when no command rejects.
   */
  readonly rejections: RejectionUnion<Commands<Serves[number]>["rejects"][number]>;
  /** The underlying Effect RPC group. */
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  /**
   * A typed client. Provide a protocol: {@link protocolHttp},
   * {@link protocolWebSocket} or {@link protocolInProcess}.
   */
  readonly client: Effect.Effect<
    ApiClient<Serves[number]>,
    never,
    Scope.Scope | RpcClient.Protocol | MiddlewareClients<Serves>
  >;
  /** The client as a service, for code that uses it without owning the connection. */
  readonly Client: Context.Service<ClientKey<Name>, ApiClient<Serves[number]>>;
  /** Build {@link Client} for the life of the Layer, over the protocol provided to it. */
  readonly layerClient: Layer.Layer<
    ClientKey<Name>,
    never,
    RpcClient.Protocol | MiddlewareClients<Serves>
  >;
  /** {@link client} over {@link protocolHttp}. */
  readonly clientHttp: (
    url: string,
  ) => Effect.Effect<
    ApiClient<Serves[number]>,
    never,
    Scope.Scope | HttpClient.HttpClient | MiddlewareClients<Serves>
  >;
  /** {@link layerClient} over {@link protocolHttp}. */
  readonly layerClientHttp: (
    url: string,
  ) => Layer.Layer<ClientKey<Name>, never, HttpClient.HttpClient | MiddlewareClients<Serves>>;
  /** {@link client} over {@link protocolWebSocket}. */
  readonly clientWebSocket: (
    url: string,
  ) => Effect.Effect<
    ApiClient<Serves[number]>,
    never,
    Scope.Scope | HttpClient.HttpClient | Socket.WebSocketConstructor | MiddlewareClients<Serves>
  >;
  /** {@link layerClient} over {@link protocolWebSocket}. */
  readonly layerClientWebSocket: (
    url: string,
  ) => Layer.Layer<
    ClientKey<Name>,
    never,
    HttpClient.HttpClient | Socket.WebSocketConstructor | MiddlewareClients<Serves>
  >;
  /** {@link client} over {@link protocolInProcess}. In a Worker, build it per request. */
  readonly clientInProcess: Effect.Effect<
    ApiClient<Serves[number]>,
    never,
    Scope.Scope | Model.Internals | MiddlewareServices<Serves> | MiddlewareClients<Serves>
  >;
  /** {@link layerClient} over {@link protocolInProcess}. */
  readonly layerClientInProcess: Layer.Layer<
    ClientKey<Name>,
    never,
    Model.Internals | MiddlewareServices<Serves> | MiddlewareClients<Serves>
  >;
}

type EntryMiddleware<E> = E extends Command.Any
  ? E["middleware"][number]
  : E extends View.Any | DomainStream.Any
    ? NonNullable<E["definition"]["middleware"]>[number]
    : E extends Aggregate.Any
      ? NonNullable<NonNullable<E["definition"]["read"]>["middleware"]>[number]
      : never;

/** The middleware services the server needs for every entry. */
type MiddlewareServices<Serves extends ReadonlyArray<Servable>> =
  EntryMiddleware<Serves[number]> extends infer M
    ? M extends RpcMiddleware.AnyService
      ? M["Identifier"]
      : never
    : never;

/** The client-side middleware every entry needs (e.g. attaching a session token). */
type MiddlewareClients<Serves extends ReadonlyArray<Servable>> =
  EntryMiddleware<Serves[number]> extends infer M
    ? M extends RpcMiddleware.AnyService
      ? M extends { readonly requiredForClient: true }
        ? RpcMiddleware.ForClient<M["Identifier"]>
        : never
      : never
    : never;

const rpcsOf = (entry: Servable): ReadonlyArray<Rpc.Any> =>
  entry.kind === "Command" ? [entry.rpc] : Object.values(readRpcs(entry));

// ---------------------------------------------------------------- handlers

/**
 * Only an entry's declared errors are public. Anything else (an
 * infrastructure error, an undeclared rejection) becomes a defect, so it
 * never leaks as a typed error the client cannot decode.
 */
const declaredOnly = (rpc: Rpc.Any) => {
  const props = rpc as Rpc.AnyWithProps;
  const isDeclared = Schema.is(props.errorSchema);
  const success = props.successSchema as Schema.Top & { readonly error?: Schema.Top };
  const isDeclaredInStream = success.error ? Schema.is(success.error) : isDeclared;
  return {
    effect: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.catchIf(
        effect,
        (e) => !isDeclared(e),
        (e) => Effect.die(e),
      ),
    stream: <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      Stream.catchIf(
        stream,
        (e) => !isDeclaredInStream(e),
        (e) => Stream.die(e),
      ),
  };
};

/** The wire payload of a command: its target, an optional command id, and its input. */
interface CommandPayload {
  readonly target: string;
  readonly commandId?: string;
  readonly input: object;
}

interface ReadPayload {
  readonly key: string;
  readonly where?: unknown;
  readonly atLeast?: { readonly stream: string; readonly version: number };
  readonly after?: number;
  readonly order?: "asc" | "desc";
  readonly take?: number;
}

const caughtUpAt = (seq: number): Read.CaughtUp => ({ _tag: "CaughtUp", cursor: seq });

/**
 * A key's events from `start`, with a `CaughtUp` frame after its history: the
 * events up to `end`, the key's `seq` when the read began. `keep` judges and
 * filters each event after the end is found, so a filtered-out last event
 * still ends the history.
 */
const withCaughtUp = <A>(
  start: number,
  end: number,
  events: Stream.Stream<A, unknown>,
  seqOf: (event: A) => number,
  keep: (event: A) => Effect.Effect<ReadonlyArray<unknown>, unknown>,
): Stream.Stream<unknown, unknown> => {
  let sent = start >= end;
  const rest = events.pipe(
    Stream.mapEffect((event) =>
      keep(event).pipe(
        Effect.map((out) => {
          if (sent || seqOf(event) < end) return out;
          sent = true;
          return [...out, caughtUpAt(seqOf(event))];
        }),
      ),
    ),
    Stream.flatMap((out) => Stream.fromIterable(out)),
  );
  return start >= end ? Stream.concat(Stream.succeed(caughtUpAt(start)), rest) : rest;
};

type Handler = (input: never) => unknown;

/**
 * The first thing an Api lists that it cannot serve: a name its model does
 * not hold, or an aggregate without a `read` contract. The type of the
 * options rules both out; this catches a model typed as `Model.Any`.
 */
/** Why an Api cannot serve something it lists. */
type Unservable = NotInModel | Unreadable;

const notInModel = (
  _apiModel: Model.Any,
  unresolved: ReadonlyArray<Unservable>,
): DefinitionError | undefined =>
  unresolved.length === 0 ? undefined : new DefinitionError({ reason: unresolved[0]! });

const handlersOf = (
  apiModel: Model.Any,
  entries: ReadonlyArray<Servable>,
  unresolved: ReadonlyArray<Unservable>,
): Effect.Effect<Record<string, Handler>, never, Model.Internals> =>
  Effect.gen(function* () {
    const problem = notInModel(apiModel, unresolved);
    if (problem) return yield* Effect.die(problem);
    const internals = yield* Model.Internals;
    const handlers: Record<string, Handler> = {};
    for (const entry of entries) {
      if (entry.kind === "Command") {
        const aggregate = internals.commands.get(entry.tag);
        if (!aggregate) {
          return yield* Effect.die(
            new DefinitionError({ reason: new UnroutedCommand({ command: entry.tag }) }),
          );
        }
        const declared = declaredOnly(entry.rpc);
        // Runs inside the command's middleware, so the context it provides
        // (the session's actor) travels with the command to its aggregate.
        handlers[entry.tag] = ({ target, commandId, input }: CommandPayload) =>
          declared.effect(
            // oxlint-disable-next-line effecttsgo/new-schema-class -- `make` on a generic command class loses its instance type
            aggregate.send(target, new entry(input), { commandId }).pipe(
              Effect.map((receipt) => ({
                reply: receipt.reply,
                stream: receipt.stream,
                version: receipt.version,
              })),
            ),
          );
        continue;
      }
      // Serving an aggregate's state without its read contract would skip its middleware.
      if (entry.kind === "Aggregate" && !entry.definition.read) {
        return yield* Effect.die(
          new DefinitionError({ reason: new Unreadable({ aggregate: entry.aggregateName }) }),
        );
      }
      const name = nameOf(entry);
      const rpcs = readRpcs(entry);
      const validate = contractOf(entry).validate as
        | ((request: Read.Request<unknown>, state: unknown) => Effect.Effect<void, unknown>)
        | undefined;
      const check = (mode: Read.Mode, key: unknown) => (state: unknown) =>
        validate ? validate({ mode, key }, state) : Effect.void;
      const effect =
        (rpc: Rpc.Any, handle: (payload: ReadPayload) => Effect.Effect<unknown, unknown>) =>
        (payload: ReadPayload) =>
          declaredOnly(rpc).effect(handle(payload));
      const stream =
        (rpc: Rpc.Any, handle: (payload: ReadPayload) => Stream.Stream<unknown, unknown>) =>
        (payload: ReadPayload) =>
          declaredOnly(rpc).stream(handle(payload));

      if (entry.kind === "Stream") {
        const host = internals.streamHosts.get(name)!;
        const key = entry.definition.key;
        const refOf = (id: string) => Key.refOf(key, id);
        const latest = (id: string) =>
          host.peek(refOf(id)).pipe(Effect.orDie, Effect.map(Option.getOrNull));
        handlers[`${name}.peek`] = effect(rpcs.get, ({ key: id, atLeast }) =>
          host.peek(refOf(id), { atLeast }).pipe(
            Effect.flatMap((found) => {
              const entry = Option.getOrNull(found);
              return check("get", refOf(id))(entry).pipe(Effect.as(entry));
            }),
          ),
        );
        handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id }) =>
          host.watch(refOf(id)).pipe(
            Stream.mapEffect((found) => {
              const entry = Option.getOrNull(found);
              return check(
                "watch",
                refOf(id),
              )(entry).pipe(Effect.as({ state: entry, cursor: entry?.envelope.seq ?? 0 }));
            }),
          ),
        );
        handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after, where }) => {
          const start = after ?? 0;
          return Stream.unwrap(
            latest(id).pipe(
              Effect.map((last) =>
                withCaughtUp(
                  start,
                  last?.envelope.seq ?? 0,
                  host.events(refOf(id), { after: start }),
                  (entry) => entry.envelope.seq,
                  // Each entry is judged as the key's latest entry at that point.
                  (entry) =>
                    matches(where as Filter<unknown> | undefined, entry.event)
                      ? check("events", refOf(id))(entry).pipe(Effect.as([entry]))
                      : Effect.succeed([]),
                ),
              ),
            ),
          );
        });
        handlers[`${name}.list`] = effect(rpcs.list!, ({ key: id, where, order, take, after }) =>
          latest(id).pipe(
            Effect.flatMap((entry) => check("list", refOf(id))(entry)),
            Effect.andThen(
              host.list(refOf(id), {
                where: where as Filter<unknown> | undefined,
                order,
                take,
                after,
              }),
            ),
          ),
        );
        continue;
      }

      if (entry.kind === "View") {
        const host = internals.viewHosts.get(name)!;
        const key = entry.definition.key;
        const refOf = (id: string) => Key.refOf(key, id);
        const visible = (state: unknown, where: unknown) =>
          state !== null && matches(where as Filter<unknown> | undefined, state) ? state : null;
        handlers[`${name}.get`] = effect(rpcs.get, ({ key: id, atLeast, where }) =>
          host.query(refOf(id), { atLeast }).pipe(
            Effect.flatMap((found) => {
              const state = Option.getOrNull(found);
              return check("get", refOf(id))(state).pipe(Effect.as(visible(state, where)));
            }),
          ),
        );
        const viewStore = internals.views.get(name)!;
        // From the stored snapshots, so each state comes with the seq it is valid at.
        handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id, where }) =>
          viewStore.changes(id).pipe(
            Stream.mapEffect((snapshot) => {
              const state =
                snapshot.state === null
                  ? null
                  : internals.kernel.decodeViewState(entry, snapshot.state);
              return check(
                "watch",
                refOf(id),
              )(state).pipe(Effect.as({ state: visible(state, where), cursor: snapshot.seq }));
            }),
          ),
        );
        handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after, where }) => {
          const start = after ?? 0;
          return Stream.unwrap(
            viewStore.read(id).pipe(
              Effect.map((snapshot) =>
                withCaughtUp(
                  start,
                  snapshot.seq,
                  host.events(refOf(id), { after: start }),
                  (entry) => entry.envelope.seq,
                  (entry) =>
                    matches(where as Filter<unknown> | undefined, entry.event)
                      ? check("events", refOf(id))(entry.state).pipe(Effect.as([entry]))
                      : Effect.succeed([]),
                ),
              ),
            ),
          );
        });
        handlers[`${name}.snapshot`] = effect(rpcs.snapshot!, ({ key: id, atLeast, where }) =>
          host
            .snapshot(refOf(id), { atLeast })
            .pipe(
              Effect.flatMap(({ state, cursor }) =>
                check(
                  "get",
                  refOf(id),
                )(state).pipe(Effect.as({ state: visible(state, where), cursor })),
              ),
            ),
        );
        handlers[`${name}.list`] = effect(
          rpcs.list!,
          ({ key: id, atLeast, where, order, take, after }) =>
            host.query(refOf(id), { atLeast }).pipe(
              Effect.flatMap((found) => found.pipe(Option.getOrNull, check("list", refOf(id)))),
              Effect.andThen(
                host.list(refOf(id), {
                  where: where as Filter<unknown> | undefined,
                  order,
                  take,
                  after,
                }),
              ),
            ),
        );
        continue;
      }

      const store = internals.aggregates.get(name)!;
      const refOf = (id: string) => ({ aggregate: name, id });
      const stateOf = (json: unknown) => internals.kernel.decodeState(entry, json);
      handlers[`${name}.get`] = effect(rpcs.get, ({ key: id }) =>
        store.state(id).pipe(
          Effect.flatMap(({ state }) => {
            const decoded = stateOf(state);
            return check("get", refOf(id))(decoded).pipe(Effect.as(decoded));
          }),
        ),
      );
      handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id }) =>
        store.changes(id).pipe(
          Stream.mapEffect(({ state, version }) => {
            const decoded = stateOf(state);
            return check(
              "watch",
              refOf(id),
            )(decoded).pipe(Effect.as({ state: decoded, cursor: version }));
          }),
        ),
      );
      handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after }) => {
        const start = after ?? 0;
        return Stream.unwrap(
          store.state(id).pipe(
            Effect.map(({ version }) =>
              withCaughtUp(
                start,
                version,
                store.tail(id, start),
                (stored) => stored.envelope.seq,
                // Judged against the instance's state now, since events carry no state.
                (stored) =>
                  store.state(id).pipe(
                    Effect.flatMap(({ state }) => check("events", refOf(id))(stateOf(state))),
                    Effect.andThen(internals.kernel.decodeEvent(stored.event)),
                    Effect.map((event) => [{ event, envelope: decodeEnvelope(stored.envelope) }]),
                  ),
              ),
            ),
          ),
        );
      });
    }
    return handlers;
  });

// ---------------------------------------------------------------- live reads

/** The query parameter carrying a live read's request (a WebSocket upgrade cannot carry a body). */
const LIVE_PARAM = "read";

/**
 * A live read as the client sends it: the Effect RPC request's id, tag and
 * payload, plus the cursor to resume from after a reconnect. Never headers:
 * a URL ends up in logs, so a live read authenticates with what its upgrade
 * request carries (in a browser, its cookies).
 */
const LiveRequest = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  tag: Schema.String,
  payload: Schema.Unknown,
  cursor: Schema.optional(Schema.Number),
  /** The client's span, as the RPC protocol carries it, so the read joins the caller's trace. */
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean),
});
type LiveRequest = typeof LiveRequest.Type;

const decodeLiveRequest = Schema.decodeUnknownOption(Schema.fromJsonString(LiveRequest));

/** The live read the current request asks for, if its query parameter decodes. */
const liveRequestOf = (request: { readonly url: string }): LiveRequest | undefined => {
  const raw = new URL(request.url, "http://localhost").searchParams.get(LIVE_PARAM);
  return raw === null ? undefined : Option.getOrUndefined(decodeLiveRequest(raw));
};

/**
 * Serve live reads (`watch` and `events`) as WebSockets. The read's
 * middleware runs here, in the Worker, against the upgrade request's own
 * headers (cookies, in a browser); the context it provides travels with
 * the subscription to the object that owns the key, which pushes to the
 * socket on every commit. A refused read still connects, to deliver its
 * typed rejection.
 */
const liveReads = (
  entries: ReadonlyArray<Servable>,
  internals: Model.Internals["Service"],
  middleware: Context.Context<never>,
) => {
  const reads = new Map<
    string,
    {
      readonly rpc: Rpc.AnyWithProps;
      readonly mode: "watch" | "events";
      readonly store?: AggregateStore | ViewStore | StreamStore;
    }
  >();
  for (const entry of entries) {
    if (entry.kind === "Command") continue;
    const name = nameOf(entry);
    const store =
      entry.kind === "View"
        ? internals.views.get(name)
        : entry.kind === "Stream"
          ? internals.streams.get(name)
          : internals.aggregates.get(name);
    const rpcs = readRpcs(entry);
    reads.set(`${name}.watch`, { rpc: rpcs.watch as Rpc.AnyWithProps, mode: "watch", store });
    reads.set(`${name}.events`, { rpc: rpcs.events as Rpc.AnyWithProps, mode: "events", store });
  }
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const live = liveRequestOf(request);
    const read = live && reads.get(live.tag);
    if (!live || !read) return HttpServerResponse.text("Unknown live read", { status: 400 });
    if (!read.store?.connect) {
      return HttpServerResponse.text("This platform streams live reads as responses", {
        status: 501,
      });
    }
    const payload = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(read.rpc.payloadSchema))(
      live.payload,
    ).pipe(Effect.option);
    if (Option.isNone(payload))
      return HttpServerResponse.text("Invalid live read", { status: 400 });
    const { key, where, after } = payload.value as ReadPayload;
    yield* Effect.annotateCurrentSpan({ "domain.read": live.tag, "domain.key": String(key) });
    // Run the read's middleware, as the RPC server would, around capturing what it provides.
    let authorized: Effect.Effect<RequestContext.Json, unknown> = RequestContext.capture;
    for (const service of read.rpc.middlewares) {
      const run = Context.getUnsafe(middleware, service) as unknown as (
        effect: Effect.Effect<RequestContext.Json, unknown>,
        options: unknown,
      ) => Effect.Effect<RequestContext.Json, unknown>;
      authorized = run(authorized, {
        rpc: read.rpc,
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId(live.id),
        headers: request.headers,
        payload: payload.value,
      });
    }
    const subscription: Subscription = {
      requestId: live.id,
      mode: read.mode,
      where: where as Subscription["where"],
      context: {},
      cursor: live.cursor ?? (read.mode === "watch" ? -1 : (after ?? 0)),
    };
    const judged = yield* authorized.pipe(
      Effect.map((context): Subscription => ({ ...subscription, context })),
      Effect.catch((error) =>
        Watch.refuse(read.rpc, error).pipe(
          Effect.orDie,
          Effect.map((refused): Subscription => ({ ...subscription, refused })),
        ),
      ),
    );
    return yield* read.store.connect(String(key), judged);
  }).pipe(
    // A live read continues the trace of the client that opened it, like an RPC call.
    (effect) =>
      Effect.flatMap(HttpServerRequest, (request) => {
        const live = liveRequestOf(request);
        return effect.pipe(
          Effect.withSpan(`Domain.read ${live?.tag ?? "unknown"}`, {
            kind: "server",
            ...(live?.traceId && live.spanId
              ? {
                  parent: Tracer.externalSpan({
                    traceId: live.traceId,
                    spanId: live.spanId,
                    sampled: live.sampled ?? true,
                  }),
                }
              : {}),
          }),
        );
      }),
  );
};

// ---------------------------------------------------------------- client

type Flat = Record<string, (payload: unknown, options?: CallOptions) => unknown>;

/** Shape the flat Effect RPC client into commands plus view and aggregate namespaces. */
const nest = (entries: ReadonlyArray<Servable>, flat: Flat): unknown => {
  const client: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.kind === "Command") {
      const send = flat[entry.tag]!;
      client[entry.tag] = (
        target: unknown,
        input: object = {},
        { commandId, ...options }: CommandOptions = {},
      ) => send({ target, commandId, input }, options);
      continue;
    }
    const name = nameOf(entry);
    const call =
      (method: string) =>
      (key: unknown, options: CallOptions & Record<string, unknown> = {}) => {
        const { headers, ...rest } = options;
        return flat[`${name}.${method}`]!({ key, ...rest }, { headers });
      };
    client[name] =
      entry.kind === "View"
        ? {
            get: call("get"),
            watch: call("watch"),
            events: call("events"),
            list: call("list"),
            snapshot: call("snapshot"),
          }
        : entry.kind === "Stream"
          ? { peek: call("peek"), watch: call("watch"), events: call("events"), list: call("list") }
          : { get: call("get"), watch: call("watch"), events: call("events") };
  }
  return client;
};

/**
 * Serves an Api in the caller's process and connects a client to it. Messages
 * are encoded as on the wire but never leave memory.
 */
const makeProtocolInProcess = (
  model: Model.Any,
  entries: ReadonlyArray<Servable>,
  unresolved: ReadonlyArray<Unservable>,
  group: RpcGroup.RpcGroup<Rpc.Any>,
): Layer.Layer<RpcClient.Protocol, never, Model.Internals> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const codecFor = Schema.toCodecJson as RpcSerialization.CodecFor;
      const disconnects = yield* Queue.unbounded<number>();
      const clientIds = new Set<number>();
      let toServer = (_: number, __: RpcMessage.FromClientEncoded): Effect.Effect<void> =>
        Effect.void;
      let toClient = (_: number, __: RpcMessage.FromServerEncoded): Effect.Effect<void> =>
        Effect.void;
      const server = yield* RpcServer.Protocol.make((write) => {
        toServer = write;
        return Effect.succeed({
          disconnects,
          send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
            toClient(clientId, response),
          end: () => Effect.void,
          clientIds: Effect.sync(() => new Set(clientIds) as ReadonlySet<number>),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: false,
          codecFor,
        });
      });
      const protocol = yield* RpcClient.Protocol.make((write) => {
        toClient = write;
        return Effect.succeed({
          send: (clientId: number, request: RpcMessage.FromClientEncoded) =>
            toServer(clientId, request),
          supportsAck: true,
          supportsTransferables: false,
          codecFor,
        });
      });
      const handlers = yield* handlersOf(model, entries, unresolved);
      // The middleware services in the caller's scope run for every request.
      yield* RpcServer.make(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RpcServer.Protocol, server),
            group.toLayer(handlers as never) as Layer.Layer<never>,
          ),
        ),
        Effect.forkScoped,
      );
      return RpcClient.Protocol.of({
        ...protocol,
        run: (clientId, write) =>
          Effect.suspend(() => {
            clientIds.add(clientId);
            return protocol.run(clientId, write);
          }).pipe(
            Effect.onExit(() => {
              clientIds.delete(clientId);
              return Queue.offer(disconnects, clientId);
            }),
          ),
      });
    }),
  );

// The names an Api lists that its model does not hold.
const Unresolved = Symbol.for("alchemy/Domain/Api/Unresolved");

// A class so `class BankApi extends Domain.Api(...) {}` works.
const build = (
  name: string,
  model: Model.Any,
  entries: ReadonlyArray<Servable>,
  unresolved: ReadonlyArray<Unservable>,
  group: RpcGroup.RpcGroup<Rpc.Any>,
): unknown => {
  const client = RpcClient.make(group).pipe(
    Effect.map((flat) => nest(entries, flat as unknown as Flat)),
  );
  const Client = Context.Service<ClientKey<string>, unknown>()(`alchemy/Domain/Api/${name}/Client`);
  const commands = entries.filter((entry): entry is Command.Any => entry.kind === "Command");
  const rejectionClasses = [...new Set(commands.flatMap((command) => command.rejects))];
  const rejections = rejectionClasses.length === 0 ? Schema.Never : Schema.Union(rejectionClasses);
  // Serve the Api over HTTP (Effect RPC, NDJSON), with live reads over WebSockets.
  const serve = Effect.gen(function* () {
    const handlers = yield* handlersOf(model, entries, unresolved);
    // The middleware services (declared in the Api's requirements), for every request.
    const middleware = yield* captureContext();
    const layer = Layer.mergeAll(
      group.toLayer(handlers as never),
      RpcSerialization.layerNdjson,
      Layer.succeedContext(middleware),
    );
    // One server per request: Workers forbid sharing I/O objects across requests.
    const rpc = RpcServer.toHttpEffect(group).pipe(Effect.flatten, Effect.provide(layer));
    const live = liveReads(entries, yield* Model.Internals, middleware);
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      return request.headers.upgrade?.toLowerCase() === "websocket" ? yield* live : yield* rpc;
    }) as unknown as HttpEffect;
    return { fetch };
  });
  // The client for the life of the caller's scope, over the given protocol.
  const clientOver = <R>(protocol: Layer.Layer<RpcClient.Protocol, never, R>) =>
    Effect.flatMap(Layer.build(protocol), (context) => Effect.provide(client, context));
  const layerClient = Layer.effect(Client, client);
  const inProcess = makeProtocolInProcess(model, entries, unresolved, group);
  return Object.assign(
    class {},
    // The class is an Effect: `yield* MyApi` serves it.
    Effectable.Prototype({ label: `alchemy/Domain/Api<${name}>`, evaluate: () => serve }),
    {
      kind: "Api" as const,
      apiName: name,
      model,
      serves: entries,
      [Unresolved]: unresolved,
      commands,
      rejections,
      group,
      client,
      Client,
      layerClient,
      clientHttp: (url: string) => clientOver(protocolHttp(url)),
      layerClientHttp: (url: string) => layerClient.pipe(Layer.provide(protocolHttp(url))),
      clientWebSocket: (url: string) => clientOver(protocolWebSocket(url)),
      layerClientWebSocket: (url: string) =>
        layerClient.pipe(Layer.provide(protocolWebSocket(url))),
      clientInProcess: clientOver(inProcess),
      layerClientInProcess: layerClient.pipe(Layer.provide(inProcess)),
    },
  );
};

/**
 * The public surface of a domain for one kind of client: the commands it may
 * send, and the views and aggregates (with a `read` contract) it may read.
 * Nothing in an Api needs a handler. The class is an Effect: `yield* MyApi`
 * gives a Worker its `fetch`. Call it with a typed client over
 * `Domain.protocolHttp`, `Domain.protocolWebSocket` or
 * `Domain.protocolInProcess`, or with `clientHttp`, `clientWebSocket` or
 * `clientInProcess`, which provide them.
 *
 * ### Declaring an Api
 * **Example:** What customers may reach
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { Account, DepositMoney, WithdrawMoney } from "./Account.ts";
 * import { AccountSummary } from "./AccountSummary.ts";
 * import { Bank } from "./Bank.ts";
 *
 * // Serving something Bank does not hold is a type error; nothing unlisted is served.
 * export class CustomerApi extends Domain.Api("CustomerApi", {
 *   model: Bank,
 *   commands: ["DepositMoney", "WithdrawMoney"],
 *   views: ["AccountSummary"],
 *   aggregates: ["Account"],
 * }) {}
 * ```
 *
 * ### Serving it from a Worker
 * **Example:** The Api as a Worker's fetch
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 * import { CustomerApi } from "./CustomerApi.ts";
 * import { SessionLive } from "./Session.ts";
 *
 * const BankLive = SessionLive.pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(DomainCloudflare.layerDurableObjects()),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * ### Calling it
 * `Domain.protocolWebSocket` sends commands, `get` and `list` over HTTP, and
 * opens a WebSocket for each `watch` and `events`, pushed by the object that
 * owns the key. `Domain.protocolHttp` sends everything over HTTP.
 *
 * **Example:** A typed client
 * ```typescript
 * const bank = yield* CustomerApi.client;
 * const { reply } = yield* bank.DepositMoney(accountId, { amount: 1_000 });
 * const summary = yield* bank.AccountSummary.get(accountId);
 * yield* bank.AccountSummary.watch(accountId).pipe(
 *   Stream.runForEach(({ state }) => Effect.log(state?.balance)),
 * );
 * ```
 *
 * ### Calling it in process
 * `clientInProcess` serves the Api in the caller's process, through the
 * middleware of everything it serves, with nothing sent over a network. Code that has
 * already authenticated its caller provides a middleware Layer that trusts it.
 *
 * **Example:** A webhook that deposits as the system
 * ```typescript
 * const asSystem = Layer.succeed(Session, (effect) =>
 *   Effect.provideService(effect, CurrentActor, system("payments-webhook")),
 * );
 * const bank = yield* CustomerApi.clientInProcess.pipe(Effect.provide(asSystem));
 * yield* bank.DepositMoney(accountId, { amount: 1_000 });
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  M extends Model.Any,
  const C extends ReadonlyArray<CommandName<M>> = ReadonlyArray<CommandName<M>>,
  const V extends ReadonlyArray<ViewName<M>> = ReadonlyArray<ViewName<M>>,
  const S extends ReadonlyArray<StreamName<M>> = ReadonlyArray<StreamName<M>>,
  const A extends ReadonlyArray<AggregateName<M>> = ReadonlyArray<AggregateName<M>>,
>(
  name: Name,
  options: Options<M, C, V, S, A>,
): ApiClass<Name, ReadonlyArray<ServedBy<M, C, V, S, A>>> => {
  const { model } = options;
  // What the Api lists but cannot serve, as the message it dies with when served.
  const unresolved: Array<Unservable> = [];
  const pick = <T>(
    all: ReadonlyArray<T>,
    names: ReadonlyArray<string> | undefined,
    nameOfT: (t: T) => string,
  ): ReadonlyArray<T> =>
    names === undefined
      ? all
      : names.flatMap((n) => {
          const found = all.find((t) => nameOfT(t) === n);
          if (found === undefined)
            unresolved.push(new NotInModel({ entity: n, model: model.modelName }));
          return found === undefined ? [] : [found];
        });
  const serves: ReadonlyArray<Servable> = [
    ...pick(model.commands, options.commands, (c) => c.tag),
    ...pick(model.views, options.views, (v) => v.viewName),
    ...pick(model.streams, options.streams, (s) => s.streamName),
    ...pick(model.aggregates, options.aggregates, (a) => a.aggregateName).filter((aggregate) => {
      if (aggregate.definition.read !== undefined) return true;
      // Unlisted, an aggregate without `read` is simply not served; listed, it is a mistake.
      if (options.aggregates !== undefined) {
        unresolved.push(new Unreadable({ aggregate: aggregate.aggregateName }));
      }
      return false;
    }),
  ];
  return build(
    name,
    model,
    serves,
    unresolved,
    RpcGroup.make(...serves.flatMap(rpcsOf)) as unknown as RpcGroup.RpcGroup<Rpc.Any>,
  ) as ApiClass<Name, ReadonlyArray<ServedBy<M, C, V, S, A>>>;
};

/**
 * The HTTP protocol for an Api client (NDJSON, so streams work). Live reads
 * are streamed responses, which the platform feeds by polling the key; use
 * {@link protocolWebSocket} to have them pushed instead. Requires an
 * `HttpClient`, e.g. `FetchHttpClient.layer`.
 */
export const protocolHttp = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient> =>
  RpcClient.layerProtocolHttp({ url }).pipe(Layer.provide(RpcSerialization.layerNdjson));

/**
 * The protocol for a client in the same process as the model. It serves the
 * Api right there: the middleware of everything it serves runs, from the Layers
 * in scope, and nothing leaves memory. Requires the hosted Domain, like
 * serving the Api.
 * In a Worker, build it per request.
 */
export const protocolInProcess = <Name extends string, Serves extends ReadonlyArray<Servable>>(
  api: ApiClass<Name, Serves>,
): Layer.Layer<RpcClient.Protocol, never, Model.Internals | MiddlewareServices<Serves>> =>
  makeProtocolInProcess(
    api.model,
    api.serves,
    (api as unknown as { readonly [Unresolved]: ReadonlyArray<Unservable> })[Unresolved],
    api.group,
  );

/** A frame of a live read: an Effect RPC message, plus the cursor to resume from. */
const LiveFrame = Schema.StructWithRest(
  Schema.Struct({ _tag: Schema.String, cursor: Schema.optional(Schema.Number) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodeLiveFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(LiveFrame));

/** The RPCs served as live reads. */
const isLiveRead = (tag: string) => tag.endsWith(".watch") || tag.endsWith(".events");

/** Attempts in a row a live read may fail to (re)connect before it fails. */
const RECONNECTS = 8;

/**
 * The WebSocket protocol for an Api client. Calls (commands, `get`, `list`)
 * go over HTTP like {@link protocolHttp}; every live read (`watch`,
 * `events`) opens its own WebSocket, which the Api hands to the object that
 * owns the key (on Cloudflare, its Durable Object). Each commit is pushed
 * down the socket, so nothing polls and the object hibernates in between. A
 * dropped socket reconnects and resumes after the last value it delivered.
 *
 * A browser cannot set headers on a WebSocket, and a URL ends up in logs,
 * so headers client middleware attaches apply to calls only. A live read
 * authenticates with what its upgrade request carries: in a browser, the
 * cookies of the Api's origin, so serve the app and the Api from one origin
 * and keep sessions in an `HttpOnly`, `SameSite` cookie. Requires an
 * `HttpClient` and a `Socket.WebSocketConstructor`
 * (`Socket.layerWebSocketConstructorGlobal` in browsers and Workers).
 *
 * **Example:** Watching a view over a WebSocket
 * ```typescript
 * const BankConnection = CustomerApi.layerClient.pipe(
 *   Layer.provide(Domain.protocolWebSocket("https://bank.example.com/api")),
 *   Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
 * );
 * ```
 */
export const protocolWebSocket = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const client = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.prependUrl(url),
      );
      const http = yield* RpcClient.makeProtocolHttp(client).pipe(
        Effect.provide(RpcSerialization.layerNdjson),
      );
      const constructor = yield* Socket.WebSocketConstructor;
      const socketUrl = url.replace(/^http/, "ws");
      const writers = new Map<
        number,
        (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
      >();
      const stops = new Map<string, Deferred.Deferred<void>>();

      const liveRead = (clientId: number, request: RpcMessage.RequestEncoded) =>
        Effect.gen(function* () {
          let cursor: number | undefined;
          let ended = false;
          let failures = 0;
          const connect = Effect.gen(function* () {
            const live: LiveRequest = {
              id: request.id,
              tag: request.tag,
              payload: request.payload,
              cursor,
              ...(request.traceId && request.spanId
                ? { traceId: request.traceId, spanId: request.spanId, sampled: request.sampled }
                : {}),
            };
            const socket = yield* Socket.makeWebSocket(
              `${socketUrl}?${LIVE_PARAM}=${encodeURIComponent(JSON.stringify(live))}`,
            );
            const pull = yield* Socket.readerString(socket);
            while (!ended) {
              for (const text of yield* pull) {
                const { cursor: next, ...message } = yield* decodeLiveFrame(text);
                failures = 0;
                if (next !== undefined) cursor = next;
                if (message._tag === "Exit") ended = true;
                yield* Effect.suspend(
                  () =>
                    writers.get(clientId)?.(message as RpcMessage.FromServerEncoded) ?? Effect.void,
                );
              }
            }
          }).pipe(Effect.scoped, Effect.provideService(Socket.WebSocketConstructor, constructor));

          while (!ended) {
            const exit = yield* Effect.exit(connect);
            if (ended) return;
            // A close without an `Exit` (a deploy, an evicted object) reconnects and resumes.
            if (++failures > RECONNECTS) {
              return yield* RpcClientError.RpcClientError.make({
                reason: RpcClientError.RpcClientDefect.make({
                  message: `Live read ${request.tag} lost its connection`,
                  cause: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
                }),
              });
            }
            yield* Effect.sleep(Duration.millis(Math.min(5_000, 100 * 2 ** failures)));
          }
        });

      return RpcClient.Protocol.of({
        run: (clientId, write) =>
          Effect.suspend(() => {
            writers.set(clientId, write);
            return http.run(clientId, write);
          }).pipe(Effect.ensuring(Effect.sync(() => writers.delete(clientId)))),
        send: (clientId, request, transferables) => {
          if (request._tag === "Request" && isLiveRead(request.tag)) {
            return Effect.gen(function* () {
              const stop = yield* Deferred.make<void>();
              stops.set(String(request.id), stop);
              yield* Effect.raceFirst(liveRead(clientId, request), Deferred.await(stop)).pipe(
                Effect.ensuring(Effect.sync(() => stops.delete(String(request.id)))),
              );
            });
          }
          if (request._tag === "Interrupt") {
            const stop = stops.get(String(request.requestId));
            if (stop) return Deferred.succeed(stop, undefined).pipe(Effect.asVoid);
          }
          return http.send(clientId, request, transferables);
        },
        supportsAck: false,
        supportsTransferables: false,
        codecFor: http.codecFor,
      });
    }),
  );

// ---------------------------------------------------------------- generic helpers

/** The Schema of a union of rejection classes; `Schema.Never` when there are none. */
type RejectionUnion<R> = [R] extends [never]
  ? typeof Schema.Never
  : Schema.Codec<Aggregate.InstanceOf<R>, Schema.Codec.Encoded<R>>;

/**
 * Any Api class. Use it to write code that works with every Api, such as a
 * helper that turns each command of an Api into a UI action. `ApiClass` does
 * not fit there: its client type is exact, so a concrete Api is not an
 * `ApiClass<string, ReadonlyArray<Servable>>`.
 *
 * **Example:** A helper for any Api
 * ```typescript
 * const tagsOf = <A extends Domain.Api.Any>(api: A): ReadonlyArray<Domain.Api.CommandsOf<A>["tag"]> =>
 *   api.commands.map((command) => command.tag);
 *
 * tagsOf(CustomerApi); // ["DepositMoney", "WithdrawMoney"]
 * ```
 */
export interface Any {
  readonly kind: "Api";
  readonly apiName: string;
  /** The model the Api is over. */
  readonly model: Model.Any;
  /** The commands, views, streams and aggregates the Api serves. */
  readonly serves: ReadonlyArray<Servable>;
  /** The command classes the Api exposes, in order. */
  readonly commands: ReadonlyArray<Command.Any>;
  /** One Schema for every rejection the Api's commands declare. */
  readonly rejections: Schema.Top;
  /** The Api's client service. */
  readonly Client: Context.Key<ClientKey<string>, unknown>;
}

/** The command classes an Api exposes. */
export type CommandsOf<A extends Any> = A["commands"][number];

/** The rejection classes the commands of an Api declare. */
export type RejectionsOf<A extends Any> = CommandsOf<A>["rejects"][number];

/** The client an Api's `Client` service gives (`yield* MyApi.Client`). */
export type ClientOf<A extends Any> = A["Client"]["Service"];
