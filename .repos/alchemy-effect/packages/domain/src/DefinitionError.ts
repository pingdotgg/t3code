import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

// ---------------------------------------------------------------- definitions

/** Two different event classes share a tag. */
export class DuplicateEventTag extends Data.TaggedError("DuplicateEventTag")<{
  readonly tag: string;
}> {
  override get message() {
    return `Two different events are tagged '${this.tag}'`;
  }
}

/** Two aggregates, views or streams share a name. */
export class DuplicateName extends Data.TaggedError("DuplicateName")<{
  readonly entity: string;
}> {
  override get message() {
    return `Two entities are named '${this.entity}'`;
  }
}

/** The Domain lists the same aggregate, policy or projection twice. */
export class DuplicateDefinition extends Data.TaggedError("DuplicateDefinition")<{
  readonly kind: "aggregate" | "policy" | "projection";
  readonly entity: string;
}> {
  override get message() {
    return `Duplicate ${this.kind} '${this.entity}'`;
  }
}

/** An `initial` state its state schema cannot encode. */
export class InvalidInitial extends Data.TaggedError("InvalidInitial")<{
  readonly owner: string;
  readonly cause: unknown;
}> {
  override get message() {
    const detail = Predicate.hasProperty(this.cause, "message")
      ? String(this.cause.message)
      : String(this.cause);
    return `${this.owner}.initial does not match its state schema: ${detail}`;
  }
}

/** A view declares state but no `initial`. */
export class MissingInitial extends Data.TaggedError("MissingInitial")<{
  readonly view: string;
}> {
  override get message() {
    return `${this.view} declares state without initial`;
  }
}

/** A view, policy or projection consumes something the Domain does not list. */
export class UnknownSource extends Data.TaggedError("UnknownSource")<{
  readonly consumer: string;
  readonly source: string;
}> {
  override get message() {
    return `${this.consumer} consumes ${this.source}, which is not in the Domain`;
  }
}

/** A view consumes its own output through other views. */
export class ConsumesItself extends Data.TaggedError("ConsumesItself")<{
  readonly view: string;
}> {
  override get message() {
    return `${this.view} consumes itself through other views`;
  }
}

/** A consumer keyed differently from its source names no `keyOf` for an event. */
export class MissingKeyOf extends Data.TaggedError("MissingKeyOf")<{
  readonly consumer: string;
  readonly event: string;
  readonly source: string;
  /** The aggregate the consumer is keyed by, or undefined for a key schema. */
  readonly keyedBy?: string;
}> {
  override get message() {
    return `${this.consumer} consumes '${this.event}' from ${this.source}, which is not keyed by ${this.keyedBy ?? "its key schema"}: add keyOf.${this.event}`;
  }
}

/** A routed handler names a route that `keyOf` does not produce. */
export class UnmatchedRoute extends Data.TaggedError("UnmatchedRoute")<{
  readonly view: string;
  readonly handler: string;
  readonly source: string;
  readonly route: string;
}> {
  override get message() {
    return `${this.view}.${this.handler}.${this.source}.${this.route} has no matching route in keyOf.${this.source}`;
  }
}

/** A consumer subscribes to an event none of its sources emits. */
export class NoEmitter extends Data.TaggedError("NoEmitter")<{
  readonly consumer: string;
  readonly sources: ReadonlyArray<string>;
  readonly event: string;
}> {
  override get message() {
    return `${this.consumer}: none of ${this.sources.join(", ")} emits '${this.event}'`;
  }
}

/** A projection writes a stream the Domain does not list. */
export class UnknownStream extends Data.TaggedError("UnknownStream")<{
  readonly writer: string;
  readonly stream: string;
}> {
  override get message() {
    return `${this.writer} writes ${this.stream}, which is not in the Domain`;
  }
}

/** Two projections write the same stream. */
export class TwoWriters extends Data.TaggedError("TwoWriters")<{
  readonly stream: string;
  readonly first: string;
  readonly second: string;
}> {
  override get message() {
    return `${this.stream} has two writers, ${this.first} and ${this.second}: a stream key has exactly one`;
  }
}

/** A projection writes a stream keyed differently from itself. */
export class WriterKeyMismatch extends Data.TaggedError("WriterKeyMismatch")<{
  readonly writer: string;
  readonly key: string;
  readonly stream: string;
  readonly streamKey: string;
}> {
  override get message() {
    return `${this.writer} is keyed by ${this.key}, so it cannot write ${this.stream}, keyed by ${this.streamKey}`;
  }
}

// ---------------------------------------------------------------- runtime

/** An aggregate receives a command it does not list. */
export class UnhandledCommand extends Data.TaggedError("UnhandledCommand")<{
  readonly aggregate: string;
  readonly command: string;
}> {
  override get message() {
    return `${this.aggregate} does not handle '${this.command}'`;
  }
}

/** An Api exposes a command no aggregate in the Domain handles. */
export class UnroutedCommand extends Data.TaggedError("UnroutedCommand")<{
  readonly command: string;
}> {
  override get message() {
    return `${this.command} is served, but no hosted aggregate handles it`;
  }
}

/** `decide` returns an event or rejection its command does not declare. */
export class UndeclaredDecision extends Data.TaggedError("UndeclaredDecision")<{
  readonly aggregate: string;
  readonly command: string;
  readonly returned: string;
  readonly list: "events" | "rejects";
}> {
  override get message() {
    return `${this.aggregate}.decide.${this.command} returned '${this.returned}', which ${this.command} does not declare in ${this.list}`;
  }
}

/** An aggregate commits an event it does not declare. */
export class UndeclaredEvent extends Data.TaggedError("UndeclaredEvent")<{
  readonly aggregate: string;
  readonly event: string;
}> {
  override get message() {
    return `${this.aggregate} does not declare event '${this.event}'`;
  }
}

/** A view's `emit` returns an event its `events` do not list. */
export class UndeclaredEmit extends Data.TaggedError("UndeclaredEmit")<{
  readonly view: string;
  readonly event: string;
}> {
  override get message() {
    return `${this.view} emitted '${this.event}', which it does not declare in events`;
  }
}

/** A stored event's tag matches no event in the Domain. */
export class UnknownEvent extends Data.TaggedError("UnknownEvent")<{
  readonly event: string;
}> {
  override get message() {
    return `Unknown event '${this.event}'`;
  }
}

/** A request carries a context service nothing registered. */
export class UnknownRequestContext extends Data.TaggedError("UnknownRequestContext")<{
  readonly key: string;
}> {
  override get message() {
    return `Unknown request context '${this.key}'`;
  }
}

/** An Api exposes an aggregate that declares no `read` contract. */
export class Unreadable extends Data.TaggedError("Unreadable")<{
  readonly aggregate: string;
}> {
  override get message() {
    return `${this.aggregate} has no \`read\` contract, so an Api cannot expose it`;
  }
}

/** An external system declares an operation named after a static of its class. */
export class ReservedOperation extends Data.TaggedError("ReservedOperation")<{
  readonly system: string;
  readonly operation: string;
}> {
  override get message() {
    return `ExternalSystem '${this.system}' cannot declare an operation named '${this.operation}'`;
  }
}

/** The Domain has sagas, but the platform runs no workflows. */
export class MissingWorkflowEngine extends Data.TaggedError("MissingWorkflowEngine")<{
  readonly sagas: ReadonlyArray<string>;
}> {
  override get message() {
    return `${this.sagas.join(", ")} need a platform that runs workflows`;
  }
}

/** Something other than the stream's writer, handling its input, appends to it. */
export class ForeignAppend extends Data.TaggedError("ForeignAppend")<{
  readonly stream: string;
}> {
  override get message() {
    return `Only the projection that lists ${this.stream} in \`writes\` may append to it, with the input it is handling`;
  }
}

/** An Api names something its model does not hold. */
export class NotInModel extends Data.TaggedError("NotInModel")<{
  readonly entity: string;
  readonly model: string;
}> {
  override get message() {
    return `${this.entity} is not part of the ${this.model} model`;
  }
}

/** An Api call makes a tool name longer than model providers accept. */
export class ToolNameTooLong extends Data.TaggedError("ToolNameTooLong")<{
  readonly tool: string;
  readonly max: number;
}> {
  override get message() {
    return `The tool name ${this.tool} is longer than ${this.max} characters`;
  }
}

/** Two calls of an Api make the same tool name. */
export class DuplicateTool extends Data.TaggedError("DuplicateTool")<{
  readonly api: string;
  readonly tool: string;
}> {
  override get message() {
    return `Two calls of ${this.api} make the tool ${this.tool}`;
  }
}

/** A payload field would be a flag the CLI reserves. */
export class ReservedFlag extends Data.TaggedError("ReservedFlag")<{
  readonly call: string;
  readonly field: string;
  readonly flag: string;
}> {
  override get message() {
    return `${this.call}: field \`${this.field}\` would be the flag --${this.flag}, which the CLI reserves`;
  }
}

/** Two payload fields would be the same CLI flag. */
export class DuplicateFlag extends Data.TaggedError("DuplicateFlag")<{
  readonly call: string;
  readonly field: string;
  readonly flag: string;
  readonly taken: string;
}> {
  override get message() {
    return `${this.call}: field \`${this.field}\` would be the flag --${this.flag}, as is field \`${this.taken}\``;
  }
}

/** Two calls of an Api would be the same CLI command. */
export class DuplicateCommand extends Data.TaggedError("DuplicateCommand")<{
  readonly api: string;
  readonly first: string;
  readonly second: string;
  readonly command: string;
}> {
  override get message() {
    return `${this.api}: \`${this.first}\` and \`${this.second}\` are both the command ${this.command}`;
  }
}

/** An Api's HttpApi group is served from an HttpApi that does not hold it. */
export class MissingGroup extends Data.TaggedError("MissingGroup")<{
  readonly httpApi: string;
  readonly group: string;
}> {
  override get message() {
    return `${this.httpApi} does not hold the ${this.group} group: add it first`;
  }
}

/** A consumer receives a delivery for a newer generation than the code it runs. */
export class NewerGeneration extends Data.TaggedError("NewerGeneration")<{
  readonly consumer: string;
  readonly sent: number;
  readonly runs: number;
}> {
  override get message() {
    return `${this.consumer} received generation ${this.sent} but runs ${this.runs}: this instance runs older code`;
  }
}

/** Two different models with the same name are hosted on one platform, so they would share storage. */
export class ModelHostedTwice extends Data.TaggedError("ModelHostedTwice")<{
  readonly model: string;
}> {
  override get message() {
    return `Model ${this.model} is hosted twice on one platform: give each model its own name`;
  }
}

/** A view set to fill lazily isn't keyed by its one source, so a key can't find its own history. */
export class LazyViewNeedsOneSource extends Data.TaggedError("LazyViewNeedsOneSource")<{
  readonly view: string;
}> {
  override get message() {
    return `${this.view} can't be lazy: a lazy view must read one aggregate and be keyed by it, so each key reads its own instance's history. Leave it out of \`lazy\`, and the deploy fills it.`;
  }
}

/** Every reason a {@link DefinitionError} has. */
export type Reason =
  | DuplicateEventTag
  | DuplicateName
  | DuplicateDefinition
  | InvalidInitial
  | MissingInitial
  | UnknownSource
  | ConsumesItself
  | MissingKeyOf
  | UnmatchedRoute
  | NoEmitter
  | UnknownStream
  | TwoWriters
  | WriterKeyMismatch
  | UnhandledCommand
  | UnroutedCommand
  | UndeclaredDecision
  | UndeclaredEvent
  | UndeclaredEmit
  | UnknownEvent
  | UnknownRequestContext
  | Unreadable
  | ReservedOperation
  | MissingWorkflowEngine
  | ForeignAppend
  | NotInModel
  | ToolNameTooLong
  | DuplicateTool
  | ReservedFlag
  | DuplicateFlag
  | DuplicateCommand
  | MissingGroup
  | NewerGeneration
  | ModelHostedTwice
  | LazyViewNeedsOneSource;

/**
 * A domain definition error, found while the kernel is built or when a
 * handler returns something its declaration does not allow. Its `reason`
 * says which problem it is: match it with `Effect.catchReason`.
 */
export class DefinitionError extends Data.TaggedError("DefinitionError")<{
  readonly reason: Reason;
}> {
  override get message() {
    return this.reason.message;
  }
}
