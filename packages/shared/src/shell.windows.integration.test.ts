import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { expect, it } from "vite-plus/test";

import { resolveSpawnCommand } from "./shell.ts";

it.runIf(process.platform === "win32")(
  "round-trips hostile argv through a real cmd.exe .cmd shim under spaces and Unicode",
  async () => {
    const outer = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 cmd "));
    const root = NodePath.join(outer, "T3 Code José & QA");
    NodeFS.mkdirSync(root, { recursive: true });
    const recorderPath = NodePath.join(root, "record-argv.cjs");
    const outputPath = NodePath.join(root, "argv.json");
    const shimPath = NodePath.join(root, "argv-recorder.cmd");
    const expected = [
      "plain",
      "space value",
      "amp&ersand",
      "pipe|value",
      "%PATH%",
      "bang!value",
      "caret^value",
      "(paren)",
      'quote"value',
      "trailing\\",
      "雪 José",
    ];

    NodeFS.writeFileSync(
      recorderPath,
      `const fs = require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`,
    );
    NodeFS.writeFileSync(
      shimPath,
      `@echo off\r\n"${process.execPath}" "${recorderPath}" "${outputPath}" %*\r\n`,
    );

    try {
      const resolved = await Effect.runPromise(
        resolveSpawnCommand(shimPath, expected, {
          env: {
            ...process.env,
            PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          },
        }),
      );
      const child = NodeChildProcess.spawnSync(resolved.command, resolved.args, {
        cwd: root,
        env: process.env,
        shell: resolved.shell,
        encoding: "utf8",
        windowsHide: true,
      });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(NodeFS.existsSync(outputPath)).toBe(true);
      expect(JSON.parse(NodeFS.readFileSync(outputPath, "utf8"))).toEqual(expected);
    } finally {
      NodeFS.rmSync(outer, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
  },
);
