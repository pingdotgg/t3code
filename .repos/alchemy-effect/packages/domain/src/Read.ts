import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";

/** How a client reads a View or an aggregate. */
export type Mode = "get" | "watch" | "events" | "list";

/**
 * What `watch` sends: the key's state and the cursor it is valid at, the
 * `seq` of the last event the key had when the state was read (`0` before any).
 */
export interface Snapshot<S> {
  readonly state: S;
  /** Pass as `after` to `events` to receive every later event, once. */
  readonly cursor: number;
}

/**
 * The frame `events` sends once it has sent the key's history: every event up
 * to `cursor` was delivered (or filtered out), and what follows is live. A
 * read that reconnects sends it again after the events it missed.
 */
export const CaughtUp = Schema.TaggedStruct("CaughtUp", {
  /** The `seq` of the last event of the history (`0` for none); resume `events` after it. */
  cursor: Schema.Number,
});
export type CaughtUp = typeof CaughtUp.Type;

/** Is a frame of `events` the {@link CaughtUp} marker? */
export const isCaughtUp = <A extends object>(frame: A | CaughtUp): frame is CaughtUp =>
  "_tag" in frame && frame._tag === "CaughtUp";

/**
 * Is a frame of `events` an event, not the {@link CaughtUp} marker? Drops the
 * marker from a feed: `Stream.filter(Domain.Read.isEvent)`.
 */
export const isEvent = <A extends object>(frame: A | CaughtUp): frame is Exclude<A, CaughtUp> =>
  !isCaughtUp(frame);

/**
 * A client's read, as `validate` sees it: what is being read and how. The
 * client's own filters are not part of it: they only narrow what a permitted
 * read returns, so access never depends on analyzing them.
 */
export interface Request<Ref> {
  readonly mode: Mode;
  /** The key being read: a view key, or an aggregate instance. */
  readonly key: Ref;
}

/**
 * The read contract of a View or aggregate exposed in an Api: the middleware
 * that guards it, the rejections a read may fail with, and `validate`, which
 * judges each read. Like a Command, a View is a security boundary: to show an
 * audience different data, make another View.
 */
export interface Contract<
  Ref,
  St,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
> {
  /**
   * Middleware that guards reads when an Api exposes them, in order. What it
   * provides is what `validate` may read.
   */
  readonly middleware?: Ms;
  /** The rejections a read may fail with; they reach the client typed. */
  readonly rejects?: Rejects;
  /**
   * Judge a read from who is asking (what `middleware` provides), the key and
   * that key's state. Runs on every `get` and `list`, and on every change
   * while a client watches: failing ends the watch with that rejection.
   * Without it, anyone who reaches the Api may read every key.
   */
  readonly validate?: (
    request: Request<Ref>,
    state: St,
  ) => Effect.Effect<void, Aggregate.InstanceOf<Rejects[number]>, Middleware.Provides<Ms>>;
}

/** The read contract a View or aggregate declares, widened. @internal */
export interface AnyContract {
  readonly middleware?: Middleware.List;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly validate?: (request: never, state: never) => Effect.Effect<void, unknown, unknown>;
}
