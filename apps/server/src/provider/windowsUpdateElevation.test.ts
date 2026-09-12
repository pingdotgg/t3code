// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { prepareWindowsUpdateElevation } from "./windowsUpdateElevation.ts";
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// Exercise the real PowerShell/Win32 argv boundary without requesting UAC or
// launching a provider. Only the launcher's RunAs verb is removed in the test.
for (const { mode, expectedCode } of [
  { mode: "complete", expectedCode: 7 },
  { mode: "cmd-complete", expectedCode: 7 },
  { mode: "cancel", expectedCode: 1460 },
  { mode: "expired", expectedCode: 1460 },
  { mode: "timeout", expectedCode: 1460 },
  { mode: "cmd-timeout", expectedCode: 1460 },
  { mode: "declined", expectedCode: 1223 },
]) {
  it.effect.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
    `runs the Windows elevation worker without UAC: ${mode}`,
    () =>
      Effect.gen(function* () {
        const timeout = mode.endsWith("timeout");
        const args = [
          "C:\\Program Files\\tool\\",
          "private source",
          "O'Brien & $literal",
          'a"b',
          "caffè",
        ];
        const program = timeout
          ? "console.log('started'); setTimeout(() => process.exit(99), 30000)"
          : "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env.T3_UPDATE_TEST, scoop: process.env.SCOOP, global: process.env.SCOOP_GLOBAL })); process.exit(7)";
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3 update O'Brien & " });
        const script = path.join(directory, "fixture.js");
        yield* fs.writeFileString(script, program);
        const shim = path.join(directory, "scoop.cmd");
        yield* fs.writeFileString(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
        const cmd = mode.startsWith("cmd-");
        const prepared = yield* prepareWindowsUpdateElevation(
          {
            command: "fixture",
            executable: cmd ? shim : process.execPath,
            args: cmd ? args : [script, ...args],
            lockKey: "fixture",
            env: {
              T3_UPDATE_TEST: "value ' with spaces & $data",
              t3_update_test: "shadowed",
              SCOOP: directory,
              SCOOP_GLOBAL: path.join(directory, "global apps"),
            },
          },
          mode === "expired" ? 0 : timeout ? 3_000 : 15_000,
          10_000,
        );
        if (mode === "cancel") yield* prepared.cancel;
        const launcher = Buffer.from(prepared.args[3]!, "base64").toString("utf16le");
        const testLauncher =
          mode === "declined"
            ? launcher.replace(
                "$child = [Diagnostics.Process]::Start($start)",
                "throw [InvalidOperationException]::new('fixture', [ComponentModel.Win32Exception]::new(1223))",
              )
            : launcher.replace("$start.Verb = 'runas'", "$start.Verb = ''");
        assert.notStrictEqual(testLauncher, launcher, "launcher patch did not apply");
        const encoded = Buffer.from(testLauncher, "utf16le").toString("base64");
        const exitCode = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              NodeChildProcess.execFile(
                prepared.command,
                [...prepared.args.slice(0, 3), encoded],
                { windowsHide: true },
                (error) => {
                  if (error && typeof error.code !== "number") reject(error);
                  else resolve(typeof error?.code === "number" ? error.code : 0);
                },
              );
            }),
        );
        const [stdout, stderr] = yield* prepared.readOutput;
        assert.strictEqual(exitCode, expectedCode, stderr?.text);
        if (mode.endsWith("complete")) {
          assert.deepStrictEqual(yield* decodeOutput(stdout?.text), {
            args,
            env: "value ' with spaces & $data",
            scoop: directory,
            global: path.join(directory, "global apps"),
          });
        } else if (!timeout) {
          assert.strictEqual(stdout?.text, "");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
