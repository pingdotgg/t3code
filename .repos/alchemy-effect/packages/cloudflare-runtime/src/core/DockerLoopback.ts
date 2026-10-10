import * as NodeChild from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/**
 * Hostname rewritten into container env so loopback still looks local
 * (Prisma's `prisma+postgres://` plain-HTTP gate). Mapped in the sidecar
 * ExtraHosts — to `127.0.0.1` on native Linux (unix-socket tunnel) or
 * Docker `host-gateway` on Docker Desktop.
 */
export const CONTAINER_LOOPBACK_ALIAS = "host.docker.localhost";

/** Bind-mount target inside the workerd `<name>-proxy` sidecar. */
export const CONTAINER_LOOPBACK_MOUNT = "/alchemy/host-loopback";

const LOOPBACK_HOST_IN_VALUE =
  /(?:^|[\s,;=]|\/\/(?:[^/\s@]*@)?)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.localhost)(?=[:/?#]|[\s,;]|$)/i;

const LOOPBACK_HOST_PORT =
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.localhost):(\d{1,5})\b/gi;

const DSN_PORT = /(?:^|[\s;])port=(\d{1,5})\b/gi;

const unixServers = new Map<number, NodeNet.Server>();
const netnsForwarders = new Map<string, NodeChild.ChildProcess>();

/**
 * Native Linux Docker: a SYN to `host-gateway` (bridge IP) is host INPUT
 * and UFW/nftables can drop it. Docker Desktop's gateway already reaches
 * host loopback, so the unix-socket path is Linux-only.
 */
export const usesUnixSocketLoopback = () => process.platform === "linux";

const nsenterAvailable = () => {
  try {
    const result = NodeChild.spawnSync("nsenter", ["--version"], {
      encoding: "utf8",
    });
    return result.error === undefined;
  } catch {
    return false;
  }
};

export const loopbackSocketDir = () =>
  NodePath.join(NodeOs.tmpdir(), "alchemy-dev-loopback");

const addPort = (ports: Set<number>, raw: string) => {
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
};

/**
 * Ports a container will dial if this env value is a loopback URL / DSN.
 * Empty when the value is not loopback (Neon, PlanetScale, …).
 */
export const loopbackPortsFromEnvValue = (value: string): number[] => {
  if (!LOOPBACK_HOST_IN_VALUE.test(value)) return [];
  LOOPBACK_HOST_IN_VALUE.lastIndex = 0;
  const ports = new Set<number>();
  for (const match of value.matchAll(LOOPBACK_HOST_PORT)) {
    if (match[1] !== undefined) addPort(ports, match[1]);
  }
  for (const match of value.matchAll(DSN_PORT)) {
    if (match[1] !== undefined) addPort(ports, match[1]);
  }
  return [...ports];
};

export const loopbackPortsFromEnv = (
  env: Record<string, string> | ReadonlyArray<string> | undefined,
): number[] => {
  const ports = new Set<number>();
  if (env === undefined) return [];
  const values = Array.isArray(env)
    ? env.map((entry) => {
        const eq = entry.indexOf("=");
        return eq === -1 ? "" : entry.slice(eq + 1);
      })
    : Object.values(env);
  for (const value of values) {
    for (const port of loopbackPortsFromEnvValue(value)) ports.add(port);
  }
  return [...ports];
};

export const sidecarLoopbackExtraHost = () =>
  usesUnixSocketLoopback()
    ? `${CONTAINER_LOOPBACK_ALIAS}:127.0.0.1`
    : `${CONTAINER_LOOPBACK_ALIAS}:host-gateway`;

export const sidecarLoopbackBinds = (
  ports: readonly number[],
): readonly string[] => {
  if (!usesUnixSocketLoopback() || ports.length === 0) return [];
  return [`${loopbackSocketDir()}:${CONTAINER_LOOPBACK_MOUNT}`];
};

type HostConfig = {
  ExtraHosts?: Array<string>;
  Binds?: Array<string>;
};

export const mergeSidecarLoopbackHostConfig = <T extends HostConfig>(
  original: T | undefined,
  ports: readonly number[],
): T & { ExtraHosts: string[]; Binds?: string[] } => {
  const extraHost = sidecarLoopbackExtraHost();
  const extraHosts = [...(original?.ExtraHosts ?? [])];
  if (!extraHosts.includes(extraHost)) extraHosts.push(extraHost);
  const binds = [...(original?.Binds ?? [])];
  for (const bind of sidecarLoopbackBinds(ports)) {
    if (!binds.includes(bind)) binds.push(bind);
  }
  return {
    ...(original as T),
    ExtraHosts: extraHosts,
    ...(binds.length > 0 ? { Binds: binds } : {}),
  };
};

const pipeSockets = (incoming: NodeNet.Socket, outgoing: NodeNet.Socket) => {
  incoming.pipe(outgoing);
  outgoing.pipe(incoming);
  const fail = () => {
    incoming.destroy();
    outgoing.destroy();
  };
  incoming.on("error", fail);
  outgoing.on("error", fail);
};

const socketPathFor = (port: number) =>
  NodePath.join(loopbackSocketDir(), `${port}.sock`);

const FORWARDER_SOURCE = `\
import * as net from "node:net";
import * as path from "node:path";

const dir = process.argv[2];
const ports = process.argv.slice(3).map(Number).filter((p) => p > 0 && p <= 65535);
if (dir === undefined || ports.length === 0) process.exit(1);

for (const port of ports) {
  const server = net.createServer((incoming) => {
    const outgoing = net.connect(path.join(dir, \`\${port}.sock\`));
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
    const fail = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", fail);
    outgoing.on("error", fail);
  });
  server.listen({ host: "127.0.0.1", port, exclusive: false });
}
`;

const writeForwarderScript = (dir: string) => {
  const file = NodePath.join(dir, "forward.mjs");
  NodeFs.writeFileSync(file, FORWARDER_SOURCE);
  return file;
};

/**
 * Host unix socket per port → `127.0.0.1:port`. The container never SYNs
 * the docker bridge; UFW INPUT is not on this path.
 */
export const ensureLoopbackUnixSockets = (ports: readonly number[]) => {
  if (!usesUnixSocketLoopback()) return;
  const unique = [
    ...new Set(ports.filter((port) => Number.isInteger(port) && port > 0)),
  ];
  if (unique.length === 0) return;
  const dir = loopbackSocketDir();
  NodeFs.mkdirSync(dir, { recursive: true });
  writeForwarderScript(dir);
  for (const port of unique) {
    if (unixServers.has(port)) continue;
    const sock = socketPathFor(port);
    try {
      NodeFs.unlinkSync(sock);
    } catch {
      // no leftover socket
    }
    const server = NodeNet.createServer((incoming) => {
      const outgoing = NodeNet.connect({ host: "127.0.0.1", port });
      pipeSockets(incoming, outgoing);
    });
    server.on("error", () => {
      unixServers.delete(port);
    });
    server.listen(sock);
    unixServers.set(port, server);
  }
};

export const closeLoopbackUnixSockets = () => {
  for (const [port, server] of unixServers) {
    unixServers.delete(port);
    server.close();
    try {
      NodeFs.unlinkSync(socketPathFor(port));
    } catch {
      // already gone
    }
  }
  for (const [id, child] of netnsForwarders) {
    netnsForwarders.delete(id);
    child.kill();
  }
};

export const ufwAllowHint = (ports: readonly number[]) => {
  const portList = ports.length > 0 ? ports.join(",") : "<prisma-or-dev-ports>";
  return `sudo ufw allow from 172.16.0.0/12 to any port ${portList} proto tcp`;
};

/**
 * Listen on `127.0.0.1:<port>` in the sidecar netns and forward through
 * the host unix socket. Only the network namespace is entered so this
 * process still uses the host filesystem (and host bun/node).
 */
export const attachLoopbackNetnsForwarder = (input: {
  keys: readonly string[];
  pid: number;
  ports: readonly number[];
}): { ok: true } | { ok: false; error: string } => {
  if (!usesUnixSocketLoopback()) return { ok: true };
  const ports = [
    ...new Set(
      input.ports.filter((port) => Number.isInteger(port) && port > 0),
    ),
  ];
  if (ports.length === 0) return { ok: true };
  if (input.pid <= 0) {
    return { ok: false, error: "container pid is not available" };
  }
  if (!nsenterAvailable()) {
    return { ok: false, error: "nsenter not found on PATH" };
  }
  const keys = [...new Set(input.keys.filter((key) => key.length > 0))];
  for (const key of keys) {
    netnsForwarders.get(key)?.kill();
  }
  const dir = loopbackSocketDir();
  const script = writeForwarderScript(dir);
  try {
    const child = NodeChild.spawn(
      "nsenter",
      [
        "-t",
        String(input.pid),
        "-n",
        "--",
        process.execPath,
        script,
        dir,
        ...ports.map(String),
      ],
      { stdio: "ignore" },
    );
    child.on("error", () => {
      for (const key of keys) {
        if (netnsForwarders.get(key) === child) netnsForwarders.delete(key);
      }
    });
    child.on("exit", () => {
      for (const key of keys) {
        if (netnsForwarders.get(key) === child) netnsForwarders.delete(key);
      }
    });
    for (const key of keys) netnsForwarders.set(key, child);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
};

export const detachLoopbackNetnsForwarder = (containerId: string) => {
  const child = netnsForwarders.get(containerId);
  if (child === undefined) return;
  netnsForwarders.delete(containerId);
  child.kill();
};

export const isContainerStartPath = (url: string | undefined) =>
  url !== undefined && /\/containers\/[^/]+\/start(?:\?|$)/.test(url);

export const containerIdFromPath = (url: string | undefined) => {
  if (url === undefined) return undefined;
  return /\/containers\/([^/?]+)/.exec(url)?.[1];
};
