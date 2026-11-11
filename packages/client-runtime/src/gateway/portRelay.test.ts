import { McpGatewayRelayResponse, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import type { GatewayRuntimePort } from "./port.ts";
import { serveGatewayPortRelays } from "./portRelay.ts";

it("resubscribes after its relay fails and answers void calls in a form the wire can encode", async () => {
  // The relay RPC encodes each response as JSON, which rejects `{ result: undefined }`.
  const encode = Schema.encodeUnknownSync(Schema.toCodecJson(McpGatewayRelayResponse));
  const responses: Array<unknown> = [];
  const answered = Promise.withResolvers<void>();
  const session = {
    client: {
      [WS_METHODS.mcpGatewayRespond]: (response: unknown) =>
        Effect.sync(() => {
          responses.push(encode(response));
          answered.resolve();
        }),
    },
  };
  let subscriptions = 0;
  const registry = {
    followStream: () =>
      ++subscriptions === 1
        ? Stream.die(new Error("Expected JSON value"))
        : Stream.make([
            session,
            {
              type: "invoke",
              connectionId: "connection",
              invocationId: "invocation",
              method: "settleThread",
              args: ["remote", "thread"],
            },
          ] as const).pipe(Stream.concat(Stream.never)),
  } as unknown as EnvironmentRegistry["Service"];
  const settleThread = vi.fn(async () => undefined);
  const failures: Array<unknown> = [];

  vi.useFakeTimers();
  try {
    const stop = serveGatewayPortRelays(
      Context.make(EnvironmentRegistry, registry),
      { settleThread } as unknown as GatewayRuntimePort,
      { remote: ["lifecycle"] },
      (error) => failures.push(error),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await answered.promise;
    stop();
  } finally {
    vi.useRealTimers();
  }

  expect(failures).toHaveLength(1);
  expect(subscriptions).toBe(2);
  expect(settleThread).toHaveBeenCalledWith("remote", "thread");
  expect(responses).toEqual([{ connectionId: "connection", invocationId: "invocation" }]);
});

it("refuses a relayed call whose scope this app's grant for the environment lacks", async () => {
  const responses: Array<unknown> = [];
  const answered = Promise.withResolvers<void>();
  const session = {
    client: {
      [WS_METHODS.mcpGatewayRespond]: (response: unknown) =>
        Effect.sync(() => {
          responses.push(response);
          answered.resolve();
        }),
    },
  };
  const registry = {
    followStream: () =>
      Stream.make([
        session,
        {
          type: "invoke",
          connectionId: "connection",
          invocationId: "invocation",
          method: "sendMessage",
          args: [{ environmentId: "remote", threadId: "thread", text: "hi" }],
        },
      ] as const).pipe(Stream.concat(Stream.never)),
  } as unknown as EnvironmentRegistry["Service"];
  const sendMessage = vi.fn(async () => ({ status: "accepted" }));

  const stop = serveGatewayPortRelays(
    Context.make(EnvironmentRegistry, registry),
    { sendMessage } as unknown as GatewayRuntimePort,
    { remote: ["read"] },
    () => undefined,
  );
  await answered.promise;
  stop();

  expect(sendMessage).not.toHaveBeenCalled();
  expect(responses).toEqual([
    {
      connectionId: "connection",
      invocationId: "invocation",
      error: expect.stringContaining("send"),
    },
  ]);
});
