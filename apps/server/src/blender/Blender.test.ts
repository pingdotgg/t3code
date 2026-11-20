import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { BlenderStatus, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Blender from "./Blender.ts";

type ProbeOutput = {
  readonly stdout?: string;
  readonly code?: number;
  readonly timedOut?: boolean;
  readonly spawnFails?: true;
};

const BLENDER_42 = "Blender 4.2.1 LTS\n\tbuild date: 2024-08-19\n";

/** Runs one status read against a temp host whose files and probe output the case controls. */
const readStatus = Effect.fn(function* (input: {
  readonly blender?: Partial<ServerSettingsSchema["blender"]>;
  readonly platform?: NodeJS.Platform;
  /** Executables to create, relative to the temp root. */
  readonly executables?: ReadonlyArray<string>;
  /** PATH entries, relative to the temp root. */
  readonly path?: ReadonlyArray<string>;
  readonly output?: ProbeOutput;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-blender-" });
  for (const executable of input.executables ?? []) {
    const file = path.join(root, executable);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "#!/bin/sh\n");
    yield* fs.chmod(file, 0o755);
  }
  const probes: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) => {
      probes.push({ command: run.command, args: run.args });
      const output = input.output ?? { stdout: BLENDER_42 };
      if (output.spawnFails) {
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: run.command,
            argumentCount: run.args.length,
            cause: new Error("EACCES"),
          }),
        );
      }
      return Effect.succeed({
        stdout: output.stdout ?? "",
        stderr: "",
        code: output.timedOut ? null : ChildProcessSpawner.ExitCode(output.code ?? 0),
        timedOut: output.timedOut ?? false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });
  const blender = input.blender ?? { enabled: true };
  const status = yield* Effect.gen(function* () {
    const service = yield* Blender.Blender;
    return yield* service.status;
  }).pipe(
    Effect.provide(
      Blender.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            blender: {
              ...blender,
              ...(blender.executablePath
                ? { executablePath: path.join(root, blender.executablePath) }
                : {}),
            },
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.HomeDirectory, path.join(root, "home")),
    Effect.provideService(HostProcess.Environment, {
      // Every platform these cases fake separates PATH entries with ":".
      PATH: (input.path ?? []).map((entry) => path.join(root, entry)).join(":"),
    }),
  );
  return { status, probes, root };
});

describe("Blender.status", () => {
  it.effect("does not probe while the integration is disabled, which is the default", () =>
    Effect.gen(function* () {
      const { status, probes } = yield* readStatus({
        blender: {},
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(status, { _tag: "Disabled" });
      assert.strictEqual(probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects Blender on PATH and probes its version", () =>
    Effect.gen(function* () {
      const { status, probes, root } = yield* readStatus({
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(status, {
        _tag: "Available",
        executablePath: `${root}/bin/blender`,
        source: "path",
        version: "4.2.1",
      });
      assert.deepStrictEqual(probes, [{ command: `${root}/bin/blender`, args: ["--version"] }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to a standard install when PATH has no Blender", () =>
    Effect.gen(function* () {
      const { status, root } = yield* readStatus({
        platform: "darwin",
        executables: ["home/Applications/Blender.app/Contents/MacOS/Blender"],
      });
      assert.deepStrictEqual(status, {
        _tag: "Available",
        executablePath: `${root}/home/Applications/Blender.app/Contents/MacOS/Blender`,
        source: "standard-install",
        version: "4.2.1",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("probes the override instead of detecting, and reports a missing override", () =>
    Effect.gen(function* () {
      const found = yield* readStatus({
        blender: { enabled: true, executablePath: "custom/blender-4.5" },
        executables: ["custom/blender-4.5", "bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(found.status, {
        _tag: "Available",
        executablePath: `${found.root}/custom/blender-4.5`,
        source: "override",
        version: "4.2.1",
      });
      assert.deepStrictEqual(
        found.probes.map((probe) => probe.command),
        [`${found.root}/custom/blender-4.5`],
      );

      const missing = yield* readStatus({
        blender: { enabled: true, executablePath: "custom/missing" },
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(missing.status, { _tag: "NotFound", source: "override" });
      assert.strictEqual(missing.probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports detection that finds nothing", () =>
    Effect.gen(function* () {
      const { status, probes } = yield* readStatus({});
      assert.deepStrictEqual(status, { _tag: "NotFound", source: "detection" });
      assert.strictEqual(probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const probeCases: ReadonlyArray<{
    readonly name: string;
    readonly output: ProbeOutput;
    readonly expected: (executablePath: string) => BlenderStatus;
  }> = [
    {
      name: "an older release as unsupported",
      output: { stdout: "Blender 3.6.5\n" },
      expected: (executablePath) => ({
        _tag: "Unsupported",
        executablePath,
        source: "path",
        version: "3.6.5",
        minimumVersion: "4.2",
      }),
    },
    {
      name: "a version line after startup warnings",
      output: { stdout: "Color management: using fallback mode\nBlender 5.0\n" },
      expected: (executablePath) => ({
        _tag: "Available",
        executablePath,
        source: "path",
        version: "5.0",
      }),
    },
    {
      name: "malformed output",
      output: { stdout: "not blender\n" },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "unrecognized-output",
      }),
    },
    {
      name: "a nonzero exit, even with a version line",
      output: { stdout: BLENDER_42, code: 3 },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "nonzero-exit",
        exitCode: 3,
      }),
    },
    {
      name: "an executable that cannot start",
      output: { spawnFails: true },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "spawn-failed",
      }),
    },
    {
      name: "a probe that times out",
      output: { timedOut: true },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "timed-out",
      }),
    },
  ];

  it.effect.each(probeCases)("reports $name", ({ output, expected }) =>
    Effect.gen(function* () {
      const { status, root } = yield* readStatus({
        executables: ["bin/blender"],
        path: ["bin"],
        output,
      });
      assert.deepStrictEqual(status, expected(`${root}/bin/blender`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
