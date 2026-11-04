// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { vitePlusCommand } from "./check-changed-command.ts";

function fixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 check & (vp) % ! ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "check-changed-command.ts"),
    NodePath.join(root, "command.ts"),
  );
  write("package.json", JSON.stringify({ type: "module" }));
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `import fs from 'node:fs';
     fs.writeFileSync(process.env.CALL_FILE, JSON.stringify({
       args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.ARG_MARKER
     }));
     process.stdout.write('vp stdout');
     process.stderr.write('vp stderr');
     process.exit(Number(process.env.EXIT_STATUS));`,
  );
  write(
    "run.mjs",
    `import { spawn, spawnSync } from 'node:child_process';
     import { vitePlusCommand } from './command.ts';
     const [command, args] = vitePlusCommand(process.argv.slice(3), 'win32');
     const options = { cwd: process.env.CHILD_CWD, env: process.env };
     if (process.argv[2] === 'sync') {
       const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
       process.stdout.write(result.stdout ?? '');
       process.stderr.write(result.stderr ?? '');
       if (result.error) console.error(result.error.message);
       process.exitCode = result.status ?? 1;
     } else {
       const child = spawn(command, args, options);
       child.stdout.pipe(process.stdout);
       child.stderr.pipe(process.stderr);
       child.on('error', error => console.error(error.message));
       child.on('close', status => { process.exitCode = status ?? 1; });
     }`,
  );
  const cwd = NodePath.join(root, "temporary install");
  NodeFS.mkdirSync(cwd);
  return {
    cwd,
    run(mode: string, args: Array<string>, status: number) {
      return NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(root, "run.mjs"), mode, ...args],
        {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
          env: {
            ...process.env,
            // No vp, vp.cmd or node launcher can be found on PATH.
            PATH: root,
            Path: root,
            CALL_FILE: NodePath.join(root, "call.json"),
            CHILD_CWD: cwd,
            ARG_MARKER: "inherited",
            EXIT_STATUS: String(status),
          },
        },
      );
    },
    call: () => JSON.parse(NodeFS.readFileSync(NodePath.join(root, "call.json"), "utf8")),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(["linux", "darwin"] as const)("keeps the existing %s launcher", (platform) => {
  const args = ["fmt", "--check", "a file.ts"];
  expect(vitePlusCommand(args, platform)).toEqual(["vp", args]);
});

it.each(["sync", "async"])("launches the Windows CLI without a shim (%s)", (mode) => {
  using project = fixture();
  const args = [
    "fmt",
    "--check",
    "space & (draft) %PATH% ! ^ 研究.ts",
    'embedded"quote',
    "trailing\\",
    "",
    "& echo injected>injected.txt",
  ];
  const result = project.run(mode, args, 0);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("vp stdout");
  expect(result.stderr).toBe("vp stderr");
  expect(project.call()).toEqual({ args, cwd: project.cwd, marker: "inherited" });
  expect(NodeFS.existsSync(NodePath.join(project.cwd, "injected.txt"))).toBe(false);
});

it.each(["sync", "async"])("preserves a failing CLI's output and status (%s)", (mode) => {
  using project = fixture();
  const args = ["install", "--lockfile-only", "--ignore-scripts"];
  const result = project.run(mode, args, 23);
  expect(result.status).toBe(23);
  expect(result.stdout).toBe("vp stdout");
  expect(result.stderr).toBe("vp stderr");
  expect(project.call()).toEqual({ args, cwd: project.cwd, marker: "inherited" });
});
