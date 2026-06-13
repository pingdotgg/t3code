import {
  makeServerRpcSession,
  type ServerWebSocketLike,
} from "@/Local/RpcServerSession.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("Local.RpcServerSession", () => {
  it.effect("happy path: paired sessions round-trip a method call", () =>
    Effect.gen(function* () {
      const mainA = { ping: async (x: number) => x + 1 };
      const mainB = { pong: async (x: string) => `${x}!` };
      const { a } = pairSessions(mainA, mainB);
      const remote = a.session.getRemoteMain() as unknown as {
        pong: (x: string) => Promise<string>;
      };
      const result = yield* Effect.promise(() => remote.pong("hi"));
      expect(result).toBe("hi!");
    }),
  );

  it.effect("string and Buffer payloads both decode", () =>
    Effect.gen(function* () {
      const received: Array<string> = [];
      const ws: ServerWebSocketLike = {
        send: () => {},
        close: () => {},
      };
      // Build a session purely to observe `dispatch.message` decoding.
      // Use a noop main; we won't call anything on it.
      const { dispatch } = makeServerRpcSession(ws, {});
      const origMessage = dispatch.message;
      dispatch.message = (data: any) => {
        if (typeof data === "string") {
          received.push(`str:${data}`);
        } else {
          received.push(`buf:${data.toString("utf-8")}`);
        }
        return origMessage(data);
      };
      dispatch.message("hello");
      dispatch.message(Buffer.from("world", "utf-8") as Buffer<ArrayBuffer>);
      expect(received).toEqual(["str:hello", "buf:world"]);
    }),
  );

  it.effect("dispatch.message after dispatch.close is dropped silently", () =>
    Effect.gen(function* () {
      const ws: ServerWebSocketLike = {
        send: () => {},
        close: () => {},
      };
      const { dispatch } = makeServerRpcSession(ws, {});
      dispatch.close(1000, "bye");
      // Should not throw, should be a no-op.
      expect(() => dispatch.message("anything")).not.toThrow();
    }),
  );

  it.effect("dispatch.close rejects a pending getRemoteMain call", () =>
    Effect.gen(function* () {
      // mainB never resolves on the wire because we never deliver anything
      // back; the close event should reject the in-flight call.
      const closes: Array<{ code?: number; reason?: string }> = [];
      const ws: ServerWebSocketLike = {
        send: () => {
          // intentionally drop outbound traffic
        },
        close: (code, reason) => {
          closes.push({ code, reason });
        },
      };
      const { session, dispatch } = makeServerRpcSession(ws, {});
      const remote = session.getRemoteMain() as unknown as {
        ping: (n: number) => Promise<number>;
      };
      const inFlight = remote.ping(1);
      dispatch.close(1006, "abnormal");
      // The dropped outbound traffic means the only way `inFlight` can
      // resolve is by rejection after `dispatch.close`. Wrap it as an
      // Effect that fails on rejection so we can assert with `Exit`.
      const exit = yield* Effect.exit(Effect.tryPromise(() => inFlight));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

/**
 * Wire two `ServerRpcSession`s together over in-memory fake websockets so we
 * can drive `RpcSession.getRemoteMain()` end-to-end without touching the
 * platform WS server.
 */
const pairSessions = <
  A extends Record<string, any>,
  B extends Record<string, any>,
>(
  mainA: A,
  mainB: B,
) => {
  const closes: Array<{ side: "a" | "b"; code?: number; reason?: string }> = [];
  let a!: ReturnType<typeof makeServerRpcSession<A>>;
  let b!: ReturnType<typeof makeServerRpcSession<B>>;

  const wsA: ServerWebSocketLike = {
    send: (msg) => {
      queueMicrotask(() => b.dispatch.message(msg));
    },
    close: (code, reason) => {
      closes.push({ side: "a", code, reason });
    },
  };
  const wsB: ServerWebSocketLike = {
    send: (msg) => {
      queueMicrotask(() => a.dispatch.message(msg));
    },
    close: (code, reason) => {
      closes.push({ side: "b", code, reason });
    },
  };
  a = makeServerRpcSession<A>(wsA, mainA);
  b = makeServerRpcSession<B>(wsB, mainB);
  return { a, b, wsA, wsB, closes };
};
