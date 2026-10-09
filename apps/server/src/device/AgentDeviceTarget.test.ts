// @effect-diagnostics nodeBuiltinImport:off - exercises concurrent real CLI subprocesses.
import {
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as DeviceHost from "./DeviceHost.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
  retireLegacyAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe("host-bound agent commands", () => {
  it.effect("runs two hosts concurrently and only updates the reconnected host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
      const platform = yield* HostProcessPlatform;
      const dir = path.join(
        temp,
        platform === "win32" ? "paths with spaces" : "quotes '\" $HOME `literal`",
      );
      yield* fs.makeDirectory(dir);
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(
        entryPath,
        `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
if (process.env.AGENT_DEVICE_DAEMON_BASE_URL) process.exit(2);`,
      );
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir });
      const files = yield* Effect.forEach(["mini", "android"], (host) =>
        agentDeviceConfigPath(dir, host, path),
      );
      for (const [index, file] of files.entries())
        yield* writeAgentDeviceConfig(file, {
          baseUrl: `http://127.0.0.1:${1000 + index}`,
          token: `token-${index}`,
          entryPath,
        });
      const invoke = (file: string) =>
        exec(
          platform === "win32" ? process.execPath : path.join(shim, "agent-device"),
          [
            ...(platform === "win32" ? [path.join(shim, "agent-device-launcher.mjs")] : []),
            "snapshot",
            "--config",
            file,
            "--session",
            "test-session",
          ],
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
      expect(yield* agentDeviceSession("thread", "mini", "same-id")).not.toBe(
        yield* agentDeviceSession("thread", "android", "same-id"),
      );
      for (const args of [
        ["snapshot"],
        ["snapshot", "--config", files[0]!],
        ["snapshot", "--config", "help"],
        ["snapshot", "--config", files[0]!, "--session"],
      ]) {
        yield* Effect.promise(() =>
          expect(
            exec(process.execPath, [path.join(shim, "agent-device-launcher.mjs"), ...args]),
          ).rejects.toThrow("Call device_open first"),
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

it.effect("retires legacy access before opening an affected host and retries an offline host", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-legacy-" });
    const legacy = yield* agentDeviceConfigPath(directory, "test-host", path);
    const scoped = yield* agentDeviceConfigPath(directory, "test-host", path, {
      threadId: "thread",
      deviceId: "device",
    });
    const endpoint = {
      baseUrl: "http://127.0.0.1:1234",
      token: "old-raw-token",
      entryPath: "/agent.mjs",
    };
    yield* writeAgentDeviceConfig(legacy, endpoint);
    yield* writeAgentDeviceConfig(scoped, { ...endpoint, token: "scoped-token" });
    const attempted = yield* Deferred.make<void>();
    let offline = true;
    let rawCredentialAccepted = true;
    let stopped = 0;
    let starts = 0;
    const host = yield* DeviceHost.DeviceHost.pipe(
      Effect.provide(
        Layer.mock(DeviceHost.DeviceHost)({
          id: "test-host",
          stopAgent: Effect.gen(function* () {
            stopped++;
            yield* Deferred.succeed(attempted, undefined);
            if (offline)
              return yield* new DeviceHost.DeviceHostError({
                hostId: "test-host",
                step: "stop-agent",
                cause: new Error("offline"),
              });
            rawCredentialAccepted = false;
          }),
          ensureAgentReady: () =>
            Effect.sync(() => {
              starts++;
              return {
                nodePath: "/node",
                hub: { origin: "http://hub.test" },
                helpers: { serveSimAxSettings: null, serveSimCli: null },
                run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
                agentDevice: endpoint,
              };
            }),
        }),
      ),
    );
    const prepared = yield* retireLegacyAgentDeviceConfig(directory, host);
    yield* Deferred.await(attempted);
    expect(starts).toBe(0);
    expect(yield* fs.exists(legacy)).toBe(true);
    expect((yield* prepared.ensureAgentReady(() => Effect.void).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(starts).toBe(0);
    expect(rawCredentialAccepted).toBe(true);
    offline = false;
    yield* prepared.ensureAgentReady(() => Effect.void);
    expect(rawCredentialAccepted).toBe(false);
    expect(yield* fs.exists(legacy)).toBe(false);
    expect(JSON.parse(yield* fs.readFileString(scoped)).daemonAuthToken).toBe("scoped-token");
    const retired = stopped;
    yield* prepared.ensureAgentReady(() => Effect.void);
    expect(stopped).toBe(retired);
    const unaffected = yield* retireLegacyAgentDeviceConfig(directory, host);
    expect(unaffected).toBe(host);
    expect(stopped).toBe(retired);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
