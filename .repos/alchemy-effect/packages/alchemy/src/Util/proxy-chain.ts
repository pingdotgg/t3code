import * as Effect from "effect/Effect";

type Op =
  | { kind: "get"; prop: PropertyKey }
  | { kind: "call"; args: unknown[] };

/**
 * Replay an op chain against a real value. `get` reads a property,
 * `call` invokes — bound to the previous receiver so `this` resolves
 * to the object the method was read from (drizzle's `select()` etc.
 * read `this._.session`, so dropping `this` would throw).
 */
const replay = (root: unknown, ops: ReadonlyArray<Op>): unknown => {
  let cur: any = root;
  let receiver: any = root;
  for (const op of ops) {
    if (op.kind === "get") {
      receiver = cur;
      cur = cur[op.prop];
    } else {
      cur = cur.apply(receiver, op.args);
      receiver = cur;
    }
  }
  return cur;
};

/**
 * Wrap a cached `Effect<T>` in a chainable Proxy so callers can use the
 * returned value as if it were `T` itself — every property read and call
 * records a step, and the chain is replayed against the resolved value
 * when it's finally yielded as an Effect.
 *
 * Compare:
 *
 * ```typescript
 * // Without proxyChain — caller has to yield the cached Effect first:
 * const conn = yield* makeConnection();      // Effect<Db>
 * fetch: Effect.gen(function* () {
 *   const db = yield* conn;
 *   const rows = yield* db.select().from(users);
 * });
 *
 * // With proxyChain — caller treats the return as the value directly:
 * const db = proxyChain(yield* Effect.cached(makeDb));   // T
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The chain ends when the proxy is yielded as an Effect — the resolved
 * value at that point must be a `Yieldable` (an Effect, drizzle query
 * builder, etc). Anything before that is recorded as ops.
 */
export const proxyChain = <T>(cached: Effect.Effect<T, any, any>): T =>
  chain(cached) as T;

const chain = (
  cached: Effect.Effect<unknown, any, any>,
  ops: ReadonlyArray<Op> = [],
): unknown =>
  new Proxy(function () {} as any, {
    get(_, prop) {
      if (prop === Symbol.iterator) {
        // `yield* proxy` — produce the resolved Effect's iterator.
        return function () {
          const eff = Effect.flatMap(
            cached,
            (root) =>
              replay(root, ops) as Effect.Effect<unknown, unknown, unknown>,
          );
          return (eff as any)[Symbol.iterator]();
        };
      }
      return chain(cached, [...ops, { kind: "get", prop }]);
    },
    apply(_, __, args) {
      return chain(cached, [...ops, { kind: "call", args }]);
    },
  });
