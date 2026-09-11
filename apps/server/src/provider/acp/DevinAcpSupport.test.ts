import * as FileSystem from "effect/FileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import {
  applyDevinMode,
  devinMode,
  checkDevinExecutable,
  makeDevinAcpRuntime,
  runDevinCommand,
} from "./DevinAcpSupport.ts";
import {
  makeDevinCli as makeHarness,
  devinTestLayer as layer,
  decodeDevinSettings as decodeSettings,
} from "../testUtils/devinCli.ts";

it.effect("passes resolved Windows command-shim shell options to the process launcher", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make((command) => {
      expect(command._tag).toBe("StandardCommand");
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      expect(command.command).toContain("devin.cmd");
      expect(command.options.shell).toBe(true);
      expect(command.args.join(" ")).toContain("--version");
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make("devin 3000.6.19")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const result = yield* runDevinCommand(decodeSettings({ binaryPath: "devin" }), {}, [
      "--version",
    ]).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\tools\\devin.cmd"),
    );
    expect(result.stdout).toBe("devin 3000.6.19");
  }),
);

it.effect("selects an account model after ACP refreshes its stale catalog", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_DEVIN: "1", T3_ACP_DEVIN_STALE_MODELS: "1" });
    const runtime = yield* makeDevinAcpRuntime(h.settings, h.environment, {
      cwd: h.root,
      clientInfo: { name: "t3-code-test", version: "0.0.0" },
    });
    yield* runtime.start();
    const selection = yield* runtime
      .setModel("devin-test-high")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* runtime.request("_test/refresh-models", {});
    yield* Fiber.join(selection);
    const model = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
    expect(model?.currentValue).toBe("devin-test-high");
    expect(
      (yield* h.requests)
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params?.value),
    ).toEqual(["devin-test-high"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a Desktop version response before starting ACP", () =>
  Effect.gen(function* () {
    const cli = yield* makeHarness({}, "1.108.0\ndesktop-commit\nx64");
    const result = yield* checkDevinExecutable(cli.settings, cli.environment).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("not Devin CLI");
    expect(yield* (yield* FileSystem.FileSystem).exists(cli.launchLog)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("maps auto and edit approval policies to the advertised Devin modes", () =>
  Effect.gen(function* () {
    const cli = yield* makeHarness();
    const runtime = yield* makeDevinAcpRuntime(cli.settings, cli.environment, {
      cwd: cli.root,
      clientInfo: { name: "t3-code-test", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    const modes = (yield* runtime.getModeState)?.availableModes ?? [];
    expect(modes.map((mode) => mode.id)).toContain("smart");
    expect(modes.map((mode) => mode.id)).not.toContain("normal");
    yield* applyDevinMode(runtime, started.sessionId, "auto");
    yield* applyDevinMode(runtime, started.sessionId, "auto-accept-edits");
    yield* applyDevinMode(runtime, started.sessionId, "approval-required");
    expect(
      (yield* cli.requests)
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params?.modeId),
    ).toEqual(["smart", "accept-edits", "normal"]);
    expect(devinMode("auto", undefined, [])).toBe("normal");
  }).pipe(Effect.provide(layer)),
);
