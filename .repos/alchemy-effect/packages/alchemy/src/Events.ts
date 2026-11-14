import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import * as Queue from "effect/Queue";
import { CurrentLogAnnotations, MinimumLogLevel } from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LogAnnotation } from "./Util/LogAnnotation.ts";

// The engine's typed events: one Schema union discriminated by `type`
// (`domain.subject.verb`), emitted as log records through Effect's logger.
// `onEvent` observes them; every logger (the run log, JSON output) sees them
// too. Time, trace and resource live on the log record, not the event.

const ProviderMode = Schema.Literals(["local", "live"]);

export const ApplyStatus = Schema.Literals([
  "attaching",
  "post-attach",
  "pending",
  "pre-creating",
  "creating",
  "creating replacement",
  "created",
  "updating",
  "updated",
  "adopting",
  "adopted",
  "deleting",
  "deleted",
  "orphaning",
  "orphaned",
  "replacing",
  "replaced",
  // Action lifecycle (see `Action`)
  "running",
  "ran",
  "skipped",
  "fail",
]);
export type ApplyStatus = typeof ApplyStatus.Type;

/**
 * How append-only renderers surface a note (the interactive view treats every
 * kind the same): `"status"` is transient spinner text that plain mode folds
 * into the settle line's suffix, `"output"` is verbatim tool output streamed
 * line by line, and absent is a one-shot informational note.
 */
export const NoteKind = Schema.Literals(["status", "output"]);
export type NoteKind = typeof NoteKind.Type;

/** One binding row on a planned resource. */
export const PlannedBinding = Schema.Struct({
  sid: Schema.String,
  action: Schema.Literals(["create", "update", "delete", "noop"]),
});
export type PlannedBinding = typeof PlannedBinding.Type;

/** Serializable view of one resource row in a plan. */
export const PlannedResource = Schema.Struct({
  fqn: Schema.String,
  logicalId: Schema.String,
  resourceType: Schema.String,
  /** The action the plan decided for this resource. */
  action: Schema.Literals(["create", "update", "adopted", "replace", "delete", "orphaned", "noop"]),
  /** Binding rows the node carries; empty when the resource has none. */
  bindings: Schema.Array(PlannedBinding),
  /** Mode the node's provider resolved for; absent for mode-agnostic providers. */
  providerMode: Schema.optionalKey(ProviderMode),
  /** On mode-switch replacements: the mode the old generation was created with. */
  fromProviderMode: Schema.optionalKey(ProviderMode),
});
export type PlannedResource = typeof PlannedResource.Type;

/** Serializable view of one stack-action row in a plan. */
export const PlannedAction = Schema.Struct({
  fqn: Schema.String,
  logicalId: Schema.String,
  actionType: Schema.String,
  action: Schema.Literals(["run", "delete", "noop"]),
});
export type PlannedAction = typeof PlannedAction.Type;

/** Phases a stack plan moves through before it is ready. */
export const PlanningPhase = Schema.Literals([
  "importing-module",
  "resolving-services",
  "loading-state",
  "computing-plan",
  "plan-ready",
]);
export type PlanningPhase = typeof PlanningPhase.Type;

/** A note a provider attached to a resource while applying it. */
export const ResourceAnnotated = Schema.Struct({
  type: Schema.Literal("apply.resource.note"),
  /** Fully-qualified resource or action name used to target its plan row. */
  fqn: Schema.String,
  id: Schema.String,
  message: Schema.String,
  kind: Schema.optionalKey(NoteKind),
});
export type ResourceAnnotated = typeof ResourceAnnotated.Type;

/** A resource or action moved to a new apply status. */
export const ResourceStatusChanged = Schema.Struct({
  type: Schema.Literal("apply.resource.status"),
  /** Fully-qualified resource or action name used to target its plan row. */
  fqn: Schema.String,
  /** Logical id, e.g. `"api"`. */
  id: Schema.String,
  /** e.g. `"Cloudflare.Worker"`. */
  resourceType: Schema.String,
  status: ApplyStatus,
  message: Schema.optionalKey(Schema.String),
  /**
   * The mode this node's provider was resolved for; absent for mode-agnostic
   * providers and for actions.
   */
  providerMode: Schema.optionalKey(ProviderMode),
  /**
   * Set only on mode-switch replacements (local ⇄ live): the mode the OLD
   * generation was created with. Always differs from `providerMode`.
   */
  fromProviderMode: Schema.optionalKey(ProviderMode),
});
export type ResourceStatusChanged = typeof ResourceStatusChanged.Type;

export type ApplyEvent = ResourceAnnotated | ResourceStatusChanged;

/** Every event the engine and the Alchemist operations emit. */
export const Event = Schema.Union([
  /**
   * The planning pipeline crossed a work boundary. Carries no display text —
   * wording is the renderer's job.
   */
  Schema.Struct({ type: Schema.Literal("plan.phase"), phase: PlanningPhase }),
  /**
   * A resource's diff began. Diffs run concurrently and may read the cloud,
   * so pairing starts with completions lets a renderer show what is in flight.
   */
  Schema.Struct({
    type: Schema.Literal("plan.resource.started"),
    fqn: Schema.String,
    logicalId: Schema.String,
    resourceType: Schema.String,
    total: Schema.Number,
  }),
  /** The planner finished diffing one resource; `completed` of `total` so far. */
  Schema.Struct({
    type: Schema.Literal("plan.resource.completed"),
    ...PlannedResource.fields,
    completed: Schema.Number,
    total: Schema.Number,
  }),
  /** The planner decided one stack action. */
  Schema.Struct({
    type: Schema.Literal("plan.action.completed"),
    ...PlannedAction.fields,
    completed: Schema.Number,
    total: Schema.Number,
  }),
  ResourceAnnotated,
  ResourceStatusChanged,
  /**
   * Around a state-store bootstrap or upgrade (e.g. deploying the Cloudflare
   * state-store worker on first use); `store` names it.
   */
  Schema.Struct({ type: Schema.Literal("state.bootstrap.started"), store: Schema.String }),
  Schema.Struct({ type: Schema.Literal("state.bootstrap.completed"), store: Schema.String }),
  Schema.Struct({ type: Schema.Literal("provider.configure.started"), provider: Schema.String }),
  Schema.Struct({ type: Schema.Literal("provider.configure.completed"), provider: Schema.String }),
  Schema.Struct({ type: Schema.Literal("provider.refresh.started"), provider: Schema.String }),
  Schema.Struct({ type: Schema.Literal("provider.refresh.completed"), provider: Schema.String }),
  Schema.Struct({ type: Schema.Literal("nuke.scan.started"), total: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("nuke.scan.provider.started"), provider: Schema.String }),
  /** One provider's listing settled: 0 resources and an `error` when it failed. */
  Schema.Struct({
    type: Schema.Literal("nuke.scan.provider.completed"),
    provider: Schema.String,
    resources: Schema.Number,
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("nuke.pass.started"), pass: Schema.Number }),
  /** `resource` is the deleted object's display name. */
  Schema.Struct({
    type: Schema.Literal("nuke.resource.deleted"),
    provider: Schema.String,
    resource: Schema.String,
  }),
  /** A deletion attempt failed; the run keeps going. */
  Schema.Struct({
    type: Schema.Literal("nuke.resource.failed"),
    provider: Schema.String,
    resource: Schema.String,
    message: Schema.String,
  }),
]);
export type Event = typeof Event.Type;

const knownEventTypes: ReadonlySet<string> = new Set(
  Event.members.map((member) => member.fields.type.literal),
);

/** Whether `type` names an event this version knows. */
export const isKnownEventType = (type: string): boolean => knownEventTypes.has(type);

/**
 * The level an event is logged at: failures stand out, so a reader filtering
 * the run log by level (`select(.level == "error")`) finds them.
 */
const levelOf = (event: Event): LogLevel.Severity =>
  event.type === "apply.resource.status" && event.status === "fail"
    ? "Error"
    : event.type === "nuke.resource.failed" ||
        (event.type === "nuke.scan.provider.completed" && event.error !== undefined)
      ? "Warn"
      : "Info";

/**
 * Emit an event. Events are log records (annotated as events, at Info unless
 * they report a failure), so every logger sees them: the run log and
 * `--log-format json` carry them and renderers subscribe with
 * {@link onEvent}. The pretty console sink skips them, and telemetry does not
 * export them.
 */
export const emit = (event: Event): Effect.Effect<void> =>
  Effect.logWithLevel(levelOf(event))(event).pipe(
    Effect.annotateLogs(LogAnnotation.event, true),
    // Events always reach the loggers; each sink applies its own floor
    // (the console's `--log-level`), so a quieter minimum never starves a
    // renderer or the run log of progress.
    Effect.provideService(MinimumLogLevel, "Trace"),
  );

/** The event a log record carries, if it is one. */
const eventOf = (options: Logger.Options<unknown>): Event | undefined => {
  if (options.fiber.getRef(CurrentLogAnnotations)[LogAnnotation.event] !== true) return undefined;
  const message = Array.isArray(options.message) ? options.message[0] : options.message;
  // SAFETY: only `emit` sets the event annotation, and it logs an Event.
  return message as Event;
};

/**
 * {@link emit} bound to the current loggers, for reporting from contexts
 * that may no longer carry them (provider callbacks, cached operations), so
 * the events still reach the caller's sinks and `onEvent` subscribers.
 */
export const captureEmit: Effect.Effect<(event: Event) => Effect.Effect<void>> = Effect.map(
  Logger.CurrentLoggers,
  (loggers) => (event) => emit(event).pipe(Effect.provideService(Logger.CurrentLoggers, loggers)),
);

/**
 * Observe the events `effect` emits. The handler runs (with the caller's
 * services) for each event in order, alongside the loggers already
 * installed, and every handler has finished before this returns.
 */
export const onEvent =
  <R = never>(handler: (event: Event) => Effect.Effect<void, never, R>) =>
  <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R | R2> =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Event, Cause.Done>();
      const consumer = yield* Stream.fromQueue(queue).pipe(
        Stream.runForEach(handler),
        Effect.forkDetach,
      );
      // Every event emitted so far is handled before returning.
      const drain = Queue.end(queue).pipe(Effect.andThen(Fiber.join(consumer)));
      return yield* effect.pipe(
        Effect.provide(
          Logger.layer(
            [
              Logger.make<unknown, void>((options) => {
                const event = eventOf(options);
                if (event !== undefined) Queue.offerUnsafe(queue, event);
              }),
            ],
            { mergeWithExisting: true },
          ),
        ),
        // `effect` stays on this fiber, so fibers it forks live as long as
        // the caller's. A handler that died fails the operation here.
        Effect.tap(() => drain),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.ignore(drain),
        ),
        // Cancelled: stop handling instead of waiting on a blocked handler.
        Effect.onInterrupt(() => Fiber.interrupt(consumer)),
        // Whatever the exit, later emits are rejected instead of piling up
        // in a queue nothing reads.
        Effect.ensuring(Queue.shutdown(queue)),
      );
    });
