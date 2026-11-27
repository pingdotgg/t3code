// @effect-diagnostics nodeBuiltinImport:off -- These probes run before the CLI runtime loads.
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const canBind = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });

// macOS permits this bind over a wildcard listener, so also check loopback connectivity.
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

export async function pickSshPort(portFile: string, defaultPort: number, scanWindow: number) {
  const raw = NodeFS.existsSync(portFile) ? NodeFS.readFileSync(portFile, "utf8").trim() : "";
  const preferred = Number.parseInt(raw, 10);
  const start = Number.isInteger(preferred) ? preferred : defaultPort;
  for (let port = start; port < start + scanWindow; port += 1) {
    if ((await canBind(port)) && !(await answersOnLoopback(port))) return port;
  }
  return undefined;
}

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

/** Exits 0 once the server answers 2xx; 2 means nothing ever listened on the port. */
export async function waitForSshServer(port: number, timeoutMs: number, probeTimeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let refusedOnly = true;
  while (Date.now() < deadline) {
    const result = await probe(port, probeTimeoutMs);
    if (result === "ready") return 0;
    refusedOnly &&= result === "refused";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return refusedOnly ? 2 : 1;
}

/** `<pid> <port>` for a live default-home server, or undefined. */
export function readSshRuntimePort(runtimeFile: string) {
  try {
    // Mirrors the shell snippet's loose parse.
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
}

const positiveInteger = (value: string | undefined) =>
  value !== undefined && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

/**
 * Runs the launch script's exact `__ssh-helper` probe calls without loading the CLI. Returns
 * false for anything else, including help and arguments the CLI would reject, so it parses them.
 */
export async function tryRunSshProbe(args: ReadonlyArray<string>) {
  const [command, first, second, third] = args;
  if (command === "runtime-port" && args.length === 2 && first && !first.startsWith("-")) {
    const result = readSshRuntimePort(first);
    if (result === undefined) process.exitCode = 1;
    else process.stdout.write(result);
    return true;
  }
  if (
    command === "pick-port" &&
    args.length === 4 &&
    first &&
    !first.startsWith("-") &&
    positiveInteger(second) &&
    positiveInteger(third) &&
    Number(second) + Number(third) <= 65_536
  ) {
    const port = await pickSshPort(first, Number(second), Number(third));
    if (port === undefined) process.exitCode = 1;
    else process.stdout.write(String(port));
    return true;
  }
  if (
    command === "wait-ready" &&
    args.length === 4 &&
    positiveInteger(first) &&
    Number(first) <= 65_535 &&
    positiveInteger(second) &&
    positiveInteger(third)
  ) {
    process.exitCode = await waitForSshServer(Number(first), Number(second), Number(third));
    return true;
  }
  return false;
}
