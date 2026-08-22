import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

import { makeConnectTarget } from "./TcpForwardBridge.ts";

const createSocket = (result: "connect" | "error") => {
  const socket = new NodeNet.Socket();
  queueMicrotask(() => {
    if (result === "connect") socket.emit("connect");
    else socket.emit("error", new Error("connection refused"));
  });
  return socket;
};

it("connects to IPv6 loopback when the IPv4 loopback target is unavailable", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket(host === "::1" ? "connect" : "error");
  });

  const target = await Effect.runPromise(makeConnectTarget(createConnection)("127.0.0.1", 5173));

  expect(attemptedHosts).toEqual(["127.0.0.1", "::1"]);
  expect(createConnection).toHaveBeenCalledWith({
    host: "127.0.0.1",
    port: 5173,
    allowHalfOpen: true,
  });
  expect(createConnection).toHaveBeenCalledWith({ host: "::1", port: 5173, allowHalfOpen: true });
  target.destroy();
});

it("keeps IPv4 loopback as the first target when it is available", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("connect");
  });

  const target = await Effect.runPromise(makeConnectTarget(createConnection)("127.0.0.1", 5173));

  expect(attemptedHosts).toEqual(["127.0.0.1"]);
  target.destroy();
});

it("fails after both loopback addresses are unavailable", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("error");
  });

  await expect(
    Effect.runPromise(makeConnectTarget(createConnection)("127.0.0.1", 5173)),
  ).rejects.toBeDefined();
  expect(attemptedHosts).toEqual(["127.0.0.1", "::1"]);
});

it("does not expand non-loopback targets to IPv6 loopback", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("error");
  });

  await expect(
    Effect.runPromise(makeConnectTarget(createConnection)("192.0.2.1", 5173)),
  ).rejects.toBeDefined();
  expect(attemptedHosts).toEqual(["192.0.2.1"]);
});
