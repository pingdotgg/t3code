import type * as Effect from "effect/Effect";

export type Rpc<Shape> = {
  "~alchemy/rpc": Shape;
};

/**
 * Recover the user's RPC `Shape` from any of the forms a caller might pass
 * to {@link toPromiseApi}:
 *
 *   - the Worker class value's type, e.g. `typeof Backend`, which extends
 *     `Effect.Effect<Worker & Rpc<Shape>, …>`
 *   - the unwrapped `Worker & Rpc<Shape>` type
 *   - a bare `Shape` (when the caller types it explicitly)
 */
export declare namespace Rpc {
  export type Shape<W> =
    W extends Effect.Effect<infer R, any, any>
      ? R extends Rpc<infer Shape>
        ? Shape
        : R
      : W extends Rpc<infer Shape>
        ? Shape
        : W;
}
