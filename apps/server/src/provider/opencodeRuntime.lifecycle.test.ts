import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

it.each(["SIGTERM", "SIGKILL"] as const)(
  "stops OpenCode and its descendants when the backend receives %s",
  async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "t3-opencode-lifetime-"));
    const providerScript = join(directory, "provider.mjs");
    const pidPath = join(directory, "pids.json");
    const backendScript = join(directory, "backend.mjs");
    const binaryPath =
      process.platform === "win32" ? join(directory, "opencode.cmd") : providerScript;
    await writeFile(
      providerScript,
      `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ provider: process.pid, descendant: descendant.pid }));
process.on("SIGTERM", () => {});
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1]);
createServer((_, response) => response.end("healthy")).listen(port, "127.0.0.1", () => {
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`,
    );
    if (process.platform === "win32") {
      await writeFile(binaryPath, `@"${process.execPath}" "${providerScript}" %*\r\n`);
    } else {
      await chmod(providerScript, 0o700);
    }
    await writeFile(
      backendScript,
      `import * as NodeRuntime from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeRuntime"))};
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { OpenCodeRuntime, OpenCodeRuntimeLive } from ${JSON.stringify(new URL("./opencodeRuntime.ts", import.meta.url).href)};
Effect.gen(function* () {
  const runtime = yield* OpenCodeRuntime;
  const server = yield* runtime.startOpenCodeServerProcess({ binaryPath: ${JSON.stringify(binaryPath)} });
  console.log(JSON.stringify({ url: server.url }));
  yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(OpenCodeRuntimeLive), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
`,
    );
    const backend = spawn(process.execPath, [backendScript], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const exited = once(backend, "exit");
    let stdout = "";
    let stderr = "";
    backend.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    backend.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let pids: { provider: number; descendant: number } | undefined;
    const cleanup = async () => {
      if (backend.exitCode === null && backend.signalCode === null) {
        backend.kill("SIGKILL");
        await exited;
      }
      if (!pids) {
        try {
          pids = JSON.parse(await readFile(pidPath, "utf8")) as typeof pids;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      for (const pid of [pids?.provider, pids?.descendant]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
        }
      }
      await rm(directory, { recursive: true, force: true });
    };
    try {
      await expect
        .poll(
          () => {
            if (backend.exitCode !== null || backend.signalCode !== null) {
              throw new Error(`Backend fixture exited: ${stdout}\n${stderr}`);
            }
            return stdout.includes('{"url":');
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const readyLine = stdout.split("\n").find((line) => line.startsWith('{"url":'));
      expect(readyLine, stderr).toBeDefined();
      const { url } = JSON.parse(readyLine ?? "") as { url: string };
      pids = JSON.parse(await readFile(pidPath, "utf8")) as typeof pids;
      expect(await (await fetch(url)).text()).toBe("healthy");

      backend.kill(signal);
      await exited;
      await expect
        .poll(
          async () => {
            try {
              await fetch(url, { signal: AbortSignal.timeout(250) });
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      for (const pid of [pids?.provider, pids?.descendant]) {
        expect(pid).toBeTypeOf("number");
        await expect
          .poll(
            () => {
              try {
                process.kill(pid ?? 0, 0);
                return false;
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
                return true;
              }
            },
            { timeout: 5_000 },
          )
          .toBe(true);
      }
    } finally {
      await cleanup();
    }
  },
  30_000,
);
