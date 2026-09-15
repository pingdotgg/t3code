// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// The helpers mirror the inline Node snippets the SSH launch script used to
// run, byte for byte in behaviour, so they stay on plain Node APIs.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

/**
 * Small helpers the SSH launch script needs on the remote host. The script
 * used to run these as inline `node -` snippets; archive-distributed runtimes
 * have no Node on the remote, so the executable provides them instead. Output
 * and exit codes match the snippets exactly because the shell script parses
 * them.
 */

const tryPort = (port: number) =>
  new Promise<number | false>((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });

/** Prints the first free loopback port from the preferred one, scanning `window` ports. */
const pickPort = Command.make("pick-port", {
  portFile: Argument.string("port-file"),
  defaultPort: Argument.integer("default-port"),
  scanWindow: Argument.integer("scan-window"),
}).pipe(
  Command.withHandler(({ portFile, defaultPort, scanWindow }) =>
    Effect.promise(async () => {
      const raw = NodeFS.existsSync(portFile) ? NodeFS.readFileSync(portFile, "utf8").trim() : "";
      const preferred = Number.parseInt(raw, 10);
      const start = Number.isInteger(preferred) ? preferred : defaultPort;
      for (let port = start; port < start + scanWindow; port += 1) {
        if (await tryPort(port)) {
          process.stdout.write(String(port));
          return;
        }
      }
      process.exitCode = 1;
    }),
  ),
);

const probe = (port: number, probeTimeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: probeTimeoutMs },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 200 && status < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });

/** Exits 0 once the loopback server answers, 1 when the deadline passes first. */
const waitReady = Command.make("wait-ready", {
  port: Argument.integer("port"),
  timeoutMs: Argument.integer("timeout-ms"),
  probeTimeoutMs: Argument.integer("probe-timeout-ms"),
}).pipe(
  Command.withHandler(({ port, timeoutMs, probeTimeoutMs }) =>
    Effect.promise(async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await probe(port, probeTimeoutMs)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      process.exitCode = 1;
    }),
  ),
);

/** Prints `<pid> <port>` for a live default-home server, or exits 1. */
const runtimePort = Command.make("runtime-port", {
  runtimeFile: Argument.string("runtime-file"),
}).pipe(
  Command.withHandler(({ runtimeFile }) =>
    Effect.sync(() => {
      try {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors the shell snippet's loose parse.
        const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as {
          pid?: unknown;
          port?: unknown;
          origin?: unknown;
        };
        const pid = Number(runtime.pid);
        const port = Number(runtime.port);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
          process.exitCode = 1;
          return;
        }
        const origin = new URL(String(runtime.origin ?? ""));
        if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
          process.exitCode = 1;
          return;
        }
        process.kill(pid, 0);
        process.stdout.write(`${pid} ${port}`);
      } catch {
        process.exitCode = 1;
      }
    }),
  ),
);

export const sshHelperCommand = Command.make("__ssh-helper").pipe(
  Command.unlisted,
  Command.withSubcommands([pickPort, waitReady, runtimePort]),
);
