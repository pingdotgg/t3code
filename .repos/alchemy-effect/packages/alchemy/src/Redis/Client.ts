import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CommandError, UrlMissing } from "./Errors.ts";
import { command, commandPipeline } from "./Protocol.ts";
import type { Arg, Reply } from "./Resp.ts";

/**
 * A Redis URL that resolves from the Function/Service environment at
 * runtime (`REDIS_URL`).
 */
export type Url = Effect.Effect<string, UrlMissing, RuntimeContext>;

export type RuntimeError = CommandError | UrlMissing;

export interface SetOptions {
  readonly ex?: number;
  readonly px?: number;
  readonly exAt?: number;
  readonly pxAt?: number;
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly keepTtl?: boolean;
}

/**
 * Read-only Redis client. Any Redis command is available via {@link Client.send}
 * on the read/write client.
 */
export interface ReadClient {
  get(key: string): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  mget(
    ...keys: string[]
  ): Effect.Effect<Array<string | null>, RuntimeError, RuntimeContext>;
  ping(message?: string): Effect.Effect<string, RuntimeError, RuntimeContext>;
  echo(message: string): Effect.Effect<string, RuntimeError, RuntimeContext>;
  exists(
    ...keys: string[]
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  ttl(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  pttl(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  type(key: string): Effect.Effect<string, RuntimeError, RuntimeContext>;
  hget(
    key: string,
    field: string,
  ): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  hmget(
    key: string,
    ...fields: string[]
  ): Effect.Effect<Array<string | null>, RuntimeError, RuntimeContext>;
  hgetall(
    key: string,
  ): Effect.Effect<Record<string, string>, RuntimeError, RuntimeContext>;
  hexists(
    key: string,
    field: string,
  ): Effect.Effect<boolean, RuntimeError, RuntimeContext>;
  hkeys(key: string): Effect.Effect<string[], RuntimeError, RuntimeContext>;
  hvals(key: string): Effect.Effect<string[], RuntimeError, RuntimeContext>;
  hlen(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  llen(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  lrange(
    key: string,
    start: number,
    stop: number,
  ): Effect.Effect<string[], RuntimeError, RuntimeContext>;
  lindex(
    key: string,
    index: number,
  ): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  scard(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  sismember(
    key: string,
    member: string,
  ): Effect.Effect<boolean, RuntimeError, RuntimeContext>;
  smembers(key: string): Effect.Effect<string[], RuntimeError, RuntimeContext>;
  zscore(
    key: string,
    member: string,
  ): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  zcard(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  zrange(
    key: string,
    start: number,
    stop: number,
  ): Effect.Effect<string[], RuntimeError, RuntimeContext>;
}

/**
 * Write Redis client.
 */
export interface WriteClient {
  set(
    key: string,
    value: string | Uint8Array,
    options?: SetOptions,
  ): Effect.Effect<void, RuntimeError, RuntimeContext>;
  mset(
    values: Record<string, string | Uint8Array>,
  ): Effect.Effect<void, RuntimeError, RuntimeContext>;
  del(...keys: string[]): Effect.Effect<number, RuntimeError, RuntimeContext>;
  unlink(
    ...keys: string[]
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  expire(
    key: string,
    seconds: number,
  ): Effect.Effect<boolean, RuntimeError, RuntimeContext>;
  persist(key: string): Effect.Effect<boolean, RuntimeError, RuntimeContext>;
  incr(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  incrBy(
    key: string,
    amount: number,
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  decr(key: string): Effect.Effect<number, RuntimeError, RuntimeContext>;
  hset(
    key: string,
    field: string | Record<string, string | Uint8Array>,
    value?: string | Uint8Array,
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  hdel(
    key: string,
    ...fields: string[]
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  hincrBy(
    key: string,
    field: string,
    amount: number,
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  lpush(
    key: string,
    ...values: Array<string | Uint8Array>
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  rpush(
    key: string,
    ...values: Array<string | Uint8Array>
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  lpop(key: string): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  rpop(key: string): Effect.Effect<string | null, RuntimeError, RuntimeContext>;
  sadd(
    key: string,
    ...members: Array<string | Uint8Array>
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  srem(
    key: string,
    ...members: Array<string | Uint8Array>
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  zadd(
    key: string,
    score: number,
    member: string | Uint8Array,
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
  zrem(
    key: string,
    ...members: Array<string | Uint8Array>
  ): Effect.Effect<number, RuntimeError, RuntimeContext>;
}

/**
 * Read + write Redis client. {@link send} is the total command surface —
 * every Redis command is an array of bulk strings on the wire.
 */
export interface Client extends ReadClient, WriteClient {
  send(
    name: string,
    args?: readonly Arg[],
  ): Effect.Effect<Reply, RuntimeError, RuntimeContext>;
  pipeline(
    commands: ReadonlyArray<readonly [string, ...Arg[]]>,
  ): Effect.Effect<readonly Reply[], RuntimeError, RuntimeContext>;
}

export interface ReadWriteClient extends Client {}

const asString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
};

const asNullableString = (value: unknown): string | null => {
  if (value == null) return null;
  return asString(value);
};

const asNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const asBoolean = (value: unknown): boolean => asNumber(value) !== 0;

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map(asString);
};

const asNullableStringArray = (value: unknown): Array<string | null> => {
  if (!Array.isArray(value)) return [];
  return value.map(asNullableString);
};

const asHash = (value: unknown): Record<string, string> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = asString(item);
    }
    return out;
  }
  if (!Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < value.length; i += 2) {
    out[asString(value[i])] = asString(value[i + 1]);
  }
  return out;
};

const setArgs = (
  key: string,
  value: string | Uint8Array,
  options?: SetOptions,
): Arg[] => {
  const args: Arg[] = [key, value];
  if (options?.nx) args.push("NX");
  if (options?.xx) args.push("XX");
  if (options?.ex !== undefined) args.push("EX", options.ex);
  if (options?.px !== undefined) args.push("PX", options.px);
  if (options?.exAt !== undefined) args.push("EXAT", options.exAt);
  if (options?.pxAt !== undefined) args.push("PXAT", options.pxAt);
  if (options?.keepTtl) args.push("KEEPTTL");
  return args;
};

/**
 * Read-only client over a runtime Redis URL.
 */
export const makeRead = (url: Url): ReadClient => ({
  get: (key) => command(url, "GET", [key]).pipe(Effect.map(asNullableString)),
  mget: (...keys) =>
    command(url, "MGET", keys).pipe(Effect.map(asNullableStringArray)),
  ping: (message) =>
    command(url, "PING", message === undefined ? [] : [message]).pipe(
      Effect.map(asString),
    ),
  echo: (message) => command(url, "ECHO", [message]).pipe(Effect.map(asString)),
  exists: (...keys) => command(url, "EXISTS", keys).pipe(Effect.map(asNumber)),
  ttl: (key) => command(url, "TTL", [key]).pipe(Effect.map(asNumber)),
  pttl: (key) => command(url, "PTTL", [key]).pipe(Effect.map(asNumber)),
  type: (key) => command(url, "TYPE", [key]).pipe(Effect.map(asString)),
  hget: (key, field) =>
    command(url, "HGET", [key, field]).pipe(Effect.map(asNullableString)),
  hmget: (key, ...fields) =>
    command(url, "HMGET", [key, ...fields]).pipe(
      Effect.map(asNullableStringArray),
    ),
  hgetall: (key) => command(url, "HGETALL", [key]).pipe(Effect.map(asHash)),
  hexists: (key, field) =>
    command(url, "HEXISTS", [key, field]).pipe(Effect.map(asBoolean)),
  hkeys: (key) => command(url, "HKEYS", [key]).pipe(Effect.map(asStringArray)),
  hvals: (key) => command(url, "HVALS", [key]).pipe(Effect.map(asStringArray)),
  hlen: (key) => command(url, "HLEN", [key]).pipe(Effect.map(asNumber)),
  llen: (key) => command(url, "LLEN", [key]).pipe(Effect.map(asNumber)),
  lrange: (key, start, stop) =>
    command(url, "LRANGE", [key, start, stop]).pipe(Effect.map(asStringArray)),
  lindex: (key, index) =>
    command(url, "LINDEX", [key, index]).pipe(Effect.map(asNullableString)),
  scard: (key) => command(url, "SCARD", [key]).pipe(Effect.map(asNumber)),
  sismember: (key, member) =>
    command(url, "SISMEMBER", [key, member]).pipe(Effect.map(asBoolean)),
  smembers: (key) =>
    command(url, "SMEMBERS", [key]).pipe(Effect.map(asStringArray)),
  zscore: (key, member) =>
    command(url, "ZSCORE", [key, member]).pipe(Effect.map(asNullableString)),
  zcard: (key) => command(url, "ZCARD", [key]).pipe(Effect.map(asNumber)),
  zrange: (key, start, stop) =>
    command(url, "ZRANGE", [key, start, stop]).pipe(Effect.map(asStringArray)),
});

/**
 * Write client over a runtime Redis URL.
 */
export const makeWrite = (url: Url): WriteClient => ({
  set: (key, value, options) =>
    command(url, "SET", setArgs(key, value, options)).pipe(Effect.asVoid),
  mset: (values) => {
    const args: Arg[] = [];
    for (const [key, value] of Object.entries(values)) {
      args.push(key, value);
    }
    return command(url, "MSET", args).pipe(Effect.asVoid);
  },
  del: (...keys) => command(url, "DEL", keys).pipe(Effect.map(asNumber)),
  unlink: (...keys) => command(url, "UNLINK", keys).pipe(Effect.map(asNumber)),
  expire: (key, seconds) =>
    command(url, "EXPIRE", [key, seconds]).pipe(Effect.map(asBoolean)),
  persist: (key) => command(url, "PERSIST", [key]).pipe(Effect.map(asBoolean)),
  incr: (key) => command(url, "INCR", [key]).pipe(Effect.map(asNumber)),
  incrBy: (key, amount) =>
    command(url, "INCRBY", [key, amount]).pipe(Effect.map(asNumber)),
  decr: (key) => command(url, "DECR", [key]).pipe(Effect.map(asNumber)),
  hset: (key, field, value) => {
    const args: Arg[] = [key];
    if (typeof field === "string") {
      args.push(field, value ?? "");
    } else {
      for (const [name, item] of Object.entries(field)) {
        args.push(name, item);
      }
    }
    return command(url, "HSET", args).pipe(Effect.map(asNumber));
  },
  hdel: (key, ...fields) =>
    command(url, "HDEL", [key, ...fields]).pipe(Effect.map(asNumber)),
  hincrBy: (key, field, amount) =>
    command(url, "HINCRBY", [key, field, amount]).pipe(Effect.map(asNumber)),
  lpush: (key, ...values) =>
    command(url, "LPUSH", [key, ...values]).pipe(Effect.map(asNumber)),
  rpush: (key, ...values) =>
    command(url, "RPUSH", [key, ...values]).pipe(Effect.map(asNumber)),
  lpop: (key) => command(url, "LPOP", [key]).pipe(Effect.map(asNullableString)),
  rpop: (key) => command(url, "RPOP", [key]).pipe(Effect.map(asNullableString)),
  sadd: (key, ...members) =>
    command(url, "SADD", [key, ...members]).pipe(Effect.map(asNumber)),
  srem: (key, ...members) =>
    command(url, "SREM", [key, ...members]).pipe(Effect.map(asNumber)),
  zadd: (key, score, member) =>
    command(url, "ZADD", [key, score, member]).pipe(Effect.map(asNumber)),
  zrem: (key, ...members) =>
    command(url, "ZREM", [key, ...members]).pipe(Effect.map(asNumber)),
});

/**
 * Full Redis client over a runtime Redis URL.
 *
 * Fly and Railway `*RedisHttp` layers pass this (or {@link makeRead} /
 * {@link makeWrite}) as `makeClient`. Tests can also drive RESP
 * directly via `command` / `run` / `connect`.
 *
 * ```typescript
 * import * as Redis from "alchemy/Redis";
 *
 * const cache = Redis.make(url);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * const echoed = yield* cache.send("ECHO", ["hi"]);
 * ```
 */
export const make = (url: Url): Client => ({
  ...makeRead(url),
  ...makeWrite(url),
  send: (name, args = []) => command(url, name, args),
  pipeline: (commands) => commandPipeline(url, commands),
});

/**
 * Read + write client over a runtime Redis URL. Alias of {@link make}.
 */
export const makeReadWrite = (url: Url): ReadWriteClient => make(url);
