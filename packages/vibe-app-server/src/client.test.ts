import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as VibeClient from "./client.ts";
import * as VibeError from "./errors.ts";
import * as VibeProtocol from "./protocol.ts";

const isRequestError = Schema.is(VibeError.VibeAppServerRequestError);

describe("parseJsonRpcLine", () => {
  it("parses requests, notifications, successes and failures", () => {
    const parse = VibeProtocol.parseJsonRpcLine;
    expect(
      VibeProtocol.isJsonRpcRequest(parse('{"jsonrpc":"2.0","id":1,"method":"session/start"}')!),
    ).toBe(true);
    expect(
      VibeProtocol.isJsonRpcNotification(parse('{"jsonrpc":"2.0","method":"turn/started"}')!),
    ).toBe(true);
    expect(
      VibeProtocol.isJsonRpcSuccess(parse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')!),
    ).toBe(true);
    expect(
      VibeProtocol.isJsonRpcFailure(
        parse('{"jsonrpc":"2.0","id":1,"error":{"code":"conflict","message":"x"}}')!,
      ),
    ).toBe(true);
    expect(parse("not json")).toBeUndefined();
    expect(parse("")).toBeUndefined();
  });
});

/* Let queued fibers run until the in-memory pipes are drained. */
const flushQueues = () =>
  Effect.gen(function* () {
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
  });

const encoder = new TextEncoder();
const serverLine = (input: Queue.Queue<Uint8Array>, payload: unknown) =>
  Queue.offer(input, encoder.encode(`${JSON.stringify(payload)}\n`));

/** Fake vibe-app-server: answers initialize/account/read, fails session/stop, notifies on anything else. */
const seenRequests: Array<{ method: string; params: unknown }> = [];

const fakeServer = (
  output: Queue.Queue<string>,
  input: Queue.Queue<Uint8Array>,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.gen(function* () {
      const line = yield* Queue.take(output);
      const message = VibeProtocol.parseJsonRpcLine(line);
      if (!message || !VibeProtocol.isJsonRpcRequest(message)) return;
      seenRequests.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          return yield* serverLine(input, {
            jsonrpc: "2.0",
            id: message.id,
            result: { serverInfo: { name: "vibe-app-server", version: "9.9.9" }, processId: 42 },
          });
        case "account/read":
          return yield* serverLine(input, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              account: {
                status: "ready",
                plan: { kind: "chat", name: "PRO", title: "Pro" },
                budget: {
                  usagePercentage: 12.5,
                  resetAt: "2026-12-01T00:00:00Z",
                  paygEnabled: false,
                },
              },
            },
          });
        case "session/stop":
          return yield* serverLine(input, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: "conflict", message: "no session" },
          });
        default:
          yield* serverLine(input, {
            jsonrpc: "2.0",
            method: "turn/started",
            params: { eventId: 1, sessionId: "s1" },
          });
          return yield* serverLine(input, { jsonrpc: "2.0", id: message.id, result: {} });
      }
    }),
  );

describe("VibeAppServerClient over in-memory stdio", () => {
  it.effect("round-trips typed requests, dispatches notifications, maps errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* VibeClient.makeInMemoryStdio();
        const serverFiber = yield* Effect.forkScoped(fakeServer(output, input));
        const client = yield* VibeClient.make(stdio);

        const notifications: Array<{ method: string; params: unknown }> = [];
        yield* client.handleUnknownServerNotification((method, params) =>
          Effect.sync(() => {
            notifications.push({ method, params });
          }),
        );

        const init = yield* client.initialize({ clientName: "test", clientVersion: "0.0.0" });
        expect(init.serverInfo.version).toBe("9.9.9");
        yield* client.initialized();

        const account = yield* client.accountRead("s1");
        expect(account.status).toBe("ready");
        expect(account.budget?.usagePercentage).toBe(12.5);

        // JSON-RPC error surfaces as a typed request error with method attached.
        const outcome = yield* Effect.result(client.sessionStop({ sessionId: "s1" }));
        const requestError =
          Result.isFailure(outcome) && isRequestError(outcome.failure)
            ? outcome.failure
            : undefined;
        expect(requestError?._tag).toBe("VibeAppServerRequestError");
        expect(requestError?.method).toBe("session/stop");
        expect(requestError?.code).toBe("conflict");

        // Unknown method triggers the notification path on the fake server.
        yield* client.sessionDelete("s1");
        yield* flushQueues();
        expect(notifications.some((n) => n.method === "turn/started")).toBe(true);

        // Pagination goes under `page`, and callback answers nest `{ callbackId, output }` in `result`.
        yield* client
          .sessionHistoryList({ sessionId: "s1", limit: 5, cursor: "c1" })
          .pipe(Effect.ignore);
        yield* client.sessionTurnsList({ sessionId: "s1", limit: 5 }).pipe(Effect.ignore);
        yield* client
          .callbackResult({ sessionId: "s1", callbackId: "cb1", result: { outcome: "approved" } })
          .pipe(Effect.ignore);
        yield* flushQueues();
        const historyReq = seenRequests.find((r) => r.method === "session/history/list");
        expect(historyReq?.params).toEqual({ sessionId: "s1", page: { limit: 5, cursor: "c1" } });
        const turnsReq = seenRequests.find((r) => r.method === "session/turns/list");
        expect(turnsReq?.params).toEqual({ sessionId: "s1", page: { limit: 5 } });
        const callbackReq = seenRequests.find((r) => r.method === "callback/result");
        expect(callbackReq?.params).toEqual({
          sessionId: "s1",
          result: { callbackId: "cb1", output: { outcome: "approved" } },
        });

        yield* Fiber.interrupt(serverFiber);
      }),
    ),
  );
});
