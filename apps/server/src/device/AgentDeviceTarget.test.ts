import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";

const exec = promisify(execFile);

describe("host-bound agent commands", () => {
  it("runs two hosts concurrently and only updates the reconnected host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3-device-target-"));
    try {
      const entryPath = join(dir, "cli.mjs");
      await writeFile(
        entryPath,
        `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
if (process.env.AGENT_DEVICE_DAEMON_BASE_URL) process.exit(2);`,
      );
      const setup = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir, fs, path });
          const files = ["mini", "android"].map((host) => agentDeviceConfigPath(dir, host, path));
          for (const [index, file] of files.entries())
            yield* writeAgentDeviceConfig(file, {
              baseUrl: `http://127.0.0.1:${1000 + index}`,
              token: `token-${index}`,
              entryPath,
            });
          return { shim, files };
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const invoke = (file: string) =>
        exec(
          process.execPath,
          [join(setup.shim, "agent-device-launcher.mjs"), "snapshot", "--config", file],
          { env: { ...process.env, AGENT_DEVICE_DAEMON_BASE_URL: "http://wrong-host" } },
        ).then((result) => JSON.parse(result.stdout));
      expect(await Promise.all(setup.files.map(invoke))).toEqual([
        { daemonBaseUrl: "http://127.0.0.1:1000", daemonAuthToken: "token-0" },
        { daemonBaseUrl: "http://127.0.0.1:1001", daemonAuthToken: "token-1" },
      ]);
      const second = await readFile(setup.files[1]!, "utf8");
      await Effect.runPromise(
        writeAgentDeviceConfig(setup.files[0]!, {
          baseUrl: "http://127.0.0.1:2000",
          token: "new",
          entryPath,
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect((await invoke(setup.files[0]!)).daemonAuthToken).toBe("new");
      expect(await readFile(setup.files[1]!, "utf8")).toBe(second);
      expect(agentDeviceSession("thread", "mini", "same-id")).not.toBe(
        agentDeviceSession("thread", "android", "same-id"),
      );
      await expect(
        exec(process.execPath, [join(setup.shim, "agent-device-launcher.mjs"), "snapshot"]),
      ).rejects.toThrow("Call device_open first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
