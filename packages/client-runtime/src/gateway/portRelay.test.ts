import { McpGatewayRelayResponse, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import type { GatewayRuntimePort } from "./port.ts";
import { answerGatewayPortCall, serveGatewayPortRelays } from "./portRelay.ts";

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
    run: () => Effect.succeed({ selfMember: null, devices: [] }),
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
              modeCeiling: { runtimeMode: "full-access", interactionMode: "default" },
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

const fullThread = { runtimeMode: "full-access", interactionMode: "default" };
const FULL = { runtimeMode: "full-access", interactionMode: "default" } as const;

it("runs a relayed call that carries no modes as the narrowest chat would", async () => {
  const sendMessage = vi.fn(async () => ({ status: "accepted" }));
  const port = {
    sendMessage,
    getThread: async () => fullThread,
  } as unknown as GatewayRuntimePort;
  const send = { environmentId: "remote", threadId: "thread", text: "hi" };

  await expect(
    answerGatewayPortCall(port, { remote: ["send"] }, "sendMessage", [send]),
  ).rejects.toThrow("broader");
  expect(sendMessage).not.toHaveBeenCalled();
  await answerGatewayPortCall(port, { remote: ["send"] }, "sendMessage", [send], FULL);
  expect(sendMessage).toHaveBeenCalledOnce();
});

it("caps a relayed call at what the target's own roster lets the calling machine do", async () => {
  const device = (environmentId: string, access: string | null) => ({ environmentId, access });
  const cases = [
    // The calling machine's roster entry here says read-only, whatever its own roster says.
    {
      snapshot: { selfMember: { access: "full-access" }, devices: [device("caller", "read-only")] },
      sent: false,
    },
    // A machine in a network that does not list the caller lets it do nothing.
    { snapshot: { selfMember: { access: "full-access" }, devices: [] }, sent: false },
    { snapshot: undefined, sent: false },
    {
      snapshot: {
        selfMember: { access: "full-access" },
        devices: [device("caller", "full-access")],
      },
      sent: true,
    },
    // A machine in no network sets no cap.
    { snapshot: { selfMember: null, devices: [] }, sent: true },
  ];
  for (const { snapshot, sent } of cases) {
    const answered = Promise.withResolvers<unknown>();
    const session = {
      client: {
        [WS_METHODS.mcpGatewayRespond]: (response: unknown) =>
          Effect.sync(() => answered.resolve(response)),
      },
    };
    const registry = {
      run: () => (snapshot === undefined ? Effect.fail("offline") : Effect.succeed(snapshot)),
      followStream: (environmentId: string) =>
        environmentId !== "caller"
          ? Stream.never
          : Stream.make([
              session,
              {
                type: "invoke",
                connectionId: "connection",
                invocationId: "invocation",
                method: "sendMessage",
                args: [{ environmentId: "remote", threadId: "thread", text: "hi" }],
                modeCeiling: FULL,
              },
            ] as const).pipe(Stream.concat(Stream.never)),
    } as unknown as EnvironmentRegistry["Service"];
    const sendMessage = vi.fn(async () => ({ status: "accepted" }));
    const stop = serveGatewayPortRelays(
      Context.make(EnvironmentRegistry, registry),
      { sendMessage, getThread: async () => fullThread } as unknown as GatewayRuntimePort,
      { caller: ["read", "send"], remote: ["read", "send"] },
      () => undefined,
    );
    const response = await answered.promise;
    stop();
    expect(sendMessage).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(response).toEqual(
      sent
        ? expect.not.objectContaining({ error: expect.anything() })
        : expect.objectContaining({ error: expect.any(String) }),
    );
  }
});
