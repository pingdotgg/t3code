import type { Delivery } from "./Platform.ts";

/**
 * The cursors that route a source instance's events (an aggregate's events,
 * or a view key's entries) to each view and projection. A consumer whose
 * cursor is behind the instance's version is lagging: live routing skips it,
 * and `Backfill` hands it the history instead. Policies are never caught up:
 * they act on new events only.
 *
 * @internal
 */

/** The last `seq` a source instance routed to each consumer, by {@link targetId}. */
export type Routed = Readonly<Record<string, number>>;

/**
 * A consumer's id in {@link Routed}: `view:Name` or `projection:Name`, with
 * `#<generation>` once it has been rebuilt, or `@<generation>` once it has
 * been rebuilt in place (in the storage it had). A rebuilt consumer is a new
 * one to its sources, so they replay their history to it.
 */
export const targetId = (target: {
  readonly kind: string;
  readonly name: string;
  readonly generation?: number;
  readonly inPlace?: boolean;
}): string =>
  `${target.kind}:${target.name}${target.generation ? `${target.inPlace ? "@" : "#"}${target.generation}` : ""}`;

/**
 * Route a commit's deliveries: drop those to lagging consumers (they receive
 * the events by replay), and advance the cursors of the live ones from
 * `before` to `after`. An instance with no cursors yet predates catch-up; its
 * consumers are taken as caught up.
 */
export const routeLive = (
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  before: number,
  after: number,
  deliveries: ReadonlyArray<Delivery>,
): { readonly deliveries: ReadonlyArray<Delivery>; readonly routed: Routed } => {
  const base: Routed = routed ?? Object.fromEntries(targets.map((target) => [target, before]));
  const live = (target: string) => (base[target] ?? 0) === before;
  const next: Record<string, number> = { ...base };
  for (const target of targets) if (live(target)) next[target] = after;
  return {
    deliveries: deliveries.filter(
      (delivery) => delivery.target.kind === "policy" || live(targetId(delivery.target)),
    ),
    routed: next,
  };
};

/** What a replay needs: stored rows, in order. */
export interface ReplayInput<Row> {
  /** The instance: an aggregate id, or a view key. */
  readonly id: string;
  readonly routed: Routed;
  readonly rows: ReadonlyArray<Row>;
}

/** What a replay produced. */
export interface ReplayResult {
  /** Deliveries to lagging consumers, marked `history`. */
  readonly deliveries: ReadonlyArray<Delivery>;
  readonly routed: Routed;
}
