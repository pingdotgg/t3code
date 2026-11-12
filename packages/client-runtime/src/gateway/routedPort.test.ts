import { describe, expect, it } from "@effect/vitest";

import type { GatewayRuntimePort } from "./port.ts";
import { answerGatewayPortCall } from "./portRelay.ts";
import { createRoutedGatewayPort } from "./routedPort.ts";

const environment = (environmentId: string) => ({
  environmentId,
  label: environmentId,
  targetKind: "primary",
  connectionState: "connected",
});

const fakePort = (name: string, calls: Array<string>) =>
  ({
    listEnvironments: async () => [environment(name)],
    listProjects: async (environmentId: string) => {
      calls.push(`${name}:listProjects:${environmentId}`);
      return { items: [], snapshotAt: name };
    },
    handoffThread: async () => {
      calls.push(`${name}:handoffThread`);
      return {};
    },
  }) as unknown as GatewayRuntimePort;

describe("createRoutedGatewayPort", () => {
  it("runs this environment's calls locally and relays the rest", async () => {
    const calls: Array<string> = [];
    const relayed: Array<[string, ReadonlyArray<string>]> = [];
    const port = createRoutedGatewayPort("local", fakePort("local", calls), () => ({
      invoke: async (method, _args, environmentIds) => {
        relayed.push([method, environmentIds]);
        return method === "listEnvironments" ? [environment("local"), environment("remote")] : {};
      },
    }));

    await port.listProjects("local");
    await port.listProjects("remote");
    await port.handoffThread!({
      sourceEnvironmentId: "local",
      environmentId: "remote",
    } as Parameters<NonNullable<GatewayRuntimePort["handoffThread"]>>[0]);
    const environments = await port.listEnvironments();

    expect(calls).toEqual(["local:listProjects:local"]);
    expect(relayed).toEqual([
      ["listProjects", ["remote"]],
      ["handoffThread", ["remote", "local"]],
      ["listEnvironments", []],
    ]);
    expect(environments.map((item) => item.environmentId)).toEqual(["local", "remote"]);
  });

  it("keeps an agent's task call on its own server and relays only user calls", async () => {
    const received: Array<[string, ReadonlyArray<unknown>]> = [];
    const local = {
      ...fakePort("local", []),
      threadTask: async (...args: ReadonlyArray<unknown>) => {
        received.push(["local", args]);
        return {};
      },
    } as unknown as GatewayRuntimePort;
    const port = createRoutedGatewayPort("local", local, () => ({
      invoke: async (_method, args) => {
        received.push(["relay", args]);
        return {};
      },
    }));
    const caller = { environmentId: "local", threadId: "chat" };
    const request = { action: "read", input: {} } as const;

    await port.threadTask!("local", request, caller);
    // Relayed, the agent would arrive as the user; its own server reaches the peer instead.
    await port.threadTask!("remote", request, caller);
    await port.threadTask!("remote", request);

    expect(received).toEqual([
      ["local", ["local", request, caller]],
      ["local", ["remote", request, caller]],
      ["relay", ["remote", request]],
    ]);
  });

  it("explains that other environments need a connected app", async () => {
    const port = createRoutedGatewayPort("local", fakePort("local", []), () => undefined);
    await expect(port.listProjects("remote")).rejects.toThrow("not reachable from this chat");
    expect((await port.listEnvironments()).map((item) => item.environmentId)).toEqual(["local"]);
  });
});

describe("answerGatewayPortCall", () => {
  it("drops a calling chat from a relayed task call", async () => {
    const received: Array<ReadonlyArray<unknown>> = [];
    const port = {
      threadTask: async (...args: ReadonlyArray<unknown>) => {
        received.push(args);
        return {};
      },
      listEnvironments: async () => [environment("a")],
    } as unknown as GatewayRuntimePort;
    const request = { action: "read", input: {} };
    await answerGatewayPortCall(port, { a: ["read"] }, "threadTask", [
      "a",
      request,
      { environmentId: "a", threadId: "owner" },
    ]);
    expect(received).toEqual([["a", request]]);
  });

  it("answers only for granted environments", async () => {
    const calls: Array<string> = [];
    const port = {
      ...fakePort("app", calls),
      listEnvironments: async () => [environment("a"), environment("b"), environment("c")],
    } as GatewayRuntimePort;
    const granted = { a: ["read", "create", "send", "artifact"], b: ["read"] } as const;

    expect(
      (
        (await answerGatewayPortCall(port, granted, "listEnvironments", [])) as Array<{
          environmentId: string;
        }>
      ).map((item) => item.environmentId),
    ).toEqual(["a", "b"]);
    await answerGatewayPortCall(port, granted, "listProjects", ["a"]);
    await expect(answerGatewayPortCall(port, granted, "listProjects", ["c"])).rejects.toThrow(
      "not granted for c",
    );
    await expect(
      answerGatewayPortCall(port, granted, "handoffThread", [
        { sourceEnvironmentId: "c", environmentId: "a" },
      ]),
    ).rejects.toThrow("not granted for c");
    await expect(answerGatewayPortCall(port, granted, "toString", ["a"])).rejects.toThrow(
      "Unknown T3 Agents call",
    );
    expect(calls).toEqual(["app:listProjects:a"]);
  });
});
