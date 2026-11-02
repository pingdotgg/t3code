import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";

it.effect("preserves installed status after probes and cleans failed agent activation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const modes: string[] = [];
    const owners: string[] = [];
    const tunnelArgs: string[][] = [];
    const tunnelStdins: unknown[] = [];
    const commandArgs: string[][] = [];
    let forwards = 0;
    let failForward = true;
    let rejectConfig = true;
    const releases: Array<string | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const forwarding = command.args.includes("-L");
        (forwarding ? tunnelArgs : commandArgs).push([...command.args]);
        if (forwarding) tunnelStdins.push(command.options.stdin);
        let output = "";
        let exitCode = 0;
        if (forwarding) {
          if (failForward) {
            failForward = false;
            return yield* PlatformError.systemError({
              _tag: "AlreadyExists",
              module: "ChildProcess",
              method: "spawn",
              description: "Port already bound",
            });
          }
          forwards++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              forwards--;
            }),
          );
        } else {
          const stdin = command.options.stdin;
          if (
            !stdin ||
            typeof stdin !== "object" ||
            !("stream" in stdin) ||
            !Stream.isStream(stdin.stream)
          )
            return yield* Effect.die("Missing script");
          const script = yield* stdin.stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          );
          const mode = /const mode = "([^"]+)"/.exec(script)?.[1] ?? "";
          modes.push(mode);
          owners.push(/const owner = "([^"]+)"/.exec(script)?.[1] ?? "");
          output = JSON.stringify({
            nodePath: "/node",
            platforms: [{ platform: "ios", available: true }],
            hubPort: 1234,
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            ...(mode === "agent-start"
              ? { daemonPort: 1235, token: "fixture", entryPath: "/agent.mjs" }
              : {}),
          });
          if (mode === "") {
            output = `${"verbose-prefix ".repeat(400)}PANIC: emulator SDK is broken\n`;
            exitCode = 1;
          }
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: forwarding
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(forwarding),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const host = yield* SshDeviceHost.make(
      { kind: "ssh", id: "test", label: "Test", target: "test.example" },
      () =>
        rejectConfig
          ? Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId: "test",
                step: "configuring agent access",
                cause: new Error("fixture failure"),
              }),
            )
          : Effect.void,
    ).pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(home, home), Net.layer)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (!request.url.endsWith("/rpc"))
              return HttpClientResponse.fromWeb(request, new Response("ok"));
            releases.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ result: { ok: true } }));
          }),
        ),
      ),
    );
    yield* host.ensureReady(() => Effect.void);
    yield* SshDeviceHost.probe({
      kind: "ssh",
      id: "test",
      label: "Test",
      target: "test.example",
    }).pipe(
      Effect.provide(ServerConfig.layerTest(home, home)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    expect(new Set(owners).size).toBe(1);
    expect(owners[0]).toMatch(/^[a-f0-9]{24}$/);
    expect(forwards).toBe(1);
    expect(modes.filter((mode) => mode === "start")).toHaveLength(2);
    const ready = yield* host.current;
    expect(ready).not.toBeNull();
    if (ready) {
      const failed = yield* ready.run("emulator", ["-list-avds"]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toMatch(/^\[truncated\]/);
      expect(failed.stderr).toBe(failed.stdout.trim());
      expect(failed.stderr).toMatch(/PANIC: emulator SDK is broken$/);
    }
    yield* host.platformAvailability("ios");
    expect((yield* host.summary).hubInstalled).toBe(true);
    const failed = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(forwards).toBe(0);
    expect(modes.at(-1)).toBe("stop-agent");
    expect(yield* host.current).toBeNull();
    rejectConfig = false;
    yield* host.ensureAgentReady(() => Effect.void);
    yield* host.platformAvailability("ios");
    expect((yield* host.summary).agentDeviceInstalled).toBe(true);
    // Close releases agent sessions through the forwarded daemon.
    const agentReady = yield* host.current;
    yield* agentReady!.releaseAgentSession!("t3-session", "device");
    expect(releases).toEqual(["Bearer fixture"]);
    yield* host.stopAgent;
    expect(forwards).toBe(1);
    const multiplexingOff = ["ControlMaster=no", "ControlPath=none", "ControlPersist=no"];
    expect(tunnelArgs.length).toBeGreaterThan(0);
    for (const args of tunnelArgs) {
      for (const option of multiplexingOff) {
        const index = args.indexOf(option);
        expect(index).toBeGreaterThan(0);
        expect(args[index - 1]).toBe("-o");
      }
      // The tunnel lives only as long as the server holds the write end of its stdin.
      expect(args).not.toContain("-N");
      expect(args.slice(args.indexOf("test.example") + 1)).toEqual([
        "sh",
        "-c",
        "'exec cat >/dev/null'",
      ]);
    }
    expect(tunnelStdins).toEqual(tunnelArgs.map(() => "pipe"));
    expect(commandArgs.length).toBeGreaterThan(0);
    for (const args of commandArgs) {
      for (const option of multiplexingOff) expect(args).not.toContain(option);
    }
    yield* host.stop;
    expect(forwards).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lists Android devices without probing the host again once it reports Android", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const modes: string[] = [];
    let androidInstalled = false;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const forwarding = command.args.includes("-L");
        let output = "";
        if (!forwarding) {
          const stdin = command.options.stdin;
          const script =
            stdin && typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)
              ? yield* stdin.stream.pipe(
                  Stream.decodeText(),
                  Stream.runFold(
                    () => "",
                    (a, b) => a + b,
                  ),
                )
              : "";
          const mode = /const mode = "([^"]+)"/.exec(script)?.[1] ?? "";
          modes.push(mode);
          output =
            mode === ""
              ? "Pixel_8\n"
              : JSON.stringify({
                  nodePath: "/node",
                  platforms: [
                    { platform: "ios", available: true },
                    { platform: "android", available: androidInstalled },
                  ],
                  hubPort: 1234,
                  helpers: { serveSimAxSettings: null, serveSimCli: null },
                });
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: forwarding ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(forwarding),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const host = yield* SshDeviceHost.make({
      kind: "ssh",
      id: "test",
      label: "Test",
      target: "test.example",
    }).pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(home, home), Net.layer)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                request.url.endsWith("/api/devices")
                  ? JSON.stringify({ simulators: [], emulators: [] })
                  : "ok",
              ),
            ),
          ),
        ),
      ),
    );
    const ready = yield* host.ensureReady(() => Effect.void);
    const androidNames = ready.devices.list.pipe(
      Effect.map((list) =>
        list.devices.filter((device) => device.platform === "android").map((device) => device.name),
      ),
    );

    modes.splice(0);

    expect(yield* androidNames).toEqual([]);
    expect(modes.splice(0)).toEqual(["probe"]);
    expect(yield* androidNames).toEqual([]);
    expect(modes.splice(0)).toEqual(["probe"]);

    // The SDK appears after connecting, so the next listing still probes the host.
    androidInstalled = true;
    expect(yield* androidNames).toEqual(["Pixel_8"]);
    expect(modes.splice(0)).toEqual(["probe", ""]);

    // Android is now known to be available, so listing only runs `emulator -list-avds`.
    expect(yield* androidNames).toEqual(["Pixel_8"]);
    expect(modes.splice(0)).toEqual([""]);

    androidInstalled = false;
    expect((yield* host.platformAvailability("android")).available).toBe(false);
    expect(modes.splice(0)).toEqual(["probe"]);
    expect(yield* androidNames).toEqual([]);
    expect(modes.splice(0)).toEqual(["probe"]);

    androidInstalled = true;
    yield* host.inspect;
    expect(modes.splice(0)).toEqual(["probe"]);
    expect(yield* androidNames).toEqual(["Pixel_8"]);
    expect(modes.splice(0)).toEqual([""]);
    yield* host.stop;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
