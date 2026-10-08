// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - synchronous fixture writer used from plain and Effect tests alike.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export interface FakeCliOptions {
  /** Directory the launcher and its stub are written into. */
  readonly directory: string;
  /** Command name as callers spawn it, e.g. `codex`. */
  readonly name: string;
  /** ES module source the launcher runs with `node`. `process.argv.slice(2)` carries the CLI args. */
  readonly source: string;
  /** Environment set for the stub before it runs, on top of the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Platform the launcher is shaped for. Effect callers should pass the value
   * they read from `HostProcessPlatform` so an injected override is honoured;
   * defaults to the real host for plain tests.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Writes a fake CLI whose behaviour lives in a Node stub. On posix the
 * launcher is a `#!/bin/sh` script; on Windows it is a `.cmd` shim, since a
 * shebang file is not executable there and `resolveSpawnCommand` routes
 * `.cmd` through a shell. Returns the launcher path to hand to the code under
 * test, which on Windows carries the `.cmd` extension.
 */
export function writeFakeCli(options: FakeCliOptions): string {
  NodeFS.mkdirSync(options.directory, { recursive: true });
  const stubPath = NodePath.join(options.directory, `${options.name}-stub.mjs`);
  // The environment rides in a JSON sidecar the stub applies to itself, since
  // neither sh nor cmd.exe can quote every value (newlines, quotes, `%`) safely.
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

  if ((options.platform ?? HostProcessPlatform.defaultValue()) === "win32") {
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

/**
 * Stub source that becomes `scriptPath`: after optionally requiring a leading
 * argv prefix, it imports the script into its own process so the stub is the
 * agent. Nothing sits between the code under test and the mock, so a kill or
 * a closed stdin reaches it directly and its exit log is faithful on every
 * host. The script must not read `process.argv`; the mock agents are driven
 * by environment and stdin.
 */
export function execScriptSource(options: {
  readonly scriptPath: string;
  readonly expectedArgs?: ReadonlyArray<string>;
  /** Tab-separated argv appended here per invocation, for launch-flag assertions. */
  readonly argvLogPath?: string;
  /** Wait before handing over, for tests that race a slow startup. */
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
