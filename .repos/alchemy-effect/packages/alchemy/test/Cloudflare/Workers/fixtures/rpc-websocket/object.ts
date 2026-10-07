import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Greeting, Rejected, SocketRpcs } from "./rpcs.ts";

export class SocketObject extends Cloudflare.RpcDurableObject<SocketObject>()(
  "SocketObject",
  { schema: SocketRpcs },
) {}

export const SocketObjectLive = SocketObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      const opened: string[] = [];
      const closed: string[] = [];
      const cleanupStarted: string[] = [];
      const cleanups = new Map<string, Deferred.Deferred<void>>();
      return SocketRpcs.toLayer({
        greet: ({ name }) =>
          Effect.succeed(new Greeting({ message: `Hello, ${name}!` })),
        increment: () =>
          state.storage
            .transaction(
              Effect.gen(function* () {
                const count =
                  ((yield* state.storage.get<number>("count")) ?? 0) + 1;
                yield* state.storage.put("count", count);
                return count;
              }),
            )
            .pipe(Effect.orDie),
        reject: () =>
          Effect.fail(new Rejected({ message: "rejected by handler" })),
        numbers: ({ count }) => Stream.range(1, count),
        watch: ({ key }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* state.storage
                .transaction(
                  Effect.gen(function* () {
                    const invocations =
                      (yield* state.storage.get<Record<string, number>>(
                        "invocations",
                      )) ?? {};
                    yield* state.storage.put("invocations", {
                      ...invocations,
                      [key]: (invocations[key] ?? 0) + 1,
                    });
                  }),
                )
                .pipe(Effect.orDie);
              yield* Effect.sync(() => opened.push(key));
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => closed.push(key)),
              );
              return Stream.concat(
                Stream.make(1),
                Stream.fromEffect(Effect.never),
              );
            }),
          ),
        cleanup: ({ key, waitForDisconnect }) =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Effect.sync(() => cleanupStarted.push(key));
                // No timer or I/O keeps the activation alive while cleanup waits.
                yield* Deferred.await(release);
                yield* state.storage
                  .transaction(
                    Effect.gen(function* () {
                      const completed =
                        (yield* state.storage.get<Record<string, number>>(
                          "cleanupCompleted",
                        )) ?? {};
                      yield* state.storage.put("cleanupCompleted", {
                        ...completed,
                        [key]: boots,
                      });
                    }),
                  )
                  .pipe(Effect.orDie);
                yield* Effect.sync(() => cleanups.delete(key));
              }),
            );
            yield* Effect.sync(() => {
              cleanups.set(key, release);
              opened.push(key);
            });
            return yield* waitForDisconnect
              ? Effect.never
              : Effect.succeed(boots);
          }),
        releaseCleanup: ({ key }) =>
          Effect.suspend(() => {
            const release = cleanups.get(key);
            return release === undefined
              ? Effect.succeed(false)
              : Deferred.succeed(release, undefined);
          }),
        invalidateSocketSerialization: Effect.fn(function* () {
          const sockets = yield* state.getWebSockets("alchemy:rpc");
          const attachmentSchema = Schema.Struct({
            __alchemyRpcWebSocket: Schema.Struct({
              version: Schema.Literal(1),
              clientId: Schema.Number,
              pending: Schema.Boolean,
              serialization: Schema.String,
            }),
          });
          for (const socket of sockets) {
            yield* Effect.sync(() => {
              const attachment = socket.deserializeAttachment<unknown>();
              if (!Schema.is(attachmentSchema)(attachment)) {
                throw new Error("Missing RPC WebSocket attachment");
              }
              if (attachment.__alchemyRpcWebSocket.pending) {
                throw new Error("Cannot change serialization during an RPC");
              }
              socket.serializeAttachment({
                ...attachment,
                __alchemyRpcWebSocket: {
                  ...attachment.__alchemyRpcWebSocket,
                  serialization: "application/x-incompatible-rpc",
                },
              });
            });
          }
          return sockets.length;
        }),
        abort: Effect.fn(function* () {
          // Native abort discards buffered storage writes.
          yield* state.storage.sync();
          yield* state.abort("RPC WebSocket test abort", { retryAlarm: false });
        }),
        stats: Effect.fn(function* () {
          return {
            boots,
            count: (yield* state.storage.get<number>("count")) ?? 0,
            opened: [...opened],
            closed: [...closed],
            invocations:
              (yield* state.storage.get<Record<string, number>>(
                "invocations",
              )) ?? {},
            cleanupStarted: [...cleanupStarted],
            cleanupCompleted:
              (yield* state.storage.get<Record<string, number>>(
                "cleanupCompleted",
              )) ?? {},
          };
        }),
      });
    });
  }),
);
