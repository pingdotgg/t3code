// @effect-diagnostics nodeBuiltinImport:off - exercises concurrent real CLI subprocesses.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
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

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe("host-bound agent commands", () => {
  it.effect("runs two hosts concurrently and only updates the reconnected host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(
        entryPath,
        `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
if (process.env.AGENT_DEVICE_DAEMON_BASE_URL) process.exit(2);`,
      );
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir, fs, path });
      const files = ["mini", "android"].map((host) => agentDeviceConfigPath(dir, host, path));
      for (const [index, file] of files.entries())
        yield* writeAgentDeviceConfig(file, {
          baseUrl: `http://127.0.0.1:${1000 + index}`,
          token: `token-${index}`,
          entryPath,
        });
      const invoke = (file: string) =>
        exec(
          process.execPath,
          [path.join(shim, "agent-device-launcher.mjs"), "snapshot", "--config", file],
          { env: { ...process.env, AGENT_DEVICE_DAEMON_BASE_URL: "http://wrong-host" } },
        ).then((result) => JSON.parse(result.stdout));
      expect(yield* Effect.promise(() => Promise.all(files.map(invoke)))).toEqual([
        { daemonBaseUrl: "http://127.0.0.1:1000", daemonAuthToken: "token-0" },
        { daemonBaseUrl: "http://127.0.0.1:1001", daemonAuthToken: "token-1" },
      ]);
      const second = yield* fs.readFileString(files[1]!);
      yield* writeAgentDeviceConfig(files[0]!, {
        baseUrl: "http://127.0.0.1:2000",
        token: "new",
        entryPath,
      });
      expect((yield* Effect.promise(() => invoke(files[0]!))).daemonAuthToken).toBe("new");
      expect(yield* fs.readFileString(files[1]!)).toBe(second);
      expect(agentDeviceSession("thread", "mini", "same-id")).not.toBe(
        agentDeviceSession("thread", "android", "same-id"),
      );
      yield* Effect.promise(() =>
        expect(
          exec(process.execPath, [path.join(shim, "agent-device-launcher.mjs"), "snapshot"]),
        ).rejects.toThrow("Call device_open first"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
