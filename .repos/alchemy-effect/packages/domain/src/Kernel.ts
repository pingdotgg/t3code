import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import type { Plan } from "./Backfill.ts";
import * as CatchUp from "./CatchUp.ts";
import * as Command from "./Command.ts";
import {
  ConsumesItself,
  DefinitionError,
  DuplicateDefinition,
  DuplicateEventTag,
  DuplicateName,
  InvalidInitial,
  MissingInitial,
  MissingKeyOf,
  NoEmitter,
  type Reason,
  TwoWriters,
  NewerGeneration,
  UndeclaredEmit,
  UndeclaredEvent,
  UnhandledCommand,
  UnknownEvent,
  UnknownSource,
  UnknownStream,
  UnmatchedRoute,
  WriterKeyMismatch,
} from "./DefinitionError.ts";
import type * as Event from "./Event.ts";
import { judge, rejectionTag, settle } from "./internal.ts";
import * as Key from "./Key.ts";
import type {
  Accepted,
  AggregateKit,
  Delivery,
  EnvelopeJson,
  HandleResult,
  Json,
  PolicyKit,
  ReceiptJson,
  StoredEvent,
  StreamEntry,
  ViewEntry,
  ViewKit,
  ViewSnapshot,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import type * as Projection from "./Projection.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import type * as View from "./View.ts";

/**
 * The entities of a Domain.
 */
export interface Definitions {
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  readonly views: ReadonlyArray<View.Any>;
  readonly policies: ReadonlyArray<Policy.Any>;
  readonly projections: ReadonlyArray<Projection.Any>;
  readonly streams: ReadonlyArray<DomainStream.Any>;
}

/**
 * What a projection input carries for `Stream.append`, out of sight of the
 * handler's types: who is writing, where in its input log, and the source
 * event being handled. Appends count up per input, so a re-run of the same
 * input makes exactly the same writes.
 *
 * @internal
 */
export const InputMeta = Symbol.for("alchemy/Domain/Projection/InputMeta");

/** @internal */
export interface InputMetaValue {
  readonly projection: string;
  readonly key: string;
  readonly position: number;
  readonly source: string;
  readonly sourceSeq: number;
  readonly at: number;
  readonly commandId: string;
  /** Appends made for this input so far in this run. */
  appends: number;
}

export { DefinitionError };

interface JsonCodec {
  readonly encode: (value: unknown) => Json;
  readonly decode: (json: Json) => any;
}

const jsonCodec = (schema: Schema.Top): JsonCodec => {
  const codec = Schema.toCodecJson(schema as any) as any;
  return {
    // oxlint-disable-next-line effecttsgo/schema-sync -- JsonCodec is sync by contract
    encode: Schema.encodeUnknownSync(codec),
    // oxlint-disable-next-line effecttsgo/schema-sync -- JsonCodec is sync by contract
    decode: Schema.decodeUnknownSync(codec),
  };
};

/** @internal */
export const encodeEnvelope = (
  envelope: Aggregate.Envelope,
  trace?: Telemetry.TraceJson,
): EnvelopeJson => ({
  id: envelope.id,
  stream: envelope.stream,
  seq: envelope.seq,
  at: DateTime.toEpochMillis(envelope.at),
  commandId: envelope.commandId,
  correlationId: envelope.correlationId,
  ...(trace ? { trace } : {}),
});

/** @internal */
export const decodeEnvelope = (json: EnvelopeJson): Aggregate.Envelope => ({
  id: json.id,
  stream: json.stream,
  seq: json.seq,
  at: DateTime.makeUnsafe(json.at),
  commandId: json.commandId,
  correlationId: json.correlationId ?? json.commandId,
});

/** The structural attributes of a delivery a reaction handles. */
const deliveryAttributes = (delivery: Delivery): Record<string, unknown> => ({
  "domain.source": delivery.source,
  "domain.seq": delivery.seq,
  "domain.event": delivery.tag,
  "domain.command_id": delivery.envelope.commandId,
  "domain.correlation_id": delivery.envelope.correlationId ?? delivery.envelope.commandId,
});

/** A reaction to one delivery continues the trace of the commit that caused it. */
const parentOf = (delivery: Delivery) =>
  delivery.envelope.trace ? Telemetry.spanOf(delivery.envelope.trace) : undefined;

/**
 * The pure semantics shared by every platform: decide, evolve, reply,
 * routing and view application, plus every codec.
 */
export interface Kernel {
  readonly aggregateKit: (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => Omit<AggregateKit, "push">;
  readonly viewKit: (
    view: View.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => Omit<ViewKit, "push">;
  readonly policyKit: (policy: Policy.Any, handler: Policy.Handler<unknown>) => PolicyKit;
  /** Decode a run of a projection key's input log into handler inputs. */
  readonly projectionInputs: (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ) => Effect.Effect<ReadonlyArray<unknown>>;
  /** The keys of a projection an aggregate's committed event is routed to (empty if it is not consumed). */
  readonly projectionKeys: (
    projection: Projection.Any,
    aggregate: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
  ) => ReadonlyArray<string>;
  /** Every view and projection in the model, by `CatchUp.targetId`: what catches up. */
  readonly targets: ReadonlyArray<string>;
  /**
   * Whether every key of a consumer (by `CatchUp.targetId`) hears from exactly one
   * source instance, the one with its own id: it needs no merge and no barrier.
   */
  readonly singleSource: (target: string) => boolean;
  /**
   * The sources (aggregates and views, by name) a consumer reads, by
   * `CatchUp.targetId`; `undefined` for one this model doesn't have.
   */
  readonly sourcesOf: (target: string) => ReadonlyArray<string> | undefined;
  /** What a backfill needs to know of a consumer; `undefined` for one this model doesn't have. */
  readonly planOf: (target: string) => Plan | undefined;
  /**
   * Route a source instance's stored rows (as its `log` returns them) to one
   * consumer only, as history: each row's seq and its deliveries.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /**
   * Set a view's or projection's version (`view:Name` or `projection:Name`).
   * Bumping it rebuilds the consumer, and every view or projection that reads
   * it, from the history. Set every version before the platform starts.
   */
  readonly setVersion: (consumer: string, version: number) => void;
  /** A consumer's generation: its version plus those of the views it reads. */
  readonly generationOf: (kind: "view" | "projection", name: string) => number;
  /** The generation of a consumer's storage: a view rebuilt in place keeps it. */
  readonly classGenerationOf: (kind: "view" | "projection", name: string) => number;
  /** A consumer's id, by `CatchUp.targetId`. */
  readonly targetIdOf: (kind: "view" | "projection", name: string) => string;
  /** Whether a view is rebuilt in place: keyed by the one aggregate it reads. */
  readonly inPlace: (kind: "view" | "projection", name: string) => boolean;
  /** The projection that writes a stream, if any. */
  readonly writerOf: (stream: DomainStream.Any) => Projection.Any | undefined;
  readonly decodeStreamEntry: (
    entry: StreamEntry,
  ) => Effect.Effect<DomainStream.Entry<unknown, string>>;
  readonly encodeCommand: (
    aggregate: Aggregate.Any,
    command: { readonly _tag: string },
  ) => Effect.Effect<Json>;
  readonly decodeRejection: (aggregate: Aggregate.Any, json: Json) => unknown;
  readonly decodeReceipt: (
    aggregate: Aggregate.Any,
    commandTag: string,
    json: ReceiptJson,
  ) => Effect.Effect<Aggregate.Receipt>;
  readonly decodeState: (aggregate: Aggregate.Any, json: Json) => unknown;
  readonly decodeViewState: (view: View.Any, json: Json) => unknown;
  readonly decodeViewEntry: (
    view: View.Any,
    entry: ViewEntry,
  ) => Effect.Effect<View.Entry<unknown, unknown>>;
  readonly decodeEvent: (json: Json) => Effect.Effect<unknown>;
  readonly encodeEvent: (event: { readonly _tag: string }) => Effect.Effect<Json>;
}

/**
 * Build the kernel for a set of definitions. Validates tags and routing, and
 * dies with a {@link DefinitionError} for the first problem.
 */
export const make = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved = Telemetry.resolve(undefined),
): Effect.Effect<Kernel> =>
  Effect.suspend(() => {
    const { kernel, problems } = collect(definitions, telemetry);
    return problems.length > 0 ? Effect.die(problems[0]) : Effect.succeed(kernel);
  });

/**
 * Every problem {@link make} would die with, without building anything.
 * Empty when the definitions are valid.
 */
export const verify = (definitions: Definitions): ReadonlyArray<DefinitionError> =>
  collect(definitions, Telemetry.resolve(undefined)).problems;

/** Build the kernel and collect every definition problem, each once, in order. */
const collect = (definitions: Definitions, telemetry: Telemetry.Resolved) => {
  const problems: Array<DefinitionError> = [];
  const seen = new Set<string>();
  const kernel = build(definitions, telemetry, (problem) => {
    if (seen.has(problem.message)) return;
    seen.add(problem.message);
    problems.push(problem);
  });
  return { kernel, problems };
};

/**
 * Build the kernel. Each definition problem goes to `report`, and the build
 * goes on past it, so {@link verify} sees every problem.
 */
const build = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved,
  report: (problem: DefinitionError) => void,
): Kernel => {
  const problem = (reason: Reason) => report(new DefinitionError({ reason }));
  // ---------------------------------------------------------------- events
  const eventCodecs = new Map<string, { readonly cls: Event.Any; readonly codec: JsonCodec }>();
  const registerEvent = (cls: Event.Any) => {
    const existing = eventCodecs.get(cls.tag);
    if (existing && existing.cls !== cls) {
      return problem(new DuplicateEventTag({ tag: cls.tag }));
    }
    if (!existing) eventCodecs.set(cls.tag, { cls, codec: jsonCodec(cls) });
  };
  for (const aggregate of definitions.aggregates) {
    for (const event of aggregate.definition.events) registerEvent(event);
  }
  const eventCodec = (tag: string) => {
    const entry = eventCodecs.get(tag);
    return entry
      ? Effect.succeed(entry.codec)
      : Effect.die(new DefinitionError({ reason: new UnknownEvent({ event: tag }) }));
  };
  const encodeEvent = (event: { readonly _tag: string }): Effect.Effect<Json> =>
    Effect.map(eventCodec(event._tag), (codec) => codec.encode(event));
  const decodeEvent = (json: Json): Effect.Effect<unknown> =>
    Effect.map(eventCodec((json as { _tag: string })._tag), (codec) => codec.decode(json));
  /** The span attributes an event's declaration adds. */
  const eventAttributes = (event: { readonly _tag: string }) =>
    Telemetry.attributesOf(eventCodecs.get(event._tag)?.cls, event);

  // ----------------------------------------------------- aggregate codecs
  interface AggregateCodecs {
    readonly state: JsonCodec;
    readonly initial: Json;
    readonly commands: Map<
      string,
      { readonly cls: Command.Any; readonly codec: JsonCodec; readonly reply?: JsonCodec }
    >;
    readonly rejections: Map<string, JsonCodec>;
    readonly events: Set<string>;
  }
  const aggregateCodecs = new Map<string, AggregateCodecs>();
  const aggregateByName = new Map<string, Aggregate.Any>();
  for (const aggregate of definitions.aggregates) {
    if (aggregateByName.has(aggregate.aggregateName)) {
      problem(new DuplicateDefinition({ kind: "aggregate", entity: aggregate.aggregateName }));
      continue;
    }
    aggregateByName.set(aggregate.aggregateName, aggregate);
    const def = aggregate.definition;
    const state = jsonCodec(def.state);
    const commands = new Map<string, { cls: Command.Any; codec: JsonCodec; reply?: JsonCodec }>();
    const rejections = new Map<string, JsonCodec>();
    for (const command of def.commands) {
      commands.set(command.tag, {
        cls: command,
        codec: jsonCodec(command),
        reply: command.reply ? jsonCodec(command.reply) : undefined,
      });
      for (const rejection of command.rejects) {
        const tag = rejectionTag(rejection);
        if (!rejections.has(tag)) rejections.set(tag, jsonCodec(rejection));
      }
    }
    const encodedInitial = Schema.encodeUnknownExit(Schema.toCodecJson(def.state as any) as any)(
      def.initial,
    );
    const initial: Json = Exit.isSuccess(encodedInitial) ? encodedInitial.value : null;
    if (Exit.isFailure(encodedInitial)) {
      problem(
        new InvalidInitial({
          owner: aggregate.aggregateName,
          cause: Cause.squash(encodedInitial.cause),
        }),
      );
    }
    aggregateCodecs.set(aggregate.aggregateName, {
      state,
      initial,
      commands,
      rejections,
      events: new Set(def.events.map((e: Event.Any) => e.tag)),
    });
  }
  const codecsOf = (aggregate: Aggregate.Any) => aggregateCodecs.get(aggregate.aggregateName)!;

  // --------------------------------------------------------------- sources
  type SourceEntry =
    | { readonly kind: "aggregate"; readonly aggregate: Aggregate.Any }
    | { readonly kind: "view"; readonly view: View.Any };
  const sources = new Map<string, SourceEntry>();
  const addSource = (name: string, entry: SourceEntry) => {
    if (sources.has(name)) return problem(new DuplicateName({ entity: name }));
    sources.set(name, entry);
  };
  for (const aggregate of definitions.aggregates) {
    addSource(aggregate.aggregateName, { kind: "aggregate", aggregate });
  }
  for (const view of definitions.views) {
    addSource(view.viewName, { kind: "view", view });
    for (const event of view.definition.events ?? []) registerEvent(event);
  }
  const nameOf = (source: View.Source) =>
    source.kind === "Aggregate"
      ? (source as Aggregate.Any).aggregateName
      : (source as View.Any).viewName;
  const sourceEntry = (owner: string, source: View.Source): SourceEntry | undefined => {
    const entry = sources.get(nameOf(source));
    const entity = entry?.kind === "aggregate" ? entry.aggregate : entry?.view;
    if (entity !== source) {
      problem(new UnknownSource({ consumer: owner, source: nameOf(source) }));
      return undefined;
    }
    return entry;
  };
  /** The key that identifies a source's instances: its aggregate, or a view's key. */
  const keyOfSource = (entry: SourceEntry): Key.Any =>
    entry.kind === "aggregate" ? entry.aggregate : entry.view.definition.key;

  for (const stream of definitions.streams) {
    if (sources.has(stream.streamName)) {
      problem(new DuplicateName({ entity: stream.streamName }));
    }
    for (const event of stream.definition.entries) registerEvent(event);
  }

  /** Does a view take this event from this source? */
  const consumes = (view: View.Any, tag: string, source: string) => {
    const def = view.definition;
    return Boolean(
      def.evolve?.[tag] ||
      def.evolve?.[source] ||
      def.emit?.[tag] ||
      def.emit?.[source] ||
      def.events?.some((event) => event.tag === tag),
    );
  };
  /** The tags of the events a source produces. */
  const outputs = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();
  const outputTags = (entry: SourceEntry): ReadonlySet<string> => {
    if (entry.kind === "aggregate") return codecsOf(entry.aggregate).events;
    const view = entry.view;
    const known = outputs.get(view.viewName);
    if (known) return known;
    if (view.definition.events) {
      const declared = new Set(view.definition.events.map((event) => event.tag));
      outputs.set(view.viewName, declared);
      return declared;
    }
    if (visiting.has(view.viewName)) {
      problem(new ConsumesItself({ view: view.viewName }));
      return new Set();
    }
    visiting.add(view.viewName);
    const tags = new Set<string>();
    for (const source of view.definition.from) {
      const upstream = sourceEntry(view.viewName, source);
      if (!upstream) continue;
      for (const tag of outputTags(upstream)) {
        if (consumes(view, tag, nameOf(source))) tags.add(tag);
      }
    }
    visiting.delete(view.viewName);
    outputs.set(view.viewName, tags);
    return tags;
  };

  // --------------------------------------------------------------- routing
  /** What routing sees of an event. */
  interface RouteInput {
    readonly event: unknown;
    /** The source instance: a ref, or a Schema-keyed view's key value. */
    readonly source: unknown;
    readonly envelope: Aggregate.Envelope;
    readonly state: unknown;
    /** The source stream, e.g. `Account/a-1`. */
    readonly stream: string;
  }
  type Route = (input: RouteInput) => ReadonlyArray<{
    readonly key: string;
    readonly routes?: ReadonlyArray<string>;
  }>;
  interface Subscriber {
    readonly kind: "view" | "policy" | "projection";
    readonly name: string;
    readonly route: Route;
  }
  type Handler = (...args: ReadonlyArray<unknown>) => unknown;
  type HandlerMap = { readonly [key: string]: Handler | Record<string, Handler | undefined> };
  const handlers = (value: unknown) => value as HandlerMap | undefined;

  const subscribers = new Map<string, Map<string, Array<Subscriber>>>();
  const subscribe = (source: string, tag: string, subscriber: Subscriber) => {
    const byTag = subscribers.get(source) ?? new Map<string, Array<Subscriber>>();
    subscribers.set(source, byTag);
    const list = byTag.get(tag) ?? [];
    byTag.set(tag, list);
    list.push(subscriber);
  };

  /** Routes that key an event by its own source instance: key `x` hears only from instance `x`. */
  const identityRoutes = new WeakSet<Route>();

  /** How a consumer keyed by `def.key` routes `tag` from `source`. */
  const keyRoute = (
    owner: string,
    def: { readonly key: Key.Any; readonly keyOf?: unknown },
    upstream: SourceEntry,
    source: string,
    tag: string,
  ): Route => {
    const custom = handlers(def.keyOf)?.[tag] ?? handlers(def.keyOf)?.[source];
    const routing = (input: RouteInput) => ({
      event: input.event,
      source: input.source,
      state: input.state,
      envelope: input.envelope,
    });
    // A route returns a ref for an aggregate key, or the value of a Schema key.
    if (typeof custom === "function") {
      return (input) => {
        const ref = custom(routing(input));
        return ref === undefined ? [] : [{ key: Aggregate.targetId(ref) }];
      };
    }
    if (custom) {
      const routes = Object.entries(custom);
      return (input) => {
        const byKey = new Map<string, Array<string>>();
        for (const [route, fn] of routes) {
          const ref = fn?.(routing(input));
          if (ref === undefined) continue;
          const key = Aggregate.targetId(ref);
          const list = byKey.get(key) ?? [];
          byKey.set(key, list);
          list.push(route);
        }
        return [...byKey].map(([key, names]) => ({ key, routes: names }));
      };
    }
    if (keyOfSource(upstream) === def.key) {
      const route: Route = (input) => [{ key: Aggregate.targetId(input.source) }];
      identityRoutes.add(route);
      return route;
    }
    problem(
      new MissingKeyOf({
        consumer: owner,
        event: tag,
        source,
        keyedBy: Key.isAggregate(def.key) ? def.key.aggregateName : undefined,
      }),
    );
    return () => [];
  };

  for (const view of definitions.views) {
    const def = view.definition;
    if (def.state !== undefined && def.initial === undefined) {
      problem(new MissingInitial({ view: view.viewName }));
    }
    // Route-keyed handlers need the same routes in keyOf.
    for (const field of ["evolve", "emit"] as const) {
      for (const [name, handler] of Object.entries(handlers(def[field]) ?? {})) {
        if (typeof handler === "function" || !handler) continue;
        const routes = handlers(def.keyOf)?.[name];
        for (const route of Object.keys(handler)) {
          if (typeof routes !== "object" || !(route in routes)) {
            problem(
              new UnmatchedRoute({ view: view.viewName, handler: field, source: name, route }),
            );
          }
        }
      }
    }
    for (const source of def.from) {
      const upstream = sourceEntry(view.viewName, source);
      if (!upstream) continue;
      const name = nameOf(source);
      for (const tag of outputTags(upstream)) {
        if (!consumes(view, tag, name)) continue;
        subscribe(name, tag, {
          kind: "view",
          name: view.viewName,
          route: keyRoute(view.viewName, def, upstream, name, tag),
        });
      }
    }
  }

  const fromList = (from: Policy.From): ReadonlyArray<View.Source> =>
    Array.isArray(from) ? from : [from as View.Source];

  /** Subscribe a consumer to the `on` events its sources produce. */
  const subscribeConsumer = (
    kind: "policy" | "projection",
    owner: string,
    from: ReadonlyArray<View.Source>,
    on: ReadonlyArray<Event.Any>,
    route: (upstream: SourceEntry, source: string, tag: string) => Route,
  ) => {
    for (const event of on) {
      let produced = false;
      for (const source of from) {
        const upstream = sourceEntry(owner, source);
        if (!upstream) {
          produced = true; // already reported
          continue;
        }
        if (!outputTags(upstream).has(event.tag)) continue;
        produced = true;
        const name = nameOf(source);
        subscribe(name, event.tag, {
          kind,
          name: owner.replace(/^(Policy|Projection) /, ""),
          route: route(upstream, name, event.tag),
        });
      }
      if (!produced) {
        problem(new NoEmitter({ consumer: owner, sources: from.map(nameOf), event: event.tag }));
      }
    }
  };

  const policyByName = new Map<string, Policy.Any>();
  for (const policy of definitions.policies) {
    if (policyByName.has(policy.policyName)) {
      problem(new DuplicateDefinition({ kind: "policy", entity: policy.policyName }));
      continue;
    }
    policyByName.set(policy.policyName, policy);
    const def = policy.definition;
    const owner = `Policy ${policy.policyName}`;
    subscribeConsumer("policy", owner, fromList(def.from), def.on, (upstream, source, tag) =>
      def.key
        ? keyRoute(owner, { key: def.key, keyOf: def.keyOf }, upstream, source, tag)
        : // Unkeyed: one partition per source instance, so its triggers run in order.
          (input) => [{ key: input.stream }],
    );
  }

  const projectionByName = new Map<string, Projection.Any>();
  const writers = new Map<string, Projection.Any>();
  const streamNames = new Set(definitions.streams.map((stream) => stream.streamName));
  for (const projection of definitions.projections) {
    const name = projection.projectionName;
    if (projectionByName.has(name)) {
      problem(new DuplicateDefinition({ kind: "projection", entity: name }));
      continue;
    }
    projectionByName.set(name, projection);
    const def = projection.definition;
    const owner = `Projection ${name}`;
    subscribeConsumer("projection", owner, def.from, def.on, (upstream, source, tag) =>
      keyRoute(owner, def, upstream, source, tag),
    );
    for (const stream of def.writes ?? []) {
      if (!streamNames.has(stream.streamName)) {
        problem(new UnknownStream({ writer: owner, stream: stream.streamName }));
        continue;
      }
      const existing = writers.get(stream.streamName);
      if (existing && existing !== projection) {
        problem(
          new TwoWriters({
            stream: stream.streamName,
            first: existing.projectionName,
            second: name,
          }),
        );
        continue;
      }
      if (stream.definition.key !== def.key) {
        problem(
          new WriterKeyMismatch({
            writer: owner,
            key: Key.describe(def.key),
            stream: stream.streamName,
            streamKey: Key.describe(stream.definition.key),
          }),
        );
        continue;
      }
      writers.set(stream.streamName, projection);
    }
  }

  // ------------------------------------------------------------ generations
  const versions = new Map<string, number>();
  const generations = new Map<string, number>();
  const viewSources = (from: ReadonlyArray<View.Source>) =>
    from.flatMap((source) => (source.kind === "Aggregate" ? [] : [(source as View.Any).viewName]));
  const viewByName = new Map(definitions.views.map((view) => [view.viewName, view]));
  /** A consumer's own version: a view's from its declaration, a projection's from its Layer. */
  const versionOf = (kind: "view" | "projection", name: string) =>
    versions.get(`${kind}:${name}`) ??
    (kind === "view" ? (viewByName.get(name)?.definition.version ?? 0) : 0);
  /**
   * A consumer's generation: its own version plus the generations of the
   * views it reads, so rebuilding a view rebuilds everything built on it.
   */
  const generationOf = (kind: "view" | "projection" | "policy", name: string): number => {
    if (kind === "policy") return 0;
    const id = `${kind}:${name}`;
    const known = generations.get(id);
    if (known !== undefined) return known;
    const from =
      kind === "view"
        ? viewByName.get(name)?.definition.from
        : projectionByName.get(name)?.definition.from;
    const generation =
      versionOf(kind, name) +
      viewSources(from ?? []).reduce((sum, view) => sum + generationOf("view", view), 0);
    generations.set(id, generation);
    return generation;
  };
  /**
   * A view keyed by the one aggregate it reads is rebuilt in place: every key
   * holds exactly its own instance's events, so it can read them again itself.
   */
  const inPlace = (kind: "view" | "projection" | "policy", name: string): boolean => {
    if (kind !== "view") return false;
    const from = viewByName.get(name)?.definition.from ?? [];
    return (
      from.length === 1 &&
      from[0]!.kind === "Aggregate" &&
      singleSource(CatchUp.targetId({ kind, name }))
    );
  };
  /**
   * The generation of a consumer's storage (its Durable Object class): its
   * generation, except that a view rebuilt in place keeps its storage.
   */
  const classGenerationOf = (kind: "view" | "projection", name: string): number =>
    inPlace(kind, name) ? 0 : generationOf(kind, name);
  /** Where a subscriber's deliveries go, with its generation when it has one. */
  const targetOf = (subscriber: Pick<Subscriber, "kind" | "name">): Delivery["target"] => {
    const generation = generationOf(subscriber.kind, subscriber.name);
    return {
      kind: subscriber.kind,
      name: subscriber.name,
      ...(generation > 0 ? { generation } : {}),
      ...(generation > 0 && inPlace(subscriber.kind, subscriber.name) ? { inPlace: true } : {}),
    };
  };
  /** A consumer's id, by `CatchUp.targetId`, in this code. */
  const targetIdOf = (kind: "view" | "projection", name: string) =>
    CatchUp.targetId(targetOf({ kind, name }));

  /** Every delivery an event produces; only to the consumers in `only`, if given. */
  const fanOut = (
    input: RouteInput,
    delivery: Omit<Delivery, "target" | "key" | "routes">,
    only?: ReadonlySet<string>,
  ): Array<Delivery> => {
    const out: Array<Delivery> = [];
    for (const subscriber of subscribers.get(delivery.origin)?.get(delivery.tag) ?? []) {
      const target = targetOf(subscriber);
      if (only && !only.has(CatchUp.targetId(target))) continue;
      for (const { key, routes } of subscriber.route(input)) {
        out.push({
          ...delivery,
          target,
          key,
          ...(routes ? { routes } : {}),
        });
      }
    }
    return out;
  };

  /** The views and projections that consume a source: the consumers it catches up. */
  const targetsOf = (source: string): ReadonlyArray<string> => {
    const out = new Set<string>();
    for (const list of subscribers.get(source)?.values() ?? []) {
      for (const subscriber of list) {
        if (subscriber.kind !== "policy") out.add(CatchUp.targetId(targetOf(subscriber)));
      }
    }
    return [...out].sort();
  };

  /**
   * Whether every key of a consumer has exactly one source: it hears only from
   * the instance with its own id, of one source. Such a key has nothing to merge
   * and nothing to wait for: it can take its history as soon as its source has it.
   */
  const singleSource = (target: string): boolean => {
    const [kind, rest] = target.split(":") as [string, string];
    const name = rest.replace(/[#@]\d+$/, "");
    const sources = new Set<string>();
    for (const [source, byTag] of subscribers) {
      for (const list of byTag.values()) {
        for (const subscriber of list) {
          if (subscriber.kind !== kind || subscriber.name !== name) continue;
          if (!identityRoutes.has(subscriber.route)) return false;
          sources.add(source);
        }
      }
    }
    return sources.size === 1;
  };

  /**
   * The sources (aggregates and views, by name) a consumer reads, by
   * `CatchUp.targetId`; `undefined` for one this model doesn't have.
   */
  const sourcesOf = (target: string): ReadonlyArray<string> | undefined => {
    const [kind, rest] = target.split(":") as [string, string];
    const name = (rest ?? "").replace(/[#@]\d+$/, "");
    const known =
      kind === "view"
        ? definitions.views.some((view) => view.viewName === name)
        : definitions.projections.some((projection) => projection.projectionName === name);
    if (!known) return undefined;
    const sources = new Set<string>();
    for (const [source, byTag] of subscribers) {
      for (const list of byTag.values()) {
        if (list.some((subscriber) => subscriber.kind === kind && subscriber.name === name))
          sources.add(source);
      }
    }
    return [...sources].sort();
  };

  const planOf = (target: string): Plan | undefined => {
    const sources = sourcesOf(target);
    if (sources === undefined) return undefined;
    // Rebuilt views among its sources: their keys are the objects named for their generation.
    const generations: Record<string, number> = {};
    for (const source of sources) {
      if (!definitions.views.some((view) => view.viewName === source)) continue;
      // Where the source's keys are stored: a view rebuilt in place keeps its storage.
      const generation = classGenerationOf("view", source);
      if (generation > 0) generations[source] = generation;
    }
    return {
      sources,
      singleSource: singleSource(target),
      ...(Object.keys(generations).length > 0 ? { generations } : {}),
    };
  };

  /** Each source's replay, built once: what routes its stored rows as history. */
  const replayers = new Map<
    string,
    {
      readonly replay: (input: CatchUp.ReplayInput<any>) => Effect.Effect<CatchUp.ReplayResult>;
      readonly seqOf: (row: any) => number;
    }
  >();
  const replayerOf = (source: string) => {
    let found = replayers.get(source);
    if (found) return found;
    const aggregate = definitions.aggregates.find((a) => a.aggregateName === source);
    const view = definitions.views.find((v) => v.viewName === source);
    if (aggregate)
      found = {
        replay: aggregateKit(aggregate, () => Effect.void).replay,
        seqOf: (row: StoredEvent) => row.envelope.seq,
      };
    else if (view)
      found = {
        replay: viewKit(view, () => Effect.void).replay,
        seqOf: (row: ViewEntry) => row.seq,
      };
    if (found) replayers.set(source, found);
    return found;
  };
  const history = (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ): Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  > => {
    const replayer = replayerOf(source);
    if (!replayer) return Effect.succeed([]);
    const targets = targetsOf(source);
    return Effect.forEach(rows, (row) => {
      const seq = replayer.seqOf(row);
      return Effect.map(
        replayer.replay({
          id,
          routed: Object.fromEntries(
            targets.map((t) => [t, t === target ? seq - 1 : Number.MAX_SAFE_INTEGER]),
          ),
          rows: [row],
        }),
        ({ deliveries }) => ({ seq, deliveries }),
      );
    });
  };

  /** Replay stored rows to the consumers lagging behind them, in order. */
  const replay = Effect.fnUntraced(function* <Row>(
    targets: ReadonlyArray<string>,
    input: CatchUp.ReplayInput<Row>,
    seqOf: (row: Row) => number,
    route: (row: Row, only: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<Delivery>>,
  ) {
    const routed: Record<string, number> = { ...input.routed };
    const deliveries: Array<Delivery> = [];
    for (const row of input.rows) {
      const seq = seqOf(row);
      const lagging = new Set(targets.filter((target) => (routed[target] ?? 0) < seq));
      if (lagging.size === 0) continue;
      deliveries.push(...(yield* route(row, lagging)));
      for (const target of lagging) routed[target] = seq;
    }
    return { deliveries, routed } satisfies CatchUp.ReplayResult;
  });

  const viewCodecs = new Map<string, JsonCodec>();
  const viewCodec = (view: View.Any) => {
    let codec = viewCodecs.get(view.viewName);
    if (!codec) viewCodecs.set(view.viewName, (codec = jsonCodec(view.definition.state!)));
    return codec;
  };
  /** Decode the state a delivery carries from a view source. */
  const sourceState = (entry: SourceEntry, json: Json) =>
    json === undefined || json === null || entry.kind !== "view" || !entry.view.definition.state
      ? json
      : viewCodec(entry.view).decode(json);

  // ------------------------------------------------------------------ kits
  const aggregateKit = (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): Omit<AggregateKit, "push"> => {
    const def = aggregate.definition;
    const codecs = codecsOf(aggregate);
    // oxlint-disable-next-line effecttsgo/schema-sync -- ids decode synchronously when building refs
    const decodeId = Schema.decodeUnknownSync(def.id as any) as (u: unknown) => unknown;
    const commit = Effect.fnUntraced(function* (
      id: string,
      state: unknown,
      version: number,
      decided: ReadonlyArray<{ readonly _tag: string }>,
      now: DateTime.Utc,
      commandId: string,
      history: boolean,
      correlationId: string = commandId,
      trace?: Telemetry.TraceJson,
    ) {
      const stream = `${aggregate.aggregateName}/${id}`;
      const events: Array<StoredEvent> = [];
      const deliveries: Array<Delivery> = [];
      const sourceRef = Aggregate.makeRef(aggregate, id);
      let next = state;
      for (const [index, event] of decided.entries()) {
        if (!codecs.events.has(event._tag)) {
          return yield* Effect.die(
            new DefinitionError({
              reason: new UndeclaredEvent({
                aggregate: aggregate.aggregateName,
                event: event._tag,
              }),
            }),
          );
        }
        const envelope: Aggregate.Envelope = {
          id,
          stream,
          seq: version + index + 1,
          at: now,
          commandId,
          correlationId,
        };
        next = (def.evolve as Record<string, (...args: any[]) => unknown>)[event._tag](
          next,
          event,
          envelope,
        );
        const stored: StoredEvent = {
          event: yield* encodeEvent(event),
          envelope: encodeEnvelope(envelope, trace),
        };
        events.push(stored);
        deliveries.push(
          ...fanOut(
            { event, source: sourceRef, envelope, state: undefined, stream },
            {
              source: stream,
              seq: envelope.seq,
              origin: aggregate.aggregateName,
              tag: event._tag,
              event: stored.event,
              envelope: stored.envelope,
              ...(history ? { history } : {}),
            },
          ),
        );
      }
      return { next, events, deliveries };
    });
    return {
      name: aggregate.aggregateName,
      deliver,
      // Read when used: versions are set once the whole model is built.
      consumerSingleSource: (target: string) => singleSource(target),
      get targets() {
        return targetsOf(aggregate.aggregateName);
      },
      replay: (input) => {
        const targets = targetsOf(aggregate.aggregateName);
        const id = decodeId(input.id) as string;
        const stream = `${aggregate.aggregateName}/${id}`;
        const sourceRef = Aggregate.makeRef(aggregate, id);
        return replay(
          targets,
          input,
          (row) => row.envelope.seq,
          (row, only) =>
            Effect.map(decodeEvent(row.event), (event) =>
              fanOut(
                {
                  event,
                  source: sourceRef,
                  envelope: decodeEnvelope(row.envelope),
                  state: undefined,
                  stream,
                },
                {
                  source: stream,
                  seq: row.envelope.seq,
                  origin: aggregate.aggregateName,
                  tag: (row.event as { readonly _tag: string })._tag,
                  event: row.event,
                  envelope: row.envelope,
                  history: true,
                },
                only,
              ),
            ),
        );
      },
      seed: Effect.fnUntraced(function* (input) {
        const id = decodeId(input.id) as string;
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const decided = (yield* Effect.forEach(input.events, decodeEvent)) as ReadonlyArray<{
          readonly _tag: string;
        }>;
        const result = yield* commit(
          id,
          state,
          input.version,
          decided,
          DateTime.makeUnsafe(input.now),
          input.commandId,
          true,
        );
        return {
          state: codecs.state.encode(result.next),
          version: input.version + decided.length,
          events: result.events,
          deliveries: result.deliveries,
        };
      }),
      handle: (input) => {
        const tag = (input.command as { readonly _tag: string })._tag;
        const correlationId = input.correlationId ?? input.commandId;
        const base = {
          "domain.aggregate": aggregate.aggregateName,
          "domain.command": tag,
          "domain.id": String(input.id),
          "domain.stream": `${aggregate.aggregateName}/${input.id}`,
          "domain.command_id": input.commandId,
          "domain.correlation_id": correlationId,
        };
        const decideAndCommit = Effect.gen(function* () {
          const command = codecs.commands.get(tag);
          if (!command) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new UnhandledCommand({ aggregate: aggregate.aggregateName, command: tag }),
              }),
            );
          }
          const decoded = command.codec.decode(input.command) as { readonly _tag: string };
          yield* Effect.annotateCurrentSpan(Telemetry.attributesOf(command.cls, decoded));
          const state = codecs.state.decode(input.state ?? codecs.initial);
          const id = decodeId(input.id) as string;
          const now = DateTime.makeUnsafe(input.now);
          let decision = (def.decide as Record<string, (...args: any[]) => unknown>)[decoded._tag](
            state,
            decoded,
            {
              id,
              now,
              commandId: input.commandId,
              stream: `${aggregate.aggregateName}/${id}`,
              version: input.version,
            },
          );
          // An effectful decision runs here, inside the decide span, with the
          // context the command was sent with (its only requirement, enforced
          // by `Aggregate.Decision`).
          if (Effect.isEffect(decision)) {
            const context = yield* RequestContext.restore(input.context);
            const settled = settle(
              yield* Effect.exit(
                Effect.provideContext(decision, context as Context.Context<unknown>),
              ),
            );
            if (settled._tag === "Failed")
              return yield* Effect.failCause(settled.cause as Cause.Cause<never>);
            decision = settled.decision;
          }
          const judged = judge(aggregate.aggregateName, command.cls, decision);
          if (judged._tag === "Undeclared") return yield* Effect.die(judged.error);
          if (judged._tag === "Rejected") {
            const rejection = judged.rejection;
            const codec = codecs.rejections.get(rejection._tag)!;
            const declared = command.cls.rejects.find((r) => rejectionTag(r) === rejection._tag)!;
            yield* Effect.annotateCurrentSpan({
              "domain.outcome": rejection._tag,
              ...Telemetry.attributesOf(declared, rejection),
            });
            return { _tag: "Rejected", rejection: codec.encode(rejection) } as HandleResult;
          }
          const trace = yield* Telemetry.currentTrace;
          const { next, events, deliveries } = yield* commit(
            id,
            state,
            input.version,
            judged.events,
            now,
            input.commandId,
            false,
            correlationId,
            trace,
          );
          const replyFn = (def.reply as Record<string, (...args: any[]) => unknown> | undefined)?.[
            decoded._tag
          ];
          const reply =
            replyFn && command.reply ? command.reply.encode(replyFn(next, judged.events)) : null;
          const decided = judged.events;
          yield* Effect.annotateCurrentSpan({
            "domain.outcome": "accepted",
            "domain.events": decided.length,
            "domain.version": input.version + decided.length,
          });
          const span = yield* Effect.orElseSucceed(Effect.currentSpan, () => undefined);
          const at = BigInt(input.now) * 1_000_000n;
          for (const [index, event] of decided.entries()) {
            span?.event(event._tag, at, {
              "domain.seq": input.version + index + 1,
              ...eventAttributes(event),
            });
            yield* Telemetry.record(Telemetry.events, {
              "domain.aggregate": aggregate.aggregateName,
              "domain.event": event._tag,
            });
          }
          return {
            _tag: "Accepted",
            state: codecs.state.encode(next),
            version: input.version + decided.length,
            events,
            reply,
            deliveries,
          } as HandleResult;
        });
        return Effect.gen(function* () {
          const started = yield* Effect.sync(() => Date.now());
          const result = yield* decideAndCommit.pipe(
            Effect.annotateLogs(base),
            Effect.withSpan(`Domain.decide ${aggregate.aggregateName}.${tag}`, {
              kind: "server",
              attributes: base,
              ...(input.trace && !input.link ? { parent: Telemetry.spanOf(input.trace) } : {}),
              ...(input.trace && input.link
                ? { links: [{ span: Telemetry.spanOf(input.trace), attributes: {} }] }
                : {}),
            }),
          );
          const outcome =
            result._tag === "Accepted"
              ? "accepted"
              : ((result.rejection as { readonly _tag?: string })._tag ?? "rejected");
          const tags = { "domain.aggregate": aggregate.aggregateName, "domain.command": tag };
          yield* Telemetry.record(Telemetry.commands, { ...tags, "domain.outcome": outcome });
          yield* Telemetry.record(
            Telemetry.commandDuration,
            tags,
            (yield* Effect.sync(() => Date.now())) - started,
          );
          return result;
        });
      },
    };
  };

  /** The handler for an input: by event tag, else by source name; per route if routed. */
  const pick = (
    map: HandlerMap | undefined,
    tag: string,
    source: string,
    route: string | undefined,
  ): Handler | undefined => {
    const handler = map?.[tag] ?? map?.[source];
    if (typeof handler === "function") return handler;
    return handler && route !== undefined ? handler[route] : undefined;
  };

  const viewKit = (
    view: View.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): Omit<ViewKit, "push"> => {
    const def = view.definition;
    const stateful = def.state !== undefined;
    const codec = stateful ? viewCodec(view) : undefined;
    const declared = def.events ? new Set(def.events.map((event) => event.tag)) : undefined;
    const evolve = handlers(def.evolve);
    const emit = handlers(def.emit);
    const encodeState = (state: unknown) =>
      codec && state !== null && state !== undefined ? codec.encode(state) : null;
    return {
      name: view.viewName,
      deliver,
      consumerSingleSource: (target: string) => singleSource(target),
      get targets() {
        return targetsOf(view.viewName);
      },
      get generation() {
        return generationOf("view", view.viewName);
      },
      get classGeneration() {
        return classGenerationOf("view", view.viewName);
      },
      get target() {
        return targetIdOf("view", view.viewName);
      },
      get singleSource() {
        return singleSource(`view:${view.viewName}`);
      },
      history: (target, source, id, rows) => history(target, source, id, rows),
      replay: (input) => {
        const targets = targetsOf(view.viewName);
        const keyRef = Key.refOf(def.key, input.id);
        const stream = `${view.viewName}/${input.id}`;
        return replay(
          targets,
          input,
          (row) => row.seq,
          (row, only) =>
            Effect.map(decodeEvent(row.event), (event) =>
              fanOut(
                {
                  event,
                  source: keyRef,
                  envelope: decodeEnvelope(row.envelope),
                  state: codec && row.state !== null ? codec.decode(row.state) : null,
                  stream,
                },
                {
                  source: stream,
                  seq: row.seq,
                  origin: view.viewName,
                  tag: (row.event as { readonly _tag: string })._tag,
                  event: row.event,
                  envelope: row.envelope,
                  state: row.state,
                  history: true,
                },
                only,
              ),
            ),
        );
      },
      observe: (key, batch) => (effect) => {
        if (!telemetry.views || batch.every((d) => d.history)) return effect;
        const traces = batch.flatMap((d) => (d.envelope.trace ? [d.envelope.trace] : []));
        const single = batch.length === 1 && traces.length === 1;
        const attributes = {
          "domain.view": view.viewName,
          "domain.key": key,
          "domain.batch": batch.length,
          ...(batch.length === 1 ? deliveryAttributes(batch[0]!) : {}),
        };
        return effect.pipe(
          Effect.withSpan(`Domain.view ${view.viewName}`, {
            kind: "consumer",
            attributes,
            ...(single
              ? { parent: Telemetry.spanOf(traces[0]!) }
              : { links: traces.map((t) => ({ span: Telemetry.spanOf(t), attributes: {} })) }),
          }),
          Effect.tap(() =>
            Telemetry.record(Telemetry.runs, {
              "domain.kind": "view",
              "domain.consumer": view.viewName,
              "domain.outcome": "ok",
            }),
          ),
        );
      },
      apply: Effect.fnUntraced(function* (key, snapshot, batch) {
        let current: unknown =
          codec && snapshot.state !== null ? codec.decode(snapshot.state) : null;
        let { version, seq } = snapshot;
        const checkpoints: Record<string, number> = { ...snapshot.checkpoints };
        let changed = false;
        const entries: Array<ViewEntry> = [];
        const downstream: Array<Delivery> = [];
        const keyRef = Key.refOf(def.key, key);
        const stream = `${view.viewName}/${key}`;
        const generation = generationOf("view", view.viewName);
        for (const delivery of batch) {
          const sent = delivery.target.generation ?? 0;
          // For an earlier generation: sent by an instance still on older code.
          if (sent < generation) continue;
          if (sent > generation) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new NewerGeneration({ consumer: view.viewName, sent, runs: generation }),
              }),
            );
          }
          if ((checkpoints[delivery.source] ?? 0) >= delivery.seq) continue;
          checkpoints[delivery.source] = delivery.seq;
          changed = true;
          const origin = sources.get(delivery.origin)!;
          const event = (yield* decodeEvent(delivery.event)) as { readonly _tag: string };
          const envelope = decodeEnvelope(delivery.envelope);
          const context = {
            key: keyRef,
            source: Key.refOf(keyOfSource(origin), envelope.id),
            state: sourceState(origin, delivery.state),
            envelope,
            at: envelope.at,
          };
          for (const route of delivery.routes ?? [undefined]) {
            const before = stateful ? (current ?? def.initial) : null;
            const evolveFn = stateful
              ? pick(evolve, delivery.tag, delivery.origin, route)
              : undefined;
            if (evolveFn) {
              current = evolveFn(before, event, context) ?? null;
              version += 1;
            }
            const emitFn = pick(emit, delivery.tag, delivery.origin, route);
            const emitted = !declared
              ? evolveFn
                ? [event]
                : []
              : emitFn
                ? [emitFn(event, { ...context, before, after: current })].flat()
                : declared.has(delivery.tag)
                  ? [event]
                  : [];
            for (const out of emitted as ReadonlyArray<{ readonly _tag: string } | undefined>) {
              if (out === undefined) continue;
              if (declared && !declared.has(out._tag)) {
                return yield* Effect.die(
                  new DefinitionError({
                    reason: new UndeclaredEmit({ view: view.viewName, event: out._tag }),
                  }),
                );
              }
              seq += 1;
              const outEnvelope: Aggregate.Envelope = {
                id: key,
                stream,
                seq,
                at: envelope.at,
                commandId: envelope.commandId,
                correlationId: envelope.correlationId,
              };
              const entry: ViewEntry = {
                seq,
                event: yield* encodeEvent(out),
                envelope: encodeEnvelope(outEnvelope, delivery.envelope.trace),
                state: encodeState(current),
              };
              entries.push(entry);
              downstream.push(
                ...fanOut(
                  { event: out, source: keyRef, envelope: outEnvelope, state: current, stream },
                  {
                    source: stream,
                    seq,
                    origin: view.viewName,
                    tag: out._tag,
                    event: entry.event,
                    envelope: entry.envelope,
                    state: entry.state,
                    ...(delivery.history ? { history: true } : {}),
                  },
                ),
              );
            }
          }
        }
        const next: ViewSnapshot = {
          state: encodeState(current),
          version,
          checkpoints,
          seq,
          ...(generation > 0 ? { generation } : {}),
        };
        return { snapshot: next, changed, entries, downstream };
      }),
    };
  };

  const policyKit = (policy: Policy.Any, handler: Policy.Handler<unknown>): PolicyKit => {
    const policyKey = policy.definition.key;
    return {
      name: policy.policyName,
      run: (delivery) => {
        // Seeded history is the past; policies only react to what happens now.
        if (delivery.history) return Effect.void;
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Key.refOf(keyOfSource(upstream), envelope.id);
        const key = policyKey ? Key.refOf(policyKey, delivery.key) : source;
        const state = sourceState(upstream, delivery.state);
        const attributes = {
          "domain.policy": policy.policyName,
          "domain.key": delivery.key,
          ...deliveryAttributes(delivery),
        };
        const parent = parentOf(delivery);
        return Effect.flatMap(decodeEvent(delivery.event), (event) =>
          Effect.forEach(
            delivery.routes ?? [undefined],
            (route) => {
              let n = 0;
              const prefix = `${delivery.source}:${delivery.seq}:${policy.policyName}${route === undefined ? "" : `:${route}`}`;
              return handler({ key, route, source, event, envelope, state }).pipe(
                Effect.provideContext(
                  Context.make(Aggregate.PolicyRun, { next: () => `${prefix}:${n++}` }).pipe(
                    Context.add(Telemetry.Correlation, { id: envelope.correlationId }),
                  ),
                ),
              );
            },
            { discard: true },
          ).pipe(
            Effect.tap(() =>
              Effect.annotateCurrentSpan(eventAttributes(event as { readonly _tag: string })),
            ),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const now = yield* Effect.sync(() => Date.now());
              const tags = { "domain.kind": "policy", "domain.consumer": policy.policyName };
              yield* Telemetry.record(Telemetry.lag, tags, now - delivery.envelope.at);
              yield* Telemetry.record(Telemetry.runs, {
                ...tags,
                "domain.outcome": Exit.isSuccess(exit) ? "ok" : "failed",
              });
            }),
          ),
          Effect.annotateLogs(attributes),
          Effect.withSpan(`Domain.policy ${policy.policyName}`, {
            kind: "consumer",
            attributes,
            ...(parent ? { parent } : {}),
          }),
        );
      },
    };
  };

  const projectionInputs = (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ): Effect.Effect<ReadonlyArray<unknown>> =>
    Effect.gen(function* () {
      const keyRef = Key.refOf(projection.definition.key, key);
      const inputs: Array<unknown> = [];
      for (const { delivery, position } of batch) {
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Key.refOf(keyOfSource(upstream), envelope.id);
        const event = yield* decodeEvent(delivery.event);
        const state = sourceState(upstream, delivery.state);
        // Shared by every route the delivery takes, so their appends count up together.
        const meta: InputMetaValue = {
          projection: projection.projectionName,
          key,
          position,
          source: delivery.source,
          sourceSeq: delivery.seq,
          at: delivery.envelope.at,
          commandId: delivery.envelope.commandId,
          appends: 0,
        };
        for (const route of delivery.routes ?? [undefined]) {
          const input = { key: keyRef, route, source, event, envelope, state, position };
          Object.defineProperty(input, InputMeta, { value: meta, enumerable: false });
          inputs.push(input);
        }
      }
      return inputs;
    });

  const projectionKeys = (
    projection: Projection.Any,
    aggregate: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
  ): ReadonlyArray<string> => {
    const entry = sources.get(aggregate);
    if (entry?.kind !== "aggregate") return [];
    const stream = `${aggregate}/${id}`;
    const envelope: Aggregate.Envelope = {
      id,
      stream,
      seq,
      at: DateTime.makeUnsafe(0),
      commandId: "",
      correlationId: "",
    };
    const keys: Array<string> = [];
    for (const subscriber of subscribers.get(aggregate)?.get(event._tag) ?? []) {
      if (subscriber.kind !== "projection" || subscriber.name !== projection.projectionName)
        continue;
      const input = {
        event,
        source: Aggregate.makeRef(entry.aggregate, id),
        envelope,
        state: undefined,
        stream,
      };
      for (const { key } of subscriber.route(input)) keys.push(key);
    }
    return keys;
  };

  return {
    aggregateKit,
    viewKit,
    policyKit,
    projectionInputs,
    projectionKeys,
    get targets() {
      return [
        ...definitions.views.map((view) => targetIdOf("view", view.viewName)),
        ...definitions.projections.map((projection) =>
          targetIdOf("projection", projection.projectionName),
        ),
      ].sort();
    },
    singleSource,
    sourcesOf,
    planOf,
    history,
    setVersion: (consumer, version) => {
      versions.set(consumer, version);
      generations.clear();
    },
    generationOf,
    classGenerationOf,
    targetIdOf,
    inPlace,
    writerOf: (stream) => writers.get(stream.streamName),
    decodeStreamEntry: (entry) =>
      Effect.map(decodeEvent(entry.event), (event) => ({
        event,
        envelope: decodeEnvelope(entry.envelope),
      })),
    decodeEvent,
    encodeEvent,
    encodeCommand: (aggregate, command) => {
      const entry = codecsOf(aggregate).commands.get(command._tag);
      return entry
        ? Effect.sync(() => entry.codec.encode(command))
        : Effect.die(
            new DefinitionError({
              reason: new UnhandledCommand({
                aggregate: aggregate.aggregateName,
                command: command._tag,
              }),
            }),
          );
    },
    decodeRejection: (aggregate, json) =>
      codecsOf(aggregate)
        .rejections.get((json as { _tag: string })._tag)!
        .decode(json),
    decodeReceipt: (aggregate, commandTag, json) => {
      const reply = codecsOf(aggregate).commands.get(commandTag)?.reply;
      return Effect.map(Effect.forEach(json.events, decodeEvent), (events) => ({
        stream: json.stream,
        version: json.version,
        events,
        reply: reply && json.reply !== null ? reply.decode(json.reply) : undefined,
      })) as Effect.Effect<Aggregate.Receipt>;
    },
    decodeState: (aggregate, json) => {
      const codecs = codecsOf(aggregate);
      return codecs.state.decode(json ?? codecs.initial);
    },
    decodeViewState: (view, json) => viewCodec(view).decode(json),
    decodeViewEntry: (view, entry) =>
      Effect.map(decodeEvent(entry.event), (event) => ({
        event,
        state:
          entry.state === null || !view.definition.state
            ? null
            : viewCodec(view).decode(entry.state),
        envelope: decodeEnvelope(entry.envelope),
      })),
  };
};
