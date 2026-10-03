// @effect-diagnostics nodeBuiltinImport:off - the tunnel is plain sockets and pipes.
import type * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import type { SandboxPort } from "@t3tools/contracts";

/**
 * Network bridge between the server host and one sandbox container.
 *
 * A relay script runs inside the container under `docker exec -i` and talks
 * to the host over its stdin and stdout with small frames. One relay carries
 * every connection in both directions:
 *
 * - Ports apps open inside the container get a listener on the host's
 *   loopback, so previews reach them. The relay reports listening ports by
 *   reading `/proc/net/tcp`, so any port works without publishing it up front.
 * - Reverse ports listen on the container's loopback and connect back to the
 *   same port on the host's loopback. Agents use this to reach T3's MCP
 *   endpoint at the same `127.0.0.1` URL they would use outside a sandbox.
 *
 * Only the Docker CLI is involved, so the same code works with Docker Engine
 * on Linux and Docker Desktop on macOS, where container IPs are not routable.
 *
 * Frame: type (u8), connection id (u32), payload length (u32), payload.
 * Host-opened connections use even ids and relay-opened ones odd ids.
 */
const FRAME = {
  connect: 1,
  accepted: 2,
  data: 3,
  end: 4,
  close: 5,
  ports: 6,
  listen: 7,
  error: 8,
} as const;

const HEADER_BYTES = 9;

/**
 * Runs inside the container with `node -e <source> [proc-root]`. Exits when
 * the host closes its stdin. Tests pass a fake proc root.
 */
export const SANDBOX_RELAY_SOURCE = String.raw`"use strict";
const net = require("net");
const fs = require("fs");
const T = { CONNECT: 1, ACCEPTED: 2, DATA: 3, END: 4, CLOSE: 5, PORTS: 6, LISTEN: 7, ERROR: 8 };
const sockets = new Map();
const pending = new Map();
const relayPorts = new Set();
let nextId = 1;
let paused = false;
let lastPorts = "";
const procRoot = process.argv[1] || "/proc";
function send(type, id, payload) {
  const body = payload || Buffer.alloc(0);
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(body.length, 5);
  if (!process.stdout.write(Buffer.concat([header, body])) && !paused) {
    paused = true;
    for (const socket of sockets.values()) socket.pause();
    process.stdout.once("drain", () => {
      paused = false;
      for (const socket of sockets.values()) socket.resume();
    });
  }
}
function port16(port) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16BE(port, 0);
  return buffer;
}
function attach(id, socket) {
  sockets.set(id, socket);
  if (paused) socket.pause();
  socket.on("data", (chunk) => send(T.DATA, id, chunk));
  socket.on("end", () => send(T.END, id));
  socket.on("error", () => {});
  socket.on("close", () => {
    if (sockets.delete(id)) send(T.CLOSE, id);
  });
}
function writeTo(socket, chunk) {
  if (socket.write(chunk)) return;
  process.stdin.pause();
  const resume = () => {
    socket.off("drain", resume);
    socket.off("close", resume);
    process.stdin.resume();
  };
  socket.on("drain", resume);
  socket.on("close", resume);
}
function connectLocal(id, port) {
  const entry = { chunks: [], ended: false, closed: false };
  pending.set(id, entry);
  const attempt = (hosts) => {
    const socket = net.connect({ host: hosts[0], port });
    const onError = () => {
      if (entry.closed) return;
      if (hosts.length > 1) return attempt(hosts.slice(1));
      pending.delete(id);
      send(T.CLOSE, id);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      pending.delete(id);
      if (entry.closed) return socket.destroy();
      for (const chunk of entry.chunks) socket.write(chunk);
      if (entry.ended) socket.end();
      attach(id, socket);
    });
  };
  attempt(["127.0.0.1", "::1"]);
}
function listen(port, host) {
  relayPorts.add(port);
  const server = net.createServer((socket) => {
    const id = nextId;
    nextId += 2;
    send(T.ACCEPTED, id, port16(port));
    attach(id, socket);
  });
  server.on("error", (error) =>
    send(T.ERROR, 0, Buffer.from("listen " + port + ": " + error.message)),
  );
  server.listen(port, host);
}
function scanPorts() {
  const ports = new Set();
  for (const file of [procRoot + "/net/tcp", procRoot + "/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4 || columns[3] !== "0A") continue;
      const port = parseInt(columns[1].split(":")[1], 16);
      if (port > 0 && !relayPorts.has(port)) ports.add(port);
    }
  }
  const list = [...ports].sort((a, b) => a - b);
  const key = list.join(",");
  if (key === lastPorts) return;
  lastPorts = key;
  send(T.PORTS, 0, Buffer.from(JSON.stringify(list)));
}
function handle(type, id, payload) {
  if (type === T.CONNECT) return connectLocal(id, payload.readUInt16BE(0));
  if (type === T.LISTEN) return listen(payload.readUInt16BE(0), payload.toString("utf8", 2));
  const socket = sockets.get(id);
  const entry = pending.get(id);
  if (type === T.DATA) {
    if (socket) writeTo(socket, payload);
    else if (entry) entry.chunks.push(Buffer.from(payload));
  } else if (type === T.END) {
    if (socket) socket.end();
    else if (entry) entry.ended = true;
  } else if (type === T.CLOSE) {
    if (socket) {
      sockets.delete(id);
      socket.destroy();
    } else if (entry) {
      entry.closed = true;
      pending.delete(id);
    }
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  while (buffer.length >= 9) {
    const length = buffer.readUInt32BE(5);
    if (buffer.length < 9 + length) break;
    const type = buffer.readUInt8(0);
    const id = buffer.readUInt32BE(1);
    const payload = buffer.subarray(9, 9 + length);
    buffer = buffer.subarray(9 + length);
    handle(type, id, payload);
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(scanPorts, 1500);
scanPorts();
`;

/**
 * Runs inside the container with `node -e <source> <exec-id>`. Kills every
 * process in the session of a command started through the sandbox exec
 * launcher, or of every recorded command with `--all`. Killing a `docker exec`
 * client leaves its process running in the container, so this is how commands
 * stop. Each exec leads its own session, and children keep that session even
 * after their parent exits, so none escape. A record whose leader is alive
 * with a different start time belongs to a reused PID and is skipped.
 */
export const SANDBOX_KILL_SOURCE = String.raw`"use strict";
const fs = require("fs");
const dir = "/tmp/.t3-exec";
const target = process.argv[1];
let ids = [target];
if (target === "--all") {
  try {
    ids = fs.readdirSync(dir);
  } catch {
    ids = [];
  }
}
const stat = (pid) => {
  try {
    const text = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { session: Number(fields[3]), start: fields[19] };
  } catch {
    return null;
  }
};
const sessions = new Set();
for (const id of ids) {
  try {
    const [pid, start] = fs.readFileSync(dir + "/" + id, "utf8").trim().split(" ");
    fs.unlinkSync(dir + "/" + id);
    const leader = stat(pid);
    if (Number(pid) > 1 && (leader === null || leader.start === start)) sessions.add(Number(pid));
  } catch {}
}
const pids = [];
for (const entry of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  const info = stat(entry);
  if (info !== null && sessions.has(info.session)) pids.push(Number(entry));
}
const signal = (name) =>
  pids.filter((pid) => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  }).length;
if (signal("SIGTERM") > 0) setTimeout(() => signal("SIGKILL"), 2000);
`;

/**
 * Wraps a command so the container records its PID and start time under the
 * exec id before running it. `SANDBOX_KILL_SOURCE` uses that record to stop
 * it later. The launcher is `sh`, whose stat line has no spaces before field 22.
 */
export const sandboxExecLauncherArgs = (
  execId: string,
  command: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "/bin/sh",
  "-c",
  'mkdir -p /tmp/.t3-exec && echo "$$ $(cut -d" " -f22 /proc/$$/stat)" > "/tmp/.t3-exec/$0" && exec "$@"',
  execId,
  command,
  ...args,
];

export interface SandboxTunnelOptions {
  /** Starts the relay: `docker exec -i <container> node -e SANDBOX_RELAY_SOURCE`. */
  readonly spawnRelay: () => NodeChildProcess.ChildProcessWithoutNullStreams;
  /**
   * Loopback addresses that listen inside the container and connect back to
   * the same address on the host, normally on the same port.
   */
  readonly reversePorts: ReadonlyArray<{
    readonly host: string;
    readonly containerPort: number;
    readonly hostPort: number;
  }>;
  /** Host port to try first for a container port, so URLs stay stable across restarts. */
  readonly preferredHostPort: (containerPort: number) => number;
  readonly onPortsChanged: (ports: ReadonlyArray<SandboxPort>) => void;
  readonly onExit: (detail: string) => void;
}

interface Forwarder {
  readonly server: NodeNet.Server;
  hostPort: number | null;
}

interface PendingHostConnection {
  readonly chunks: Array<Buffer>;
  ended: boolean;
  closed: boolean;
}

/** Host side of the relay. Call `close` to stop it; `onExit` fires once either way. */
export class SandboxTunnel {
  private readonly relay: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly sockets = new Map<number, NodeNet.Socket>();
  private readonly pendingHost = new Map<number, PendingHostConnection>();
  private readonly forwarders = new Map<number, Forwarder>();
  private nextId = 2;
  private paused = false;
  private exited = false;
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private readonly options: SandboxTunnelOptions;

  constructor(options: SandboxTunnelOptions) {
    this.options = options;
    this.relay = options.spawnRelay();
    this.relay.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.relay.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-500);
    });
    this.relay.stdin.on("error", () => {});
    this.relay.on("error", (error) => this.shutdown(`relay failed to start: ${error.message}`));
    this.relay.on("exit", (code, signal) =>
      this.shutdown(
        `relay exited (${signal ?? code ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`,
      ),
    );
    for (const { host, containerPort } of options.reversePorts) {
      this.send(FRAME.listen, 0, Buffer.concat([port16(containerPort), Buffer.from(host)]));
    }
  }

  /** Forwarded ports that currently have a host listener. */
  get ports(): ReadonlyArray<SandboxPort> {
    const ports: Array<SandboxPort> = [];
    for (const [containerPort, forwarder] of this.forwarders) {
      if (forwarder.hostPort !== null) ports.push({ containerPort, hostPort: forwarder.hostPort });
    }
    return ports.toSorted((left, right) => left.containerPort - right.containerPort);
  }

  get alive(): boolean {
    return !this.exited;
  }

  close(): void {
    this.relay.stdin.end();
    this.relay.kill("SIGTERM");
    this.shutdown("closed");
  }

  private shutdown(detail: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    this.pendingHost.clear();
    for (const forwarder of this.forwarders.values()) forwarder.server.close();
    this.forwarders.clear();
    this.options.onExit(detail);
  }

  private send(type: number, id: number, payload: Buffer = Buffer.alloc(0)): void {
    if (this.exited) return;
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(id, 1);
    header.writeUInt32BE(payload.length, 5);
    if (!this.relay.stdin.write(Buffer.concat([header, payload])) && !this.paused) {
      this.paused = true;
      for (const socket of this.sockets.values()) socket.pause();
      this.relay.stdin.once("drain", () => {
        this.paused = false;
        for (const socket of this.sockets.values()) socket.resume();
      });
    }
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(5);
      if (this.buffer.length < HEADER_BYTES + length) return;
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = Buffer.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      this.handle(type, id, payload);
    }
  }

  private handle(type: number, id: number, payload: Buffer): void {
    switch (type) {
      case FRAME.ports:
        this.syncForwarders(parsePorts(payload));
        return;
      case FRAME.accepted:
        this.connectHost(id, payload.readUInt16BE(0));
        return;
      case FRAME.error:
        // Reverse listeners only fail when the port is taken inside the
        // container; the agent then cannot reach MCP, which it reports itself.
        return;
    }
    const socket = this.sockets.get(id);
    const pending = this.pendingHost.get(id);
    if (type === FRAME.data) {
      if (socket) this.writeTo(socket, payload);
      else pending?.chunks.push(payload);
    } else if (type === FRAME.end) {
      if (socket) socket.end();
      else if (pending) pending.ended = true;
    } else if (type === FRAME.close) {
      if (socket) {
        this.sockets.delete(id);
        socket.destroy();
      } else if (pending) {
        pending.closed = true;
        this.pendingHost.delete(id);
      }
    }
  }

  private writeTo(socket: NodeNet.Socket, chunk: Buffer): void {
    if (socket.write(chunk)) return;
    this.relay.stdout.pause();
    const resume = () => {
      socket.off("drain", resume);
      socket.off("close", resume);
      this.relay.stdout.resume();
    };
    socket.on("drain", resume);
    socket.on("close", resume);
  }

  private attach(id: number, socket: NodeNet.Socket): void {
    this.sockets.set(id, socket);
    if (this.paused) socket.pause();
    socket.on("data", (chunk: Buffer) => this.send(FRAME.data, id, chunk));
    socket.on("end", () => this.send(FRAME.end, id));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.sockets.delete(id)) this.send(FRAME.close, id);
    });
  }

  /** A connection opened inside the container on a reverse port. */
  private connectHost(id: number, containerPort: number): void {
    const target = this.options.reversePorts.find((entry) => entry.containerPort === containerPort);
    if (target === undefined) return this.send(FRAME.close, id);
    const pending: PendingHostConnection = { chunks: [], ended: false, closed: false };
    this.pendingHost.set(id, pending);
    const socket = NodeNet.connect({ host: target.host, port: target.hostPort });
    socket.once("error", () => {
      if (this.pendingHost.delete(id)) this.send(FRAME.close, id);
    });
    socket.once("connect", () => {
      this.pendingHost.delete(id);
      if (pending.closed || this.exited) return void socket.destroy();
      for (const chunk of pending.chunks) socket.write(chunk);
      if (pending.ended) socket.end();
      this.attach(id, socket);
    });
  }

  private syncForwarders(containerPorts: ReadonlyArray<number>): void {
    const wanted = new Set(containerPorts);
    let changed = false;
    for (const [containerPort, forwarder] of this.forwarders) {
      if (wanted.has(containerPort)) continue;
      forwarder.server.close();
      this.forwarders.delete(containerPort);
      changed = true;
    }
    for (const containerPort of wanted) {
      if (this.forwarders.has(containerPort)) continue;
      this.openForwarder(containerPort);
    }
    if (changed) this.options.onPortsChanged(this.ports);
  }

  private openForwarder(containerPort: number): void {
    const server = NodeNet.createServer((socket) => {
      const id = this.nextId;
      this.nextId += 2;
      this.send(FRAME.connect, id, port16(containerPort));
      this.attach(id, socket);
    });
    const forwarder: Forwarder = { server, hostPort: null };
    this.forwarders.set(containerPort, forwarder);
    const listen = (port: number) => server.listen(port, "127.0.0.1");
    server.on("listening", () => {
      const address = server.address();
      if (this.forwarders.get(containerPort) !== forwarder || typeof address !== "object") return;
      forwarder.hostPort = address?.port ?? null;
      this.options.onPortsChanged(this.ports);
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      // The stable port is taken: fall back to any free port once.
      if (error.code === "EADDRINUSE" && forwarder.hostPort === null) listen(0);
    });
    listen(this.options.preferredHostPort(containerPort));
  }
}

function port16(port: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16BE(port, 0);
  return buffer;
}

function parsePorts(payload: Buffer): ReadonlyArray<number> {
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536)
      : [];
  } catch {
    return [];
  }
}
