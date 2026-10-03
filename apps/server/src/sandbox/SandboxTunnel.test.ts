// @effect-diagnostics nodeBuiltinImport:off - drives the real relay script over sockets and pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SandboxPort } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SANDBOX_RELAY_SOURCE, SandboxTunnel } from "./SandboxTunnel.ts";

// The relay normally runs in the container's network namespace. Here it runs
// on the host against a fake /proc, so forwarded and reverse ports must differ.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

const listenEcho = (prefix: string) =>
  new Promise<NodeNet.Server>((resolve) => {
    const server = NodeNet.createServer((socket) =>
      socket.on("data", (chunk) => socket.write(`${prefix}${chunk.toString("utf8")}`)),
    );
    cleanups.push(() => server.close());
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const portOf = (server: NodeNet.Server) => {
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("no address");
  return address.port;
};

const freePort = async () => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const fakeProcRoot = (listeningPorts: ReadonlyArray<number>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-proc-"));
  cleanups.push(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  NodeFS.mkdirSync(NodePath.join(root, "net"));
  const rows = listeningPorts.map(
    (port, index) =>
      `   ${index}: 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0`,
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "net", "tcp"),
    ["  sl  local_address rem_address   st", ...rows].join("\n"),
  );
  return root;
};

const roundTrip = (port: number, message: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => socket.write(message));
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(chunk.toString("utf8"));
    });
    socket.once("error", reject);
  });

describe("SandboxTunnel", () => {
  it("forwards listening container ports to host loopback and reverse ports back", async () => {
    const app = await listenEcho("app:");
    const mcp = await listenEcho("mcp:");
    const reverseContainerPort = await freePort();
    const procRoot = fakeProcRoot([portOf(app)]);

    let resolvePorts: (ports: ReadonlyArray<SandboxPort>) => void = () => {};
    const portsReady = new Promise<ReadonlyArray<SandboxPort>>((resolve) => {
      resolvePorts = resolve;
    });
    const exits: Array<string> = [];
    const tunnel = new SandboxTunnel({
      spawnRelay: () =>
        NodeChildProcess.spawn(process.execPath, ["-e", SANDBOX_RELAY_SOURCE, procRoot], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
      reversePorts: [
        { host: "127.0.0.1", containerPort: reverseContainerPort, hostPort: portOf(mcp) },
      ],
      preferredHostPort: () => 0,
      onPortsChanged: (ports) => {
        if (ports.length > 0) resolvePorts(ports);
      },
      onExit: (detail) => exits.push(detail),
    });
    cleanups.push(() => tunnel.close());

    const [forwarded] = await portsReady;
    expect(forwarded?.containerPort).toBe(portOf(app));
    expect(forwarded?.hostPort).not.toBe(portOf(app));
    expect(await roundTrip(forwarded!.hostPort, "hello")).toBe("app:hello");
    expect(await roundTrip(reverseContainerPort, "tools")).toBe("mcp:tools");

    tunnel.close();
    expect(tunnel.alive).toBe(false);
    expect(exits).toEqual(["closed"]);
  });

  it("reports the relay exiting on its own", async () => {
    let resolveExit: (detail: string) => void = () => {};
    const exited = new Promise<string>((resolve) => {
      resolveExit = resolve;
    });
    const tunnel = new SandboxTunnel({
      spawnRelay: () =>
        NodeChildProcess.spawn(process.execPath, ["-e", "process.exit(3)"], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
      reversePorts: [],
      preferredHostPort: () => 0,
      onPortsChanged: () => {},
      onExit: resolveExit,
    });
    expect(await exited).toContain("relay exited (3)");
    expect(tunnel.alive).toBe(false);
  });
});
