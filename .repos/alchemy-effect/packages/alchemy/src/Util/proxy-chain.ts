/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Effect from "effect/Effect";

type Op =
  | { kind: "get"; prop: PropertyKey }
  | { kind: "call"; args: unknown[] };

interface ChainState {
  readonly cached: Effect.Effect<unknown, any, any>;
  readonly ops: ReadonlyArray<Op>;
}

/**
 * Every proxy produced by {@link chain} is registered here so that a chain
 * passed as an *argument* to another chain over the same `cached` effect
 * (e.g. `` sql`... ${sql.insert(row)}` `` — the nested `sql.insert(row)` is
 * itself a proxy) can be recognized and replayed against the same resolved
 * root instead of being handed to the real client as an opaque proxy.
 */
const chainStates = new WeakMap<object, ChainState>();

/**
 * Replay an op chain against a real value. `get` reads a property,
 * `call` invokes — bound to the previous receiver so `this` resolves
 * to the object the method was read from (drizzle's `select()` etc.
 * read `this._.session`, so dropping `this` would throw).
 */
const replay = (
  root: unknown,
  ops: ReadonlyArray<Op>,
  cached: Effect.Effect<unknown, any, any>,
): unknown => {
  let cur: any = root;
  let receiver: any = root;
  for (const op of ops) {
    if (op.kind === "get") {
      receiver = cur;
      cur = cur[op.prop];
    } else {
      cur = cur.apply(receiver, replayArgs(root, op.args, cached));
      receiver = cur;
    }
  }
  return cur;
};

/**
 * Resolve nested chain proxies inside a call's arguments. Only proxies over
 * the *same* `cached` effect can be replayed synchronously (the root is
 * already resolved); proxies over a different effect pass through untouched.
 * Returns the original array when nothing needed resolving, so identity-
 * sensitive values (e.g. a `TemplateStringsArray` with its `raw` property)
 * are preserved.
 */
const replayArgs = (
  root: unknown,
  args: ReadonlyArray<unknown>,
  cached: Effect.Effect<unknown, any, any>,
): ReadonlyArray<unknown> => {
  let out: unknown[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const resolved = replayArg(root, args[i], cached);
    if (resolved !== args[i]) {
      out ??= [...args];
      out[i] = resolved;
    }
  }
  return out ?? args;
};

const replayArg = (
  root: unknown,
  arg: unknown,
  cached: Effect.Effect<unknown, any, any>,
): unknown => {
  if (arg === null || (typeof arg !== "object" && typeof arg !== "function")) {
    return arg;
  }
  const state = chainStates.get(arg);
  if (state?.cached === cached) {
    return replay(root, state.ops, cached);
  }
  // Fragments may arrive wrapped in arrays (e.g. `sql.and([a, b])`).
  if (Array.isArray(arg)) {
    return replayArgs(root, arg, cached);
  }
  return arg;
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
 *
 * A chain passed as an *argument* to another chain over the same effect —
 * e.g. `` sql`INSERT INTO users ${sql.insert(row)}` ``, where `sql.insert(row)`
 * is itself a deferred proxy — is replayed against the same resolved root
 * before the outer call runs, so synchronous fragment helpers compose.
 */
export const proxyChain = <T>(cached: Effect.Effect<T, any, any>): T =>
  chain(cached) as T;

const chain = (
  cached: Effect.Effect<unknown, any, any>,
  ops: ReadonlyArray<Op> = [],
): unknown => {
  const effect = Effect.flatMap(
    cached,
    (root) =>
      replay(root, ops, cached) as Effect.Effect<unknown, unknown, unknown>,
  );
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (Reflect.has(effect, prop)) {
        return Reflect.get(effect, prop);
      }
      return chain(cached, [...ops, { kind: "get", prop }]);
    },
    has(target, prop) {
      return Reflect.has(target, prop) || Reflect.has(effect, prop);
    },
    apply(_, __, args) {
      return chain(cached, [...ops, { kind: "call", args }]);
    },
  });
  chainStates.set(proxy, { cached, ops });
  return proxy;
};
