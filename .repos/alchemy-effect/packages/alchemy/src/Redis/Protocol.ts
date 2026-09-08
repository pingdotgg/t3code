import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { CommandError, ProtocolError, type UrlMissing } from "./Errors.ts";
import { encodeCommand, Parser, type Arg, type Reply } from "./Resp.ts";

export const DEFAULT_PORT = 6379;
export const TLS_PORT = 6380;

type SocketEvent =
  | { readonly _tag: "Data"; readonly bytes: Uint8Array }
  | { readonly _tag: "End" }
  | { readonly _tag: "Fail"; readonly cause: unknown };

interface RawSocket {
  write(bytes: Uint8Array): number | Promise<number>;
  end(): void;
}

export interface RedisUrl {
  readonly hostname: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username: string;
  readonly password: string;
  readonly db: number | undefined;
}

/** Parse a `redis://` or `rediss://` URL. */
export const parseUrl = (url: string): RedisUrl => {
  const parsed = new URL(url);
  const tls = parsed.protocol === "rediss:";
  const path = parsed.pathname.startsWith("/")
    ? parsed.pathname.slice(1)
    : parsed.pathname;
  const dbRaw = path.length === 0 ? undefined : Number(path);
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port || (tls ? TLS_PORT : DEFAULT_PORT)),
    tls,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    db:
      dbRaw !== undefined && Number.isInteger(dbRaw) && dbRaw >= 0
        ? dbRaw
        : undefined,
  };
};

/** Build a `redis://` URL. Encodes the password. Used by tests and TcpProxy. */
export const connectionUrl = (input: {
  host: string;
  port: number;
  password: string;
  username?: string;
  db?: number;
  tls?: boolean;
}): string => {
  const username = input.username ?? "default";
  const scheme = input.tls ? "rediss" : "redis";
  const db = input.db !== undefined ? `/${input.db}` : "";
  return `${scheme}://${username}:${encodeURIComponent(input.password)}@${input.host}:${input.port}${db}`;
};

const commandError = (command: string, cause: unknown): CommandError =>
  cause instanceof CommandError
    ? new CommandError({ command, cause: cause.cause })
    : new CommandError({ command, cause });

const asBytes = (data: Uint8Array): Uint8Array => new Uint8Array(data);

const writeSocket = (
  socket: RawSocket,
  bytes: Uint8Array,
): Effect.Effect<void, CommandError> => {
  const written = socket.write(bytes);
  if (typeof written === "object" && written !== null && "then" in written) {
    return Effect.tryPromise({
      try: () => Promise.resolve(written),
      catch: (cause) => commandError("WRITE", cause),
    }).pipe(Effect.asVoid);
  }
  return Effect.void;
};

const openBun = (
  options: RedisUrl,
  events: Queue.Queue<SocketEvent>,
): Effect.Effect<RawSocket, CommandError> =>
  Effect.callback<RawSocket, CommandError>((resume, signal) => {
    let settled = false;
    let socket: RawSocket | undefined;
    const succeed = (value: RawSocket) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };
    const fail = (cause: unknown) => {
      if (settled) {
        Queue.offerUnsafe(events, { _tag: "Fail", cause });
        return;
      }
      settled = true;
      resume(Effect.fail(commandError("CONNECT", cause)));
    };
    const Client = (globalThis as { Bun?: { connect: typeof Bun.connect } })
      .Bun;
    if (Client === undefined) {
      fail(new Error("Bun.connect is not available"));
      return;
    }
    Client.connect({
      hostname: options.hostname,
      port: options.port,
      tls: options.tls,
      socket: {
        binaryType: "uint8array",
        open: (opened) => {
          socket = opened;
          succeed(opened);
        },
        data: (_opened, chunk) => {
          Queue.offerUnsafe(events, {
            _tag: "Data",
            bytes: asBytes(chunk),
          });
        },
        error: (_opened, cause) => fail(cause),
        connectError: (_opened, cause) => fail(cause),
        close: () => {
          Queue.offerUnsafe(events, { _tag: "End" });
        },
        end: () => {
          Queue.offerUnsafe(events, { _tag: "End" });
        },
      },
    }).catch(fail);

    const abort = () => {
      socket?.end();
    };
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
      abort();
    });
  });

const openNode = (
  options: RedisUrl,
  events: Queue.Queue<SocketEvent>,
): Effect.Effect<RawSocket, CommandError> =>
  Effect.callback<RawSocket, CommandError>((resume, signal) => {
    let settled = false;
    let socket: { write(bytes: Uint8Array): boolean; end(): void } | undefined;
    const succeed = (value: RawSocket) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };
    const fail = (cause: unknown) => {
      if (settled) {
        Queue.offerUnsafe(events, { _tag: "Fail", cause });
        return;
      }
      settled = true;
      resume(Effect.fail(commandError("CONNECT", cause)));
    };

    const attach = (
      nodeSocket: {
        write(bytes: Uint8Array): boolean;
        end(): void;
        on(event: string, listener: (...args: any[]) => void): unknown;
      },
      ready: "connect" | "secureConnect",
    ) => {
      socket = nodeSocket;
      nodeSocket.on(ready, () =>
        succeed({
          write: (bytes) => {
            nodeSocket.write(bytes);
            return bytes.length;
          },
          end: () => {
            nodeSocket.end();
          },
        }),
      );
      nodeSocket.on("data", (chunk: Uint8Array) => {
        Queue.offerUnsafe(events, { _tag: "Data", bytes: asBytes(chunk) });
      });
      nodeSocket.on("error", fail);
      nodeSocket.on("close", () => {
        Queue.offerUnsafe(events, { _tag: "End" });
      });
    };

    const start = options.tls
      ? import("node:tls").then((tls) =>
          attach(
            tls.connect({
              host: options.hostname,
              port: options.port,
              servername: options.hostname,
            }),
            "secureConnect",
          ),
        )
      : import("node:net").then((net) =>
          attach(
            net.connect({ host: options.hostname, port: options.port }),
            "connect",
          ),
        );
    start.catch(fail);

    const abort = () => {
      socket?.end();
    };
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
      abort();
    });
  });

const openRaw = (
  options: RedisUrl,
  events: Queue.Queue<SocketEvent>,
): Effect.Effect<RawSocket, CommandError> =>
  typeof Bun !== "undefined"
    ? openBun(options, events)
    : openNode(options, events);

const unwrap = (
  frame: Exclude<import("./Resp.ts").ParseResult, { _tag: "Incomplete" }>,
  command: string,
): Effect.Effect<Reply, CommandError> => {
  if (frame._tag === "Protocol") {
    return Effect.fail(commandError(command, frame.error));
  }
  if (frame._tag === "Error") {
    return Effect.fail(commandError(command, frame.error));
  }
  if (frame._tag === "Push") {
    return Effect.succeed(frame.value);
  }
  return Effect.succeed(frame.value);
};

const expectStatus = (
  reply: Reply,
  command: string,
): Effect.Effect<void, CommandError> => {
  if (typeof reply === "string" && reply.toUpperCase() === "OK") {
    return Effect.void;
  }
  return Effect.fail(
    commandError(
      command,
      new ProtocolError({ message: `expected OK, got ${String(reply)}` }),
    ),
  );
};

export interface Connection {
  readonly send: (
    command: string,
    args?: readonly Arg[],
  ) => Effect.Effect<Reply, CommandError>;
  readonly pipeline: (
    commands: ReadonlyArray<readonly [string, ...Arg[]]>,
  ) => Effect.Effect<readonly Reply[], CommandError>;
}

const readReplies = (
  events: Queue.Queue<SocketEvent>,
  parser: Parser,
  count: number,
  command: string,
): Effect.Effect<Reply[], CommandError> =>
  Effect.gen(function* () {
    const replies: Reply[] = [];
    while (replies.length < count) {
      const event = yield* Queue.take(events);
      if (event._tag === "Fail") {
        return yield* Effect.fail(commandError(command, event.cause));
      }
      if (event._tag === "End") {
        return yield* Effect.fail(
          commandError(
            command,
            new ProtocolError({ message: "connection closed" }),
          ),
        );
      }
      parser.push(event.bytes);
      while (replies.length < count) {
        const frame = parser.next();
        if (frame._tag === "Incomplete") break;
        if (frame._tag === "Push") continue;
        replies.push(yield* unwrap(frame, command));
      }
    }
    return replies;
  });

/**
 * Open an authenticated Redis session. Closes when the ambient Scope
 * is released. Concurrent `send`/`pipeline` calls on one connection
 * are serialized so replies stay ordered.
 */
export const connect = (
  url: string,
): Effect.Effect<Connection, CommandError, Scope.Scope> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseUrl(url),
      catch: (cause) => commandError("CONNECT", cause),
    });
    const events = yield* Queue.unbounded<SocketEvent>();
    const socket = yield* Effect.acquireRelease(
      openRaw(options, events),
      (opened) =>
        Effect.sync(() => {
          opened.end();
        }).pipe(
          Effect.flatMap(() => Queue.shutdown(events)),
          Effect.asVoid,
        ),
    );
    const parser = new Parser();
    const lock = yield* Semaphore.make(1);

    const request = (payload: Uint8Array, count: number, command: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* writeSocket(socket, payload);
          return yield* readReplies(events, parser, count, command);
        }),
      );

    if (options.password.length > 0) {
      const authArgs =
        options.username.length > 0 && options.username !== "default"
          ? [options.username, options.password]
          : [options.password];
      const replies = yield* request(
        encodeCommand("AUTH", authArgs),
        1,
        "AUTH",
      );
      yield* expectStatus(replies[0] ?? null, "AUTH");
    }

    if (options.db !== undefined && options.db !== 0) {
      const replies = yield* request(
        encodeCommand("SELECT", [options.db]),
        1,
        "SELECT",
      );
      yield* expectStatus(replies[0] ?? null, "SELECT");
    }

    return {
      send: (command, args = []) =>
        request(encodeCommand(command, args), 1, command).pipe(
          Effect.map((replies) => replies[0] ?? null),
        ),
      pipeline: (commands) => {
        if (commands.length === 0) return Effect.succeed([]);
        const chunks = commands.map(([name, ...args]) =>
          encodeCommand(name, args),
        );
        let total = 0;
        for (const chunk of chunks) total += chunk.length;
        const payload = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.length;
        }
        return request(
          payload,
          commands.length,
          commands[0]?.[0] ?? "PIPELINE",
        );
      },
    } satisfies Connection;
  });

const scoped = <A>(
  command: string,
  effect: Effect.Effect<A, CommandError, Scope.Scope>,
): Effect.Effect<A, CommandError> =>
  Effect.scoped(effect).pipe(
    Effect.mapError((error) => commandError(command, error)),
  );

/**
 * Send one Redis command over RESP and close the connection.
 */
export const run = (
  url: string,
  command: string,
  args: readonly Arg[] = [],
): Effect.Effect<Reply, CommandError> =>
  scoped(
    command,
    Effect.gen(function* () {
      const connection = yield* connect(url);
      return yield* connection.send(command, args);
    }),
  );

/**
 * Pipeline several commands on one connection, then close it.
 */
export const pipeline = (
  url: string,
  commands: ReadonlyArray<readonly [string, ...Arg[]]>,
): Effect.Effect<readonly Reply[], CommandError> =>
  scoped(
    commands[0]?.[0] ?? "PIPELINE",
    Effect.gen(function* () {
      const connection = yield* connect(url);
      return yield* connection.pipeline(commands);
    }),
  );

export const command = (
  url: Effect.Effect<string, UrlMissing, RuntimeContext>,
  name: string,
  args: readonly Arg[] = [],
): Effect.Effect<Reply, CommandError | UrlMissing, RuntimeContext> =>
  Effect.gen(function* () {
    const resolved = yield* url;
    return yield* run(resolved, name, args);
  });

export const commandPipeline = (
  url: Effect.Effect<string, UrlMissing, RuntimeContext>,
  commands: ReadonlyArray<readonly [string, ...Arg[]]>,
): Effect.Effect<readonly Reply[], CommandError | UrlMissing, RuntimeContext> =>
  Effect.gen(function* () {
    const resolved = yield* url;
    return yield* pipeline(resolved, commands);
  });
