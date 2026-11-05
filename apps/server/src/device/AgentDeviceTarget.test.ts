// @effect-diagnostics nodeBuiltinImport:off - exercises concurrent real CLI subprocesses.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  agentDeviceCloseOutcome,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

/** A loopback port that accepts connections until the scope closes, like T3's device connection. */
const listeningPort = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer((socket) => socket.destroy());
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

describe("host-bound agent commands", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs both desktop hops as Node with a stripped environment, preserving arguments and exit code",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
        const dir = path.join(temp, "quotes '\" $HOME `literal`");
        yield* fs.makeDirectory(dir);
        const desktopApp = path.join(dir, "T3 Code");
        // Dropping Node mode after checking it forces each hop to set it independently.
        yield* fs.writeFileString(
          desktopApp,
          `#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "1" ]; then
  echo "started the desktop app" >&2
  exit 134
fi
unset ELECTRON_RUN_AS_NODE
exec '${process.execPath.replaceAll("'", "'\"'\"'")}' "$@"
`,
        );
        yield* fs.chmod(desktopApp, 0o755);
        const entryPath = path.join(dir, "cli.mjs");
        yield* fs.writeFileString(
          entryPath,
          "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;",
        );
        const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, desktopApp),
          Effect.provideService(HostProcess.IsExecutable, false),
        );
        const args = [
          "snapshot",
          "--config",
          path.join(dir, "config.json"),
          "--session",
          "a!b!c",
          "",
        ];
        yield* Effect.promise(() =>
          expect(
            exec(path.join(shim, "agent-device"), args, {
              env: { PATH: process.env.PATH ?? "", HOME: temp },
            }),
          ).rejects.toMatchObject({ code: 23, stdout: `${JSON.stringify(args)}\n`, stderr: "" }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("binds one device's flags into its launcher and leaves help alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-bound-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));");
      const target = [
        "--platform",
        "ios",
        "--udid",
        "UDID-1",
        "--config",
        "/h.json",
        "--session",
        "t3-a",
      ];
      const command = yield* bindAgentDeviceLauncher({
        entryPath,
        stateDir: dir,
        session: "t3-a",
        targetArgs: target,
      });
      const shared = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir });
      const launch = (launcher: string, args: ReadonlyArray<string>) =>
        exec(process.execPath, [path.join(launcher, "agent-device-launcher.mjs"), ...args]).then(
          (result) => JSON.parse(result.stdout),
        );
      const bound = path.dirname(command);
      expect(yield* Effect.promise(() => launch(bound, ["snapshot", "-i"]))).toEqual([
        "snapshot",
        "-i",
        ...target,
      ]);
      // A flag the agent passes itself wins over the bound one.
      expect(yield* Effect.promise(() => launch(bound, ["open", "--session", "mine"]))).toEqual([
        "open",
        "--session",
        "mine",
        "--platform",
        "ios",
        "--udid",
        "UDID-1",
        "--config",
        "/h.json",
      ]);
      expect(yield* Effect.promise(() => launch(bound, ["snapshot", "--session=mine"]))).toEqual([
        "snapshot",
        "--session=mine",
        "--platform",
        "ios",
        "--udid",
        "UDID-1",
        "--config",
        "/h.json",
      ]);
      // After `--` everything is text: no help, no overrides, and bound flags go before it.
      for (const text of [["--help"], ["literal text", "--session", "mine"]]) {
        expect(yield* Effect.promise(() => launch(bound, ["fill", "@e5", "--", ...text]))).toEqual([
          "fill",
          "@e5",
          ...target,
          "--",
          ...text,
        ]);
      }
      expect(
        yield* Effect.promise(() =>
          launch(shared, ["snapshot", "--config=/h.json", "--session=t3-a"]),
        ),
      ).toEqual(["snapshot", "--config=/h.json", "--session=t3-a"]);
      yield* Effect.promise(() =>
        expect(
          launch(shared, ["fill", "@e5", "--", "--config", "/h.json", "--session", "t3-a"]),
        ).rejects.toThrow("Call device_open first"),
      );
      for (const args of [["help", "gesture"], ["open", "--help"], ["record", "-h"], []]) {
        expect(yield* Effect.promise(() => launch(bound, args))).toEqual(args);
        expect(yield* Effect.promise(() => launch(shared, args))).toEqual(args);
      }
      yield* fs.remove(entryPath);
      yield* Effect.promise(() =>
        expect(launch(bound, ["snapshot"])).rejects.toThrow("Call device_open again"),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("passes each command only the bound flags agent-device accepts for it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-commands-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));");
      const command = yield* bindAgentDeviceLauncher({
        entryPath,
        stateDir: dir,
        session: "t3-a",
        targetArgs: [
          "--platform",
          "ios",
          "--udid",
          "UDID-1",
          "--config",
          "/h.json",
          "--session",
          "t3-a",
        ],
      });
      const launch = (args: ReadonlyArray<string>) =>
        exec(process.execPath, [
          path.join(path.dirname(command), "agent-device-launcher.mjs"),
          ...args,
        ]).then((result) => JSON.parse(result.stdout));
      // agent-device 0.21.31 rejects these flags with "unknown option" or "not supported for command".
      const cdp = ["cdp", "target", "list", "--url", "http://127.0.0.1:8081"];
      expect(yield* Effect.promise(() => launch(cdp))).toEqual(cdp);
      expect(yield* Effect.promise(() => launch(["connection"]))).toEqual([
        "connection",
        "--config",
        "/h.json",
        "--session",
        "t3-a",
      ]);
      // The command is found past leading flags and their values, in either form.
      for (const config of [["--config", "/o.json"], ["--config=/o.json"]]) {
        expect(yield* Effect.promise(() => launch([...config, "connection"]))).toEqual([
          ...config,
          "connection",
          "--session",
          "t3-a",
        ]);
        // device status reads claims on the machine it runs on, which is not the device's host.
        yield* Effect.promise(() =>
          expect(launch([...config, "device", "status"])).rejects.toThrow(
            "`device status` reads this machine's device claims, not those on the device's host",
          ),
        );
      }
      expect(yield* Effect.promise(() => launch(["--json", ...cdp]))).toEqual(["--json", ...cdp]);
      for (const managed of [
        ["connect"],
        ["disconnect"],
        ["auth", "status"],
        ["daemon", "stop"],
        ["--config", "/o.json", "auth", "status"],
        ["--", "connect"],
      ]) {
        yield* Effect.promise(() =>
          expect(launch(managed)).rejects.toThrow(
            `T3 Code manages this command's connection to the device, so \`${managed.find((arg) => ["connect", "disconnect", "auth", "daemon"].includes(arg))}\` is not available through it.`,
          ),
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provide(NodeServices.layer),
    ),
  );

  it("tells a released session from a close that failed or timed out", () => {
    const result = (code: number | null, stderr = "", timedOut = false) => ({
      stdout: "",
      stderr,
      code,
      timedOut,
    });
    expect(agentDeviceCloseOutcome(result(0))).toBe("closed");
    // A session that never ran `open` has nothing to release.
    expect(
      agentDeviceCloseOutcome(
        result(1, "Error (SESSION_NOT_FOUND): No active session. Run open first."),
      ),
    ).toBe("no-session");
    expect(
      agentDeviceCloseOutcome(result(1, "Error (COMMAND_FAILED): Remote daemon is unavailable")),
    ).toBe("failed");
    expect(agentDeviceCloseOutcome(result(null, "", true))).toBe("timed-out");
  });

  it.live("stops before agent-device when T3's device connection is down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-endpoint-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));");
      const configPath = path.join(dir, "host.json");
      // A port that was just free: nothing listens on it, so a connect is refused.
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const server = NodeNet.createServer();
            server.listen(0, "127.0.0.1", () => {
              const address = server.address() as NodeNet.AddressInfo;
              server.close(() => resolve(address.port));
            });
          }),
      );
      yield* writeAgentDeviceConfig(configPath, {
        baseUrl: `http://127.0.0.1:${port}`,
        token: "secret",
      });
      const command = yield* bindAgentDeviceLauncher({
        entryPath,
        stateDir: dir,
        session: "t3-a",
        targetArgs: ["--config", configPath, "--session", "t3-a"],
      });
      const launch = (args: ReadonlyArray<string>) =>
        exec(process.execPath, [
          path.join(path.dirname(command), "agent-device-launcher.mjs"),
          ...args,
        ]);
      yield* Effect.promise(() =>
        expect(launch(["screenshot", "/tmp/shot.png"])).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: `T3 Code's device connection at 127.0.0.1:${port} is not reachable from this shell (connect ECONNREFUSED). Call device_open again to reconnect; if that succeeds and this repeats, this shell runs in a network sandbox, so run the command with network access, outside the sandbox.\n`,
        }),
      );
      // An explicit --daemon-base-url wins over the config, as it does in agent-device.
      const override = `http://127.0.0.1:${yield* listeningPort}`;
      for (const flag of [["--daemon-base-url", override], [`--daemon-base-url=${override}`]]) {
        expect(
          JSON.parse(
            (yield* Effect.promise(() => launch(["screenshot", "/tmp/shot.png", ...flag]))).stdout,
          ),
        ).toEqual([
          "screenshot",
          "/tmp/shot.png",
          ...flag,
          "--config",
          configPath,
          "--session",
          "t3-a",
        ]);
      }
      // cdp talks to Metro, not to T3's connection, so it still runs.
      expect(
        JSON.parse((yield* Effect.promise(() => launch(["cdp", "target", "list"]))).stdout),
      ).toEqual(["cdp", "target", "list"]);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("prunes the launchers of ended sessions and keeps the shared one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-prune-" });
      const entryPath = path.join(stateDir, "cli.mjs");
      const shared = yield* ensureAgentDeviceShim({ entryPath, stateDir });
      const bind = (session: string) =>
        bindAgentDeviceLauncher({ entryPath, stateDir, session, targetArgs: [] });
      const kept = yield* bind("t3-open");
      const ended = yield* bind("t3-closed");
      yield* pruneAgentDeviceLaunchers({ stateDir, live: new Set(["t3-open"]) });
      expect(yield* fs.exists(kept)).toBe(true);
      expect(yield* fs.exists(path.dirname(ended))).toBe(false);
      expect(yield* fs.exists(shared)).toBe(true);
      yield* pruneAgentDeviceLaunchers({ stateDir, live: new Set() });
      expect(yield* fs.readDirectory(path.join(stateDir, "device", "targets"))).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "tells the agent to reopen the device when the runtime it was bound to is gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-stale-" });
        const runtime = path.join(dir, "old-node");
        yield* fs.writeFileString(runtime, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(runtime, 0o755);
        const command = yield* bindAgentDeviceLauncher({
          entryPath: path.join(dir, "cli.mjs"),
          stateDir: dir,
          session: "t3-a",
          targetArgs: ["--config", "/h.json", "--session", "t3-a"],
        }).pipe(Effect.provideService(HostProcess.ExecutablePath, runtime));
        yield* fs.remove(runtime);
        yield* Effect.promise(() =>
          expect(exec(command, ["snapshot"])).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining("Call device_open again"),
          }),
        );
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("runs two hosts concurrently and only updates the reconnected host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
      const platform = yield* HostProcess.Platform;
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
      const ports = [yield* listeningPort, yield* listeningPort, yield* listeningPort];
      for (const [index, file] of files.entries())
        yield* writeAgentDeviceConfig(file, {
          baseUrl: `http://127.0.0.1:${ports[index]}`,
          token: `token-${index}`,
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
        { daemonBaseUrl: `http://127.0.0.1:${ports[0]}`, daemonAuthToken: "token-0" },
        { daemonBaseUrl: `http://127.0.0.1:${ports[1]}`, daemonAuthToken: "token-1" },
      ]);
      const second = yield* fs.readFileString(files[1]!);
      yield* writeAgentDeviceConfig(files[0]!, {
        baseUrl: `http://127.0.0.1:${ports[2]}`,
        token: "new",
      });
      expect((yield* Effect.promise(() => invoke(files[0]!))).daemonAuthToken).toBe("new");
      expect(yield* fs.readFileString(files[1]!)).toBe(second);
      // Hosts with a daemon per device get a file per device, apart from the host's own.
      const perDevice = yield* Effect.forEach(["udid-1", "udid-2"], (device) =>
        agentDeviceConfigPath(dir, "eas", path, device),
      );
      expect(new Set([...perDevice, yield* agentDeviceConfigPath(dir, "eas", path)]).size).toBe(3);
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
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
