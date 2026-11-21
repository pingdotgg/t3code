// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
// The helpers mirror the inline Node snippets the SSH launch script used to
// run, byte for byte in behaviour, so they stay on plain Node APIs.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

/**
 * Helpers the SSH launch script needs on the remote host, where archive-distributed runtimes have
 * no Node. Output and exit codes must match the old `node -` snippets because the script parses
 * them. bin.ts dispatches these before the full CLI graph loads, so keep this module on Node
 * built-ins only; `__ssh-helper` in ./sshHelper.ts wraps the same functions for the full CLI.
 */

const canBind = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });

// macOS lets the bind above succeed while another process listens on
// *:<port>, so also skip any port that already answers on loopback.
const answersOnLoopback = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** The first free loopback port from the preferred one, scanning `scanWindow` ports. */
export const pickPort = async (portFile: string, defaultPort: number, scanWindow: number) => {
  const raw = NodeFS.existsSync(portFile) ? NodeFS.readFileSync(portFile, "utf8").trim() : "";
  const preferred = Number.parseInt(raw, 10);
  const start = Number.isInteger(preferred) ? preferred : defaultPort;
  for (let port = start; port < start + scanWindow; port += 1) {
    if ((await canBind(port)) && !(await answersOnLoopback(port))) return port;
  }
  return undefined;
};

const probe = (port: number, probeTimeoutMs: number) =>
  new Promise<"ready" | "refused" | "not-ready">((resolve) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: probeTimeoutMs },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 200 && status < 300 ? "ready" : "not-ready");
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve("not-ready");
    });
    request.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ECONNREFUSED" ? "refused" : "not-ready"),
    );
  });

/** Whether the loopback server answered 2xx before the deadline, or only ever refused. */
export const waitReady = async (port: number, timeoutMs: number, probeTimeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let refusedOnly = true;
  while (Date.now() < deadline) {
    const result = await probe(port, probeTimeoutMs);
    if (result === "ready") return "ready";
    refusedOnly &&= result === "refused";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return refusedOnly ? "refused" : "not-ready";
};

/** `<pid> <port>` for a live default-home server, or undefined. */
export const runtimePort = (runtimeFile: string) => {
  try {
    const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as {
      pid?: unknown;
      port?: unknown;
      origin?: unknown;
    };
    const pid = Number(runtime.pid);
    const port = Number(runtime.port);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) return undefined;
    const origin = new URL(String(runtime.origin ?? ""));
    if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
      return undefined;
    }
    process.kill(pid, 0);
    return `${pid} ${port}`;
  } catch {
    return undefined;
  }
};

/** Prints the picked port, or exits 1 with no output. */
export const runPickPort = async (portFile: string, defaultPort: number, scanWindow: number) => {
  const port = await pickPort(portFile, defaultPort, scanWindow);
  if (port === undefined) process.exitCode = 1;
  else process.stdout.write(String(port));
};

/** Exits 0 once the loopback server answers; 2 when every probe was refused, else 1. */
export const runWaitReady = async (port: number, timeoutMs: number, probeTimeoutMs: number) => {
  const result = await waitReady(port, timeoutMs, probeTimeoutMs);
  // The launcher reads 2 as "nothing listens on this port".
  if (result !== "ready") process.exitCode = result === "refused" ? 2 : 1;
};

/** Prints `<pid> <port>` for a live default-home server, or exits 1 with no output. */
export const runRuntimePort = (runtimeFile: string) => {
  const output = runtimePort(runtimeFile);
  if (output === undefined) process.exitCode = 1;
  else process.stdout.write(output);
};

// Only shapes that effect/cli parses to the same values qualify: a canonical
// non-negative integer, or a non-empty value that its lexer cannot take for a
// flag. Anything else falls through to the full CLI, which owns the help and
// error output.
const intArg = (value: string | undefined) =>
  value !== undefined && /^(?:0|[1-9]\d{0,14})$/.test(value) ? Number(value) : undefined;
const stringArg = (value: string | undefined) =>
  value !== undefined && value !== "" && !value.startsWith("-") ? value : undefined;

const match = (args: ReadonlyArray<string>): (() => Promise<void>) | undefined => {
  const [subcommand, ...rest] = args;
  if (subcommand === "runtime-port" && rest.length === 1) {
    const runtimeFile = stringArg(rest[0]);
    if (runtimeFile === undefined) return undefined;
    return async () => runRuntimePort(runtimeFile);
  }
  if (subcommand === "wait-ready" && rest.length === 3) {
    const [port, timeoutMs, probeTimeoutMs] = rest.map(intArg);
    if (port === undefined || timeoutMs === undefined || probeTimeoutMs === undefined) {
      return undefined;
    }
    return () => runWaitReady(port, timeoutMs, probeTimeoutMs);
  }
  if (subcommand === "pick-port" && rest.length === 3) {
    const portFile = stringArg(rest[0]);
    const defaultPort = intArg(rest[1]);
    const scanWindow = intArg(rest[2]);
    if (portFile === undefined || defaultPort === undefined || scanWindow === undefined) {
      return undefined;
    }
    return () => runPickPort(portFile, defaultPort, scanWindow);
  }
  return undefined;
};

/**
 * The helper run for `__ssh-helper <args>` when the arguments have exactly the
 * shape the launch script sends, else undefined. The run exits 130 on SIGINT
 * or SIGTERM, as the effect runtime does when it interrupts the full CLI.
 */
export const matchSshHelperFastPath = (args: ReadonlyArray<string>) => {
  const run = match(args);
  if (run === undefined) return undefined;
  return async () => {
    const onSignal = () => process.exit(130);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await run();
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  };
};
