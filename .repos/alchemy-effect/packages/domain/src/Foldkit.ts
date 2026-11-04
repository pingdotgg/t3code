import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, type Subscription } from "foldkit";
import { defineMessageUnion, type MessageUnion } from "foldkit/message";
import type * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import type * as DomainCommand from "./Command.ts";
import * as Key from "./Key.ts";
import * as Read from "./Read.ts";
import { nameOf } from "./ReadRpcs.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";

/** Per-call headers, resolved at execution time and excluded from replayable args. */
export class CommandHeaders extends Context.Service<
  CommandHeaders,
  {
    readonly get: (command: string) => Effect.Effect<Headers.Input>;
  }
>()("@alchemy.run/domain/Foldkit/CommandHeaders") {}

/** Page-local command id state. Give each page load a fresh session in Flags. */
export const CommandIds = Schema.Struct({ session: Schema.String, sent: Schema.Number });
/** Page-local command id state. */
export type CommandIds = typeof CommandIds.Type;

/** Allocate an id without reading time or changing the supplied state. */
export const next = (ids: CommandIds) => ({
  commandId: `${ids.session}:${ids.sent}`,
  commandIds: CommandIds.make({ session: ids.session, sent: ids.sent + 1 }),
});

type Input<C extends DomainCommand.Any> = Omit<C["Type"], "_tag">;
type Reply<C extends DomainCommand.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;
type Rejection<C extends DomainCommand.Any> = C["rejects"][number]["Type"];
type Denial<C extends DomainCommand.Any> = C["middleware"][number]["error"]["Type"];

/** A refusal is final; an unknown outcome can be retried with the same id. */
export type Failure<C extends DomainCommand.Any> =
  | Readonly<{ _tag: "Rejected"; rejection: Rejection<C> }>
  | Readonly<{ _tag: "Denied"; error: Denial<C> }>
  | Readonly<{ _tag: "Unknown" }>;

type Cases<A extends Api.Any> = {
  readonly [C in Api.CommandsOf<A> as `Succeeded${C["tag"]}`]: {
    commandId: typeof Schema.String;
    reply: Schema.Schema<Reply<C>>;
    receipt: Schema.Struct<{ stream: typeof Schema.String; version: typeof Schema.Number }>;
  };
} & {
  readonly [C in Api.CommandsOf<A> as `Failed${C["tag"]}`]: {
    commandId: typeof Schema.String;
    failure: Schema.Schema<Failure<C>>;
  };
};

type Args<C extends DomainCommand.Any> = {
  target: Schema.toType<C["target"]>;
  input: Schema.Schema<Input<C>>;
  commandId: typeof Schema.String;
};
type Result<A extends Api.Any, C extends DomainCommand.Any> = Extract<
  MessageUnion<Cases<A>>["Type"],
  { readonly _tag: `Succeeded${C["tag"]}` | `Failed${C["tag"]}` }
>;

/** Typed Command definitions and their result Message union, derived from an Api. */
type CommandDefinitions<A extends Api.Any> = {
  readonly [C in Api.CommandsOf<A> as C["tag"]]: Command.CommandDefinitionWithArgs<
    C["tag"],
    Args<C>,
    Effect.Effect<
      Result<A, C>,
      never,
      A["Client"]["Identifier"] | Effect.Services<ReturnType<Api.CommandClient<C>>>
    >
  >;
} & { readonly Message: MessageUnion<Cases<A>> };

const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });

/** Build one Foldkit Command per Api command. Provide the Api client at the runtime boundary. */
function commandDefinitions<A extends Api.Any>(api: A): CommandDefinitions<A>;
function commandDefinitions(api: Api.Any): unknown {
  const cases: Record<string, Schema.Struct.Fields> = {};
  for (const command of api.commands) {
    const rejection = Schema.Union(command.rejects);
    const denial = Schema.Union(command.middleware.map((middleware) => middleware.error));
    cases[`Succeeded${command.tag}`] = {
      commandId: Schema.String,
      reply: command.reply ?? Schema.Void,
      receipt: Receipt,
    };
    cases[`Failed${command.tag}`] = {
      commandId: Schema.String,
      failure: Schema.Union([
        Schema.TaggedStruct("Rejected", { rejection }),
        Schema.TaggedStruct("Denied", { error: denial }),
        Schema.TaggedStruct("Unknown", {}),
      ]),
    };
  }
  const Message = defineMessageUnion(cases);
  const definitions: Record<string, unknown> = { Message };
  for (const command of api.commands) {
    const { payloadSchema } = command.rpc as Rpc.AnyWithProps;
    definitions[command.tag] = Command.define(command.tag, {
      args: {
        target: Schema.toType(command.target),
        input: Schema.toType((payloadSchema as Schema.Struct<{ input: Schema.Top }>).fields.input),
        commandId: Schema.String,
      },
      messages: [Message],
      execute: Effect.fn(
        function* ({ target, input, commandId }) {
          const client = (yield* Effect.service(api.Client)) as Record<
            string,
            (
              target: string,
              input: unknown,
              options: Api.CommandOptions,
            ) => Effect.Effect<{ reply: unknown; stream: string; version: number }, unknown>
          >;
          const headersService = yield* Effect.serviceOption(CommandHeaders);
          const headers =
            headersService._tag === "Some"
              ? yield* headersService.value.get(command.tag)
              : undefined;
          const { reply, stream, version } = yield* client[command.tag](target, input, {
            commandId,
            headers,
          });
          return {
            _tag: `Succeeded${command.tag}`,
            commandId,
            reply,
            receipt: { stream, version },
          };
        },
        (effect, { commandId }) =>
          effect.pipe(
            Effect.catchCauseIf(
              (cause) => Cause.hasFails(cause) || Cause.hasDies(cause),
              (cause) =>
                Effect.succeed({
                  _tag: `Failed${command.tag}`,
                  commandId,
                  failure: Cause.hasDies(cause)
                    ? { _tag: "Unknown" }
                    : classifyFailure(
                        command,
                        cause.pipe(Cause.findErrorOption, Option.getOrUndefined),
                      ),
                }),
            ),
          ),
      ),
    });
  }
  return definitions;
}

const classifyFailure = (command: DomainCommand.Any, error: unknown) => {
  if (command.rejects.some((rejection) => Schema.is(rejection)(error))) {
    return { _tag: "Rejected", rejection: error };
  }
  if (command.middleware.some((middleware) => Schema.is(middleware.error)(error))) {
    return { _tag: "Denied", error };
  }
  return { _tag: "Unknown" };
};

type ReadEntry = View.Any | Aggregate.Any | DomainStream.Any;
type Reads<A extends Api.Any> = Extract<A["serves"][number], ReadEntry>;
type ReadName<V extends ReadEntry> = V extends View.Any
  ? V["viewName"]
  : V extends Aggregate.Any
    ? V["aggregateName"]
    : V extends DomainStream.Any
      ? V["streamName"]
      : never;
type ReadClient<V extends ReadEntry> = V extends View.Any
  ? Api.ViewClient<V>
  : V extends Aggregate.Any
    ? Api.AggregateClient<V>
    : V extends DomainStream.Any
      ? Api.StreamClient<V>
      : never;
type ReadKey<V extends ReadEntry> = Parameters<ReadClient<V>["watch"]>[0];
type StateOf<V extends ReadEntry> = Stream.Success<ReturnType<ReadClient<V>["watch"]>>["state"];
type EntryOf<V extends ReadEntry> = Exclude<
  Stream.Success<ReturnType<ReadClient<V>["events"]>>,
  Read.CaughtUp
>;
type ErrorOf<V extends ReadEntry> = Stream.Error<ReturnType<ReadClient<V>["watch"]>>;
type ViewStateSchema<V extends View.Any> = [NonNullable<V["definition"]["state"]>] extends [never]
  ? typeof Schema.Never
  : Extract<NonNullable<V["definition"]["state"]>, Schema.Top>;
type ViewFlags<V extends View.Any> = ReturnType<typeof snapshotFlags<ViewStateSchema<V>>>;

/** A read namespace with Foldkit Subscription entries, bound to one Api entry. */
export interface ReadClientOf<A extends Api.Any, V extends ReadEntry> {
  readonly watch: <Model, Message>(
    options: WatchOptions<Model, Message, V>,
  ) => Subscription.EntryWithoutKeepAlive<
    Model,
    Message,
    { key: ReadKey<V>; isEnabled: boolean },
    A["Client"]["Identifier"]
  >;
  readonly events: <Model, Message>(
    options: EventsOptions<Model, Message, V>,
  ) => EventsSubscription<A, Model, Message, V>;
}

/** Commands and read namespaces computed from the Api's entries. Message is reserved. */
export type ClientOf<A extends Api.Any> = CommandDefinitions<A> & {
  readonly [V in Reads<A> as ReadName<V>]: ReadClientOf<A, V> &
    (V extends View.Any
      ? {
          readonly SnapshotFlags: ViewFlags<V>;
          readonly decodeSnapshotFlags: (flags: unknown) => Option.Option<ViewFlags<V>["Type"]>;
        }
      : {});
};

/** Build the Foldkit Commands and Subscriptions for an Api. The app provides api.layerClient in its runtime resources. */
export function make<A extends Api.Any>(
  api: A & ("Message" extends keyof Api.ClientOf<A> ? never : unknown),
): ClientOf<A>;
export function make(api: Api.Any): unknown {
  // The signature rejects an Api with an entry named Message; the result union is assigned last.
  const definitions = commandDefinitions(api) as Record<string, unknown>;
  const { Message } = definitions;
  for (const entry of api.serves) {
    if (entry.kind !== "View" && entry.kind !== "Aggregate" && entry.kind !== "Stream") {
      continue;
    }
    const name = nameOf(entry);
    const flags =
      entry.kind === "View"
        ? snapshotFlags(
            (entry.definition.state ?? Schema.Never) as Schema.Schema<unknown> & {
              readonly DecodingServices: never;
            },
          )
        : undefined;
    definitions[name] = {
      watch: (options: WatchOptions<unknown, unknown, ReadEntry>) =>
        watchRead(api, entry, name, options),
      events: (options: EventsOptions<unknown, unknown, ReadEntry>) =>
        readEvents(api, entry, name, options),
      ...(flags === undefined
        ? {}
        : {
            SnapshotFlags: flags,
            decodeSnapshotFlags: Schema.decodeUnknownOption(flags),
          }),
    };
  }
  definitions.Message = Message;
  return definitions;
}

const keySchemaOf = (entry: ReadEntry) =>
  Schema.toType(
    entry.kind === "Aggregate" ? entry.definition.id : Key.idSchemaOf(entry.definition.key),
  );

/** A watch Snapshot with explicit absence for Foldkit Models. */
export type Snapshot<State> = Readonly<{
  state: Option.Option<NonNullable<State>>;
  cursor: number;
}>;

/** Callbacks for live read state. Cursor changes do not restart the watch. */
export interface WatchOptions<Model, Message, V extends ReadEntry> {
  readonly key: (model: Model) => ReadKey<V>;
  readonly isEnabled?: (model: Model) => boolean;
  readonly toMessage: (snapshot: Snapshot<StateOf<V>>) => Message;
  readonly onFailure: (error: ErrorOf<V>) => Message;
  /** Handle unexpected read defects. Interruption does not call this callback. */
  readonly onDefect: (cause: Cause.Cause<unknown>) => Message;
}

/** Follow read state and cursor. Pass the result as an entry to Subscription.make. */
function watchRead(
  api: Api.Any,
  entry: ReadEntry,
  name: string,
  options: WatchOptions<unknown, unknown, ReadEntry>,
): unknown {
  return {
    dependenciesSchema: Schema.Struct({
      key: keySchemaOf(entry),
      isEnabled: Schema.Boolean,
    }),
    modelToDependencies: (model: unknown) => ({
      key: options.key(model),
      isEnabled: options.isEnabled?.(model) ?? true,
    }),
    dependenciesToStream: ({ key, isEnabled }: { key: string; isEnabled: boolean }) =>
      isEnabled
        ? Stream.unwrap(
            api.Client.pipe(
              Effect.map((client) =>
                (client as Record<string, ReadClient<ReadEntry>>)[name].watch(key),
              ),
            ),
          ).pipe(
            Stream.map(({ state, cursor }) =>
              options.toMessage({ state: Option.fromNullishOr(state), cursor }),
            ),
            Stream.catchCause((cause) => {
              if (Cause.hasDies(cause)) {
                return Stream.succeed(options.onDefect(cause));
              }
              const error = Cause.findErrorOption(cause);
              return Option.isSome(error)
                ? Stream.succeed(options.onFailure(error.value))
                : Stream.failCause(cause);
            }),
          )
        : Stream.empty,
  };
}

/** Callbacks for a resumable event feed. The app stores the cursor after applying each entry. */
export interface EventsOptions<Model, Message, V extends ReadEntry> {
  readonly key: (model: Model) => ReadKey<V>;
  readonly cursor: (model: Model) => Option.Option<number>;
  readonly isEnabled?: (model: Model) => boolean;
  readonly restartKey?: (model: Model) => number;
  readonly onEntry: (entry: EntryOf<V>) => Message;
  readonly onCaughtUp: (cursor: number) => Message;
  readonly onFailure: (error: ErrorOf<V>) => Message;
  /** Handle unexpected read defects. Interruption does not call this callback. */
  readonly onDefect: (cause: Cause.Cause<unknown>) => Message;
}

/** Follow event entries after the Model's cursor, without counting sequence gaps. */
type EventsSubscription<A extends Api.Any, Model, Message, V extends ReadEntry> = {
  readonly dependenciesSchema: Schema.Struct<{
    key: Schema.Schema<ReadKey<V>>;
    cursor: Schema.Schema<Option.Option<number>>;
    restartKey: Schema.optional<typeof Schema.Number>;
    isEnabled: typeof Schema.Boolean;
  }>;
  readonly modelToDependencies: (model: Model) => {
    key: ReadKey<V>;
    cursor: Option.Option<number>;
    restartKey?: number;
    isEnabled: boolean;
  };
  readonly keepAliveEquivalence: (
    left: {
      key: ReadKey<V>;
      cursor: Option.Option<number>;
      restartKey?: number;
      isEnabled: boolean;
    },
    right: {
      key: ReadKey<V>;
      cursor: Option.Option<number>;
      restartKey?: number;
      isEnabled: boolean;
    },
  ) => boolean;
  readonly dependenciesToStream: (
    dependencies: {
      key: ReadKey<V>;
      cursor: Option.Option<number>;
      restartKey?: number;
      isEnabled: boolean;
    },
    readDependencies: () => {
      key: ReadKey<V>;
      cursor: Option.Option<number>;
      restartKey?: number;
      isEnabled: boolean;
    },
  ) => Stream.Stream<Message, never, A["Client"]["Identifier"]>;
};
function readEvents(
  api: Api.Any,
  entry: ReadEntry,
  name: string,
  options: EventsOptions<unknown, unknown, ReadEntry>,
): unknown {
  const keySchema = keySchemaOf(entry);
  const sameKey = Schema.toEquivalence(keySchema);
  type Dependencies = {
    key: string;
    cursor: Option.Option<number>;
    restartKey?: number;
    isEnabled: boolean;
  };
  return {
    dependenciesSchema: Schema.Struct({
      key: keySchema,
      cursor: Schema.Option(Schema.Number),
      restartKey: Schema.optional(Schema.Number),
      isEnabled: Schema.Boolean,
    }),
    modelToDependencies: (model: unknown): Dependencies => ({
      key: options.key(model),
      cursor: options.cursor(model),
      restartKey: options.restartKey?.(model),
      isEnabled: options.isEnabled?.(model) ?? true,
    }),
    keepAliveEquivalence: (left: Dependencies, right: Dependencies) =>
      sameKey(left.key, right.key) &&
      left.isEnabled === right.isEnabled &&
      left.restartKey === right.restartKey,
    dependenciesToStream: (_: Dependencies, readDependencies: () => Dependencies) =>
      Stream.suspend(() => {
        const { key, cursor, isEnabled } = readDependencies();
        if (!isEnabled) {
          return Stream.empty;
        }
        let deliveredCursor = Option.getOrElse(cursor, () => 0);
        return Stream.unwrap(
          api.Client.pipe(
            Effect.map((client) =>
              (client as Record<string, ReadClient<ReadEntry>>)[name].events(key, {
                after: Option.getOrUndefined(cursor),
              }),
            ),
          ),
        ).pipe(
          Stream.filter((frame) => {
            if (Read.isCaughtUp(frame)) {
              return true;
            }
            const appliedCursor = Option.getOrElse(readDependencies().cursor, () => 0);
            if (frame.envelope.seq <= Math.max(deliveredCursor, appliedCursor)) {
              return false;
            }
            deliveredCursor = frame.envelope.seq;
            return true;
          }),
          Stream.map((frame) =>
            Read.isCaughtUp(frame) ? options.onCaughtUp(frame.cursor) : options.onEntry(frame),
          ),
          Stream.catchCause((cause) => {
            if (Cause.hasDies(cause)) {
              return Stream.succeed(options.onDefect(cause));
            }
            const error = Cause.findErrorOption(cause);
            return Option.isSome(error)
              ? Stream.succeed(options.onFailure(error.value))
              : Stream.failCause(cause);
          }),
        );
      }),
  };
}

/** Decode snapshot wire data in Flags, converting null state to Option.none. */
const snapshotFlags = <State extends Schema.Top>(state: State) =>
  Schema.Struct({
    state: Schema.OptionFromNullOr(state),
    cursor: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  });
