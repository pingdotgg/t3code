// @effect-diagnostics nodeBuiltinImport:off - exercises the standalone Node preload in a subprocess.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { deviceHubNodeArgs } from "./deviceHubNodeArgs.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe("deviceHubNodeArgs", () => {
  it("hides emulator consoles without changing other hub children or arguments", async () => {
    const capture = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawn = (...args) => console.log(JSON.stringify(args));
syncBuiltinESMExports();
`;
    const fixture = `
import { spawn } from "node:child_process";
import { join } from "node:path";
spawn(join("sdk with spaces", "emulator", "Emulator.exe"), ["-avd", "Pixel"], {
  detached: true, stdio: "ignore", env: { TEST: "preserved" }
});
spawn("ffmpeg", ["-encoders"], { detached: true, stdio: "pipe" });
spawn("emulator.exe", { detached: true, cwd: "sdk" });
console.log(JSON.stringify(process.argv.slice(1)));
`;
    const args = deviceHubNodeArgs("unused-entry.mjs", "win32");
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(capture)}`,
        ...args.slice(0, -1),
        "--input-type=module",
        "-e",
        fixture,
        "--",
        "--port",
        "12345",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const [emulator, ffmpeg, withoutArgs, argv] = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(emulator.slice(1)).toEqual([
      ["-avd", "Pixel"],
      { detached: false, stdio: "ignore", env: { TEST: "preserved" }, windowsHide: true },
    ]);
    expect(ffmpeg).toEqual(["ffmpeg", ["-encoders"], { detached: true, stdio: "pipe" }]);
    expect(withoutArgs).toEqual([
      "emulator.exe",
      { detached: false, cwd: "sdk", windowsHide: true },
    ]);
    expect(argv).toEqual(["--port", "12345"]);
  });
});
