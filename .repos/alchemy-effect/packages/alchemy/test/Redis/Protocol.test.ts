import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Redis from "@/Redis/index.ts";
import {
  encodeError,
  encodeInteger,
  encodeNull,
  encodeReply,
  encodeSimpleString,
  Parser,
} from "@/Redis/Resp.ts";

type Session = { parser: Parser; authed: boolean };

type Stored =
  | { readonly t: "string"; v: string }
  | { readonly t: "hash"; v: Map<string, string> }
  | { readonly t: "list"; v: string[] }
  | { readonly t: "set"; v: Set<string> }
  | { readonly t: "zset"; v: Map<string, number> };

const asString = (value: unknown): string => String(value ?? "");

const wrongType = () =>
  encodeError(
    "WRONGTYPE Operation against a key holding the wrong kind of value",
  );

const execute = (
  store: Map<string, Stored>,
  name: string,
  args: string[],
): Uint8Array => {
  const cmd = name.toUpperCase();
  if (cmd === "PING") {
    return args[0] === undefined
      ? encodeSimpleString("PONG")
      : encodeReply(args[0]);
  }
  if (cmd === "ECHO") return encodeReply(args[0] ?? "");
  if (cmd === "AUTH") return encodeSimpleString("OK");
  if (cmd === "SELECT") return encodeSimpleString("OK");
  if (cmd === "GET") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeNull();
    if (row.t !== "string") return wrongType();
    return encodeReply(row.v);
  }
  if (cmd === "SET") {
    store.set(args[0] ?? "", { t: "string", v: args[1] ?? "" });
    return encodeSimpleString("OK");
  }
  if (cmd === "DEL") {
    let n = 0;
    for (const key of args) {
      if (store.delete(key)) n++;
    }
    return encodeInteger(n);
  }
  if (cmd === "EXISTS") {
    return encodeInteger(args.filter((key) => store.has(key)).length);
  }
  if (cmd === "INCR" || cmd === "INCRBY" || cmd === "DECR") {
    const key = args[0] ?? "";
    const delta =
      cmd === "DECR" ? -1 : cmd === "INCR" ? 1 : Number(args[1] ?? 1);
    const row = store.get(key);
    if (row !== undefined && row.t !== "string") return wrongType();
    const next = Number(row?.t === "string" ? row.v : 0) + delta;
    store.set(key, { t: "string", v: String(next) });
    return encodeInteger(next);
  }
  if (cmd === "HSET") {
    const key = args[0] ?? "";
    const row = store.get(key);
    if (row !== undefined && row.t !== "hash") return wrongType();
    const hash = row?.t === "hash" ? row.v : new Map<string, string>();
    let added = 0;
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (!hash.has(args[i]!)) added++;
      hash.set(args[i]!, args[i + 1]!);
    }
    store.set(key, { t: "hash", v: hash });
    return encodeInteger(added);
  }
  if (cmd === "HGET") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeNull();
    if (row.t !== "hash") return wrongType();
    const value = row.v.get(args[1] ?? "");
    return value === undefined ? encodeNull() : encodeReply(value);
  }
  if (cmd === "HGETALL") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeReply([]);
    if (row.t !== "hash") return wrongType();
    const items: string[] = [];
    for (const [field, value] of row.v) {
      items.push(field, value);
    }
    return encodeReply(items);
  }
  if (cmd === "LPUSH" || cmd === "RPUSH") {
    const key = args[0] ?? "";
    const row = store.get(key);
    if (row !== undefined && row.t !== "list") return wrongType();
    const list = row?.t === "list" ? row.v : [];
    const values = args.slice(1);
    if (cmd === "LPUSH") list.unshift(...values.reverse());
    else list.push(...values);
    store.set(key, { t: "list", v: list });
    return encodeInteger(list.length);
  }
  if (cmd === "LRANGE") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeReply([]);
    if (row.t !== "list") return wrongType();
    const start = Number(args[1] ?? 0);
    const stop = Number(args[2] ?? -1);
    const end = stop < 0 ? row.v.length + stop + 1 : stop + 1;
    return encodeReply(row.v.slice(start, end));
  }
  if (cmd === "SADD") {
    const key = args[0] ?? "";
    const row = store.get(key);
    if (row !== undefined && row.t !== "set") return wrongType();
    const set = row?.t === "set" ? row.v : new Set<string>();
    let added = 0;
    for (const member of args.slice(1)) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    store.set(key, { t: "set", v: set });
    return encodeInteger(added);
  }
  if (cmd === "SMEMBERS") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeReply([]);
    if (row.t !== "set") return wrongType();
    return encodeReply([...row.v]);
  }
  if (cmd === "ZADD") {
    const key = args[0] ?? "";
    const row = store.get(key);
    if (row !== undefined && row.t !== "zset") return wrongType();
    const zset = row?.t === "zset" ? row.v : new Map<string, number>();
    const member = args[2] ?? "";
    const added = zset.has(member) ? 0 : 1;
    zset.set(member, Number(args[1] ?? 0));
    store.set(key, { t: "zset", v: zset });
    return encodeInteger(added);
  }
  if (cmd === "ZRANGE") {
    const row = store.get(args[0] ?? "");
    if (row === undefined) return encodeReply([]);
    if (row.t !== "zset") return wrongType();
    const ranked = [...row.v.entries()].sort((a, b) => a[1] - b[1]);
    const start = Number(args[1] ?? 0);
    const stop = Number(args[2] ?? -1);
    const end = stop < 0 ? ranked.length + stop + 1 : stop + 1;
    return encodeReply(ranked.slice(start, end).map(([member]) => member));
  }
  return encodeError(`ERR unknown command '${name}'`);
};

const startFakeRedis = (options?: {
  readonly password?: string;
  readonly splitWrites?: boolean;
}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const store = new Map<string, Stored>();
      const sessions = new WeakMap<object, Session>();
      const password = options?.password ?? "";
      const splitWrites = options?.splitWrites === true;
      const write = (
        socket: { write(bytes: Uint8Array): unknown },
        payload: Uint8Array,
      ) => {
        if (!splitWrites) {
          socket.write(payload);
          return;
        }
        for (const byte of payload) {
          socket.write(new Uint8Array([byte]));
        }
      };
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          binaryType: "uint8array",
          open(socket) {
            sessions.set(socket, {
              parser: new Parser(),
              authed: password.length === 0,
            });
          },
          data(socket, chunk) {
            const session = sessions.get(socket);
            if (session === undefined) return;
            session.parser.push(chunk);
            while (true) {
              const frame = session.parser.next();
              if (frame._tag === "Incomplete") break;
              if (frame._tag !== "Reply" || !Array.isArray(frame.value)) {
                write(socket, encodeError("ERR protocol"));
                continue;
              }
              const [name, ...args] = frame.value.map(asString);
              if (!session.authed) {
                if ((name ?? "").toUpperCase() !== "AUTH") {
                  write(socket, encodeError("NOAUTH Authentication required"));
                  continue;
                }
                const supplied = args.length > 1 ? args[1] : args[0];
                if (supplied !== password) {
                  write(socket, encodeError("ERR invalid password"));
                  continue;
                }
                session.authed = true;
                write(socket, encodeSimpleString("OK"));
                continue;
              }
              write(socket, execute(store, name ?? "", args));
            }
          },
        },
      });
      return {
        url: Redis.connectionUrl({
          host: "127.0.0.1",
          port: server.port,
          password,
        }),
        server,
      };
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.stop(true);
      }),
  );

describe("Redis protocol client", () => {
  it.effect("PING SET GET DEL over a one-shot connection", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      expect(yield* Redis.run(url, "PING")).toBe("PONG");
      expect(yield* Redis.run(url, "SET", ["marker", "hello"])).toBe("OK");
      expect(yield* Redis.run(url, "GET", ["marker"])).toBe("hello");
      expect(yield* Redis.run(url, "GET", ["missing"])).toBeNull();
      expect(yield* Redis.run(url, "DEL", ["marker"])).toBe(1);
    }),
  );

  it.effect("values may contain CR LF $ * and UTF-8", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      const value = "line1\r\n$bulk\n*2\r\n😀";
      yield* Redis.run(url, "SET", ["k", value]);
      expect(yield* Redis.run(url, "GET", ["k"])).toBe(value);
    }),
  );

  it.effect("AUTH then command, and AUTH failure", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis({ password: "s3cret" });
      expect(yield* Redis.run(url, "PING")).toBe("PONG");
      const denied = yield* Redis.run(
        Redis.connectionUrl({
          host: "127.0.0.1",
          port: Number(new URL(url).port),
          password: "nope",
        }),
        "PING",
      ).pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
    }),
  );

  it.effect("pipeline issues several commands on one connection", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      const replies = yield* Redis.pipeline(url, [
        ["PING"],
        ["SET", "a", "1"],
        ["INCR", "n"],
        ["GET", "a"],
      ]);
      expect(replies).toEqual(["PONG", "OK", 1, "1"]);
    }),
  );

  it.effect("session send reuses the socket", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      const conn = yield* Redis.connect(url);
      expect(yield* conn.send("PING")).toBe("PONG");
      expect(yield* conn.send("SET", ["k", "v"])).toBe("OK");
      expect(yield* conn.send("GET", ["k"])).toBe("v");
      expect(yield* conn.send("INCR", ["n"])).toBe(1);
      expect(yield* conn.send("INCR", ["n"])).toBe(2);
    }),
  );

  it.effect("hashes lists sets sorted sets and typed errors", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      const conn = yield* Redis.connect(url);
      expect(yield* conn.send("HSET", ["h", "a", "1", "b", "2"])).toBe(2);
      expect(yield* conn.send("HGET", ["h", "a"])).toBe("1");
      expect(yield* conn.send("HGETALL", ["h"])).toEqual(["a", "1", "b", "2"]);
      expect(yield* conn.send("LPUSH", ["l", "x", "y"])).toBe(2);
      expect(yield* conn.send("LRANGE", ["l", 0, -1])).toEqual(["y", "x"]);
      expect(yield* conn.send("SADD", ["s", "a", "a", "b"])).toBe(2);
      const members = yield* conn.send("SMEMBERS", ["s"]);
      expect(Array.isArray(members) ? [...members].sort() : members).toEqual([
        "a",
        "b",
      ]);
      expect(yield* conn.send("ZADD", ["z", 2, "b"])).toBe(1);
      expect(yield* conn.send("ZADD", ["z", 1, "a"])).toBe(1);
      expect(yield* conn.send("ZRANGE", ["z", 0, -1])).toEqual(["a", "b"]);
      const wrong = yield* conn.send("GET", ["h"]).pipe(Effect.result);
      expect(Result.isFailure(wrong)).toBe(true);
      const unknown = yield* conn.send("NOPE").pipe(Effect.result);
      expect(Result.isFailure(unknown)).toBe(true);
    }),
  );

  it.effect("buffers replies split into one-byte TCP writes", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis({ splitWrites: true });
      expect(yield* Redis.run(url, "PING")).toBe("PONG");
      yield* Redis.run(url, "SET", ["k", "hello\r\nworld"]);
      expect(yield* Redis.run(url, "GET", ["k"])).toBe("hello\r\nworld");
      expect(
        yield* Redis.pipeline(url, [
          ["HSET", "h", "f", "v"],
          ["HGETALL", "h"],
        ]),
      ).toEqual([1, ["f", "v"]]);
    }),
  );

  it.effect("SELECT from the URL path", () =>
    Effect.gen(function* () {
      const { url } = yield* startFakeRedis();
      const parsed = new URL(url);
      const withDb = `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.hostname}:${parsed.port}/2`;
      expect(yield* Redis.run(withDb, "PING")).toBe("PONG");
    }),
  );
});
