import { McpGatewayRelayResponse, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import type { GatewayRuntimePort } from "./port.ts";
import type { GatewayGrants } from "./bridgeClient.ts";
import {
  answerGatewayPortCall,
  relayGrantsProblem,
  RosterRetrySchedule,
  serveGatewayPortRelays,
} from "./portRelay.ts";

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
  let follows = 0;
  const registry = {
    run: () => Effect.succeed({ selfMember: null, devices: [] }),
    // Each relay subscription comes first, then its roster's.
    followStream: () =>
      follows++ % 2 === 1
        ? Stream.never
        : ++subscriptions === 1
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

it("caps a relayed call only where the target's own roster narrows the calling machine", async () => {
  const device = (access: string | null, member: object | null = null) => ({
    environmentId: "caller",
    access,
    member,
  });
  const inNetwork = (devices: ReadonlyArray<object>) => ({
    selfMember: { access: "full-access" },
    devices,
  });
  const cases = [
    // The roster there narrowed or revoked the calling machine, whatever its own roster says.
    {
      held: inNetwork([device("read-only", { access: "read-only" })]),
      refused: "gives the calling machine read-only access",
    },
    { held: inNetwork([device("revoked", { access: "revoked" })]), refused: "revoked" },
    { held: inNetwork([device("full-access", { access: "full-access" })]) },
    // This app's own grant, not the network, is what lacks the scope.
    {
      held: inNetwork([device("full-access", { access: "full-access" })]),
      remote: ["read"],
      refused: "on this device does not include send",
    },
    // A caller the roster there does not list, such as one reached by code, keeps its grant.
    { held: inNetwork([]) },
    { held: { selfMember: null, devices: [] } },
    // A roster push that fails is followed again, not dropped for the rest of the relay.
    {
      held: inNetwork([device("read-only", { access: "read-only" })]),
      failsFirst: true,
      refused: "read-only",
    },
    // With no pushed roster yet, one is read; a failed read lets it do nothing.
    { read: inNetwork([device("full-access", { access: "full-access" })]) },
    { read: undefined, refused: "could not be read" },
  ];
  for (const { held, read, remote, failsFirst, refused } of cases as ReadonlyArray<{
    held?: object;
    read?: object;
    remote?: ReadonlyArray<string>;
    failsFirst?: boolean;
    refused?: string;
  }>) {
    const sent = refused === undefined;
    let rosterAttempts = 0;
    const answered = Promise.withResolvers<unknown>();
    const pushed = Promise.withResolvers<void>();
    if (held === undefined) pushed.resolve();
    const session = {
      client: {
        [WS_METHODS.mcpGatewayRespond]: (response: unknown) =>
          Effect.sync(() => answered.resolve(response)),
      },
    };
    const reads = vi.fn(() => (read === undefined ? Effect.fail("offline") : Effect.succeed(read)));
    const follows = new Map<string, number>();
    const registry = {
      run: reads,
      // Each environment's relay subscription comes first, then its roster's.
      followStream: (environmentId: string) => {
        const count = follows.get(environmentId) ?? 0;
        follows.set(environmentId, count + 1);
        if (count % 2 === 1) {
          return environmentId === "remote" && held !== undefined
            ? Stream.suspend(() =>
                failsFirst === true && rosterAttempts++ === 0
                  ? Stream.fail("dropped")
                  : Stream.make(held).pipe(
                      Stream.concat(
                        Stream.fromEffect(Effect.sync(() => pushed.resolve())).pipe(Stream.drain),
                      ),
                      Stream.concat(Stream.never),
                    ),
              )
            : Stream.never;
        }
        return environmentId !== "caller"
          ? Stream.never
          : Stream.fromEffect(Effect.promise(() => pushed.promise)).pipe(
              Stream.as([
                session,
                {
                  type: "invoke",
                  connectionId: "connection",
                  invocationId: "invocation",
                  method: "sendMessage",
                  args: [{ environmentId: "remote", threadId: "thread", text: "hi" }],
                  modeCeiling: FULL,
                },
              ] as const),
              Stream.concat(Stream.never),
            );
      },
    } as unknown as EnvironmentRegistry["Service"];
    const sendMessage = vi.fn(async () => ({ status: "accepted" }));
    const stop = serveGatewayPortRelays(
      Context.make(EnvironmentRegistry, registry).pipe(
        Context.add(RosterRetrySchedule, Schedule.forever),
      ),
      { sendMessage, getThread: async () => fullThread } as unknown as GatewayRuntimePort,
      { caller: ["read", "send"], remote: remote ?? ["read", "send"] } as GatewayGrants,
      () => undefined,
    );
    const response = await answered.promise;
    stop();
    expect({
      held,
      read,
      sent: sendMessage.mock.calls.length,
      reads: reads.mock.calls.length,
    }).toEqual({ held, read, sent: sent ? 1 : 0, reads: held === undefined ? 1 : 0 });
    expect(response).toEqual(
      sent
        ? expect.not.objectContaining({ error: expect.anything() })
        : expect.objectContaining({ error: expect.stringContaining(refused) }),
    );
  }
});

it("refuses to serve more grants than a server accepts, once and visibly", () => {
  const followStream = vi.fn(() => Stream.never);
  const failures: Array<unknown> = [];
  const grants = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`env-${index}`, ["read"] as const]),
  );
  const stop = serveGatewayPortRelays(
    Context.make(EnvironmentRegistry, {
      followStream,
    } as unknown as EnvironmentRegistry["Service"]),
    {} as GatewayRuntimePort,
    grants,
    (error) => failures.push(error),
  );
  stop();
  expect(followStream).not.toHaveBeenCalled();
  expect(failures).toEqual([new Error(relayGrantsProblem(grants))]);
  expect(relayGrantsProblem(grants)).toContain("256");
  expect(relayGrantsProblem({ remote: ["read"] })).toBeUndefined();
});
