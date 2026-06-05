import type * as Types from "effect/Types";

export interface Dependencies<A> {
  /**
   * Contravariant because it's checked as input to a function (E.g. Counter.from(WorkerA))
   *
   * @internal phantom type used to tag the dependencies of a resource
   */
  "~alchemy/dependencies": Types.Contravariant<A>;
}
