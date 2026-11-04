import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";

/**
 * The middleware a Command or View declares, applied in order: the first
 * entry runs first (e.g. `[Session, MfaChallenge]` authenticates, then
 * challenges).
 */
export type List = ReadonlyArray<RpcMiddleware.AnyService>;

/** The services a list of middleware provides to what it guards. */
export type Provides<Ms extends List> = Ms[number] extends infer M
  ? M extends RpcMiddleware.AnyService
    ? RpcMiddleware.Provides<M["Identifier"]>
    : never
  : never;

/** The errors a list of middleware can fail a request with. */
export type Errors<Ms extends List> = Ms[number] extends infer M
  ? M extends RpcMiddleware.AnyService
    ? RpcMiddleware.Error<M["Identifier"]>
    : never
  : never;

/** An RPC with a list of middleware applied, in order. */
export type Apply<R extends Rpc.Any, Ms extends List> = Ms extends readonly [
  infer Head extends RpcMiddleware.AnyService,
  ...infer Tail extends List,
]
  ? Apply<Rpc.AddMiddleware<R, Head>, Tail>
  : R;

/** Apply a list of middleware to an RPC, in order. @internal */
export const apply = (rpc: Rpc.Any, middleware: List): Rpc.Any =>
  middleware.reduce<Rpc.Any>(
    (current, service) => (current as Rpc.Rpc<string>).middleware(service),
    rpc,
  );
