import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Real IPC and helper-process lifetimes are the behavior under test.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import { expect, it } from "@effect/vitest";
import { ExtensionProcess } from "./ExtensionProcess.ts";

it.live("cancels nested service calls and closes helper processes on stop and crash", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-extension-ipc-"));
      const entry = NodePath.join(directory, "main.mjs");
      await NodeFSP.writeFile(
        entry,
        `import { spawn } from 'node:child_process';
    export default {activate(context) {
      context.registerCommand('wait', () => context.callT3('wait', {}));
      context.registerCommand('fail', () => context.callT3('fail', {}));
      context.registerCommand('helper', ({port}) => {
        const child = spawn(process.execPath, ['-e', "require('node:net').connect("+port+", '127.0.0.1')"], {stdio: 'ignore'});
        return child.pid;
      });
      context.registerCommand('crash', () => process.exit(13));
    }};`,
      );
      await using server = NodeNet.createServer();
      server.listen(0, "127.0.0.1");
      await NodeEvents.EventEmitter.once(server, "listening");
      const address = server.address();
      if (typeof address !== "object" || !address) throw new Error("Missing fixture port.");
      const aborted = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const children: ExtensionProcess[] = [];
      const helperPids: number[] = [];
      try {
        for (const ending of ["stop", "crash"] as const) {
          const logs: string[] = [];
          const host = new ExtensionProcess({
            cwd: directory,
            platform: platform,
            launch: {
              command: process.execPath,
              args: [NodeURL.fileURLToPath(new URL("./hostMain.ts", import.meta.url))],
            },
            hostCall: (method, _input, signal) => {
              if (method === "fail")
                return Promise.reject(
                  new Error("Thread fixture is missing. fixture-credential=secret-service-value"),
                );
              started.resolve();
              return new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted.resolve();
                    reject(new Error("cancelled"));
                  },
                  { once: true },
                );
              });
            },
            event: () => {},
            failed: () => {},
            log: (chunk) => logs.push(chunk),
          });
          children.push(host);
          await host.ready;
          await host.request("activate", {
            id: "test.ipc",
            storagePath: directory,
            settings: {},
            entry,
          });
          if (ending === "stop") {
            const waiting = host.request(
              "invoke",
              { kind: "command", name: "wait", input: {} },
              100,
            );
            const rejection = expect(waiting).rejects.toThrow("timed out");
            await started.promise;
            await rejection;
            await aborted.promise;
            await expect(
              host.request("invoke", { kind: "command", name: "fail", input: {} }),
            ).rejects.toThrow("Thread fixture is missing.");
            expect(logs.join("")).not.toContain("secret-service-value");
            expect(logs.join("")).toContain("T3 service call failed (runtime-failed).");
          }
          const connected = NodeEvents.EventEmitter.once(server, "connection");
          const pid = await host.request("invoke", {
            kind: "command",
            name: "helper",
            input: { port: address.port },
          });
          if (typeof pid !== "number") throw new Error("Missing spawned helper PID.");
          helperPids.push(pid);
          const [socket] = (await connected) as [NodeNet.Socket];
          const closed = NodeEvents.EventEmitter.once(socket, "close");
          socket.resume();
          if (ending === "stop") await host.stop();
          else
            await expect(
              host.request("invoke", { kind: "command", name: "crash", input: {} }),
            ).rejects.toThrow("stopped");
          await closed;
        }
      } finally {
        await Promise.all(children.map((child) => child.stop()));
        for (const pid of helperPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (cause) {
            expect(cause).toMatchObject({ code: "ESRCH" });
          }
        }
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  }),
);
