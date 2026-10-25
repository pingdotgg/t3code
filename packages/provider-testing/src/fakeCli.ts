// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - synchronous fixture writer used from plain and Effect tests alike.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

export interface FakeCliOptions {
  readonly directory: string;
  readonly name: string;
  readonly source: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

/** Returns a POSIX shell launcher or Windows .cmd shim; shebang files are not executable on Windows. */
export function writeFakeCli(options: FakeCliOptions): string {
  NodeFS.mkdirSync(options.directory, { recursive: true });
  const stubPath = NodePath.join(options.directory, `${options.name}-stub.mjs`);
  // JSON sidecars avoid shell quoting failures for arbitrary environment values.
  const envPath = NodePath.join(options.directory, `${options.name}-env.json`);
  NodeFS.writeFileSync(envPath, JSON.stringify(options.env ?? {}), "utf8");
  NodeFS.writeFileSync(
    stubPath,
    [
      'import { readFileSync as readFakeCliEnv } from "node:fs";',
      `Object.assign(process.env, JSON.parse(readFakeCliEnv(${JSON.stringify(envPath)}, "utf8")));`,
      options.source,
    ].join("\n"),
    "utf8",
  );

  if ((options.platform ?? HostProcess.Platform.defaultValue()) === "win32") {
    const launcherPath = NodePath.join(options.directory, `${options.name}.cmd`);
    NodeFS.writeFileSync(
      launcherPath,
      ["@echo off", `node "%~dp0${options.name}-stub.mjs" %*`, "exit /b %ERRORLEVEL%", ""].join(
        "\r\n",
      ),
      "utf8",
    );
    return launcherPath;
  }

  const launcherPath = NodePath.join(options.directory, options.name);
  NodeFS.writeFileSync(
    launcherPath,
    ["#!/bin/sh", `exec node "$(dirname "$0")/${options.name}-stub.mjs" "$@"`, ""].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

export function execScriptSource(options: {
  readonly scriptPath: string;
  readonly expectedArgs?: ReadonlyArray<string>;
  readonly argvLogPath?: string;
  readonly delayMs?: number;
}): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const args = process.argv.slice(2);",
    ...(options.argvLogPath === undefined
      ? []
      : [
          `appendFileSync(${JSON.stringify(options.argvLogPath)}, args.join(${JSON.stringify("\t")}) + ${JSON.stringify("\n")});`,
        ]),
    ...(options.delayMs === undefined
      ? []
      : [`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.delayMs});`]),
    `const expected = ${JSON.stringify(options.expectedArgs ?? [])};`,
    "if (expected.some((value, index) => args[index] !== value)) {",
    '  process.stderr.write(`unexpected args: ${args.join(" ")}\\n`);',
    "  process.exit(11);",
    "}",
    `await import(pathToFileURL(${JSON.stringify(options.scriptPath)}).href);`,
    "",
  ].join("\n");
}
