// @effect-diagnostics nodeBuiltinImport:off -- Runs the profiling preload in a real Node subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decodeTrace = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      traceEvents: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          ts: Schema.Number,
          dur: Schema.Number,
          args: Schema.optional(
            Schema.Struct({
              stage: Schema.optional(Schema.String),
              url: Schema.optional(Schema.String),
              parentURL: Schema.optional(Schema.String),
              importedBy: Schema.optional(Schema.String),
              installed: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  ),
);

const decodeRunner = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, args: Schema.Array(Schema.String) })),
);

it("attributes ESM and CommonJS imports without changing module execution", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-startup-profile-"));
  try {
    NodeFS.writeFileSync(NodePath.join(directory, "package.json"), '{"type":"module"}');
    const fixtures = {
      "root.mjs": `
        import { value } from './dependency.mjs';
        import strict from './strict.cjs';
        import loose from './loose.cjs';
        import interop from './interop.cjs';
        if (value !== 42 || strict !== undefined || loose !== true || interop !== 9) {
          throw Error('Profiling changed module semantics');
        }
      `,
      "dependency.mjs": "export const value = 42;",
      "strict.cjs": `/* retain the directive */\n"use strict"; module.exports = (function () { return this; })();`,
      "loose.cjs": "module.exports = (function () { return this; })() === globalThis;",
      "interop.cjs": "module.exports = require('./required.js').value;",
      "required.js": "export const value = 9;",
    };
    for (const [name, source] of Object.entries(fixtures)) {
      NodeFS.writeFileSync(NodePath.join(directory, name), source);
    }
    const output = NodePath.join(directory, "capture");
    const root = NodeURL.pathToFileURL(
      NodeFS.realpathSync(NodePath.join(directory, "root.mjs")),
    ).href;
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--no-node-snapshot",
        "--import",
        NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "profile-startup.mjs")).href,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(root)})`,
      ],
      { env: { ...process.env, NODE_OPTIONS: "", T3CODE_STARTUP_PROFILE_DIR: output } },
    );
    const spans = NodeFS.readdirSync(output)
      .filter((name) => name.endsWith(".modules.json"))
      .flatMap(
        (name) => decodeTrace(NodeFS.readFileSync(NodePath.join(output, name), "utf8")).traceEvents,
      );
    expect(spans.some((span) => span.args?.installed === true)).toBe(true);
    for (const name of Object.keys(fixtures)) {
      const url = NodeURL.pathToFileURL(NodeFS.realpathSync(NodePath.join(directory, name))).href;
      const stages = spans.filter((span) => span.args?.url === url).map((span) => span.args?.stage);
      expect(stages, name).toEqual(
        expect.arrayContaining(
          name === "required.js" ? ["link", "require-esm"] : ["prepare", "evaluate"],
        ),
      );
    }
    const prepared = spans.find(
      (span) => span.args?.url === root && span.args?.stage === "prepare",
    );
    const linked = spans.find((span) => span.args?.url === root && span.args?.stage === "link");
    if (!prepared || !linked) throw Error("Missing root module preparation/link boundaries");
    expect(prepared.ts + prepared.dur).toBeLessThanOrEqual(linked.ts);
    const dependency = NodeURL.pathToFileURL(
      NodeFS.realpathSync(NodePath.join(directory, "dependency.mjs")),
    ).href;
    expect(
      spans.find((span) => span.args?.url === dependency && span.args?.stage === "link")?.args
        ?.importedBy,
    ).toBe(root);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("captures only the dev runner and preserves its exit status", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-startup-launcher-"));
  try {
    NodeFS.mkdirSync(NodePath.join(directory, "scripts"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "scripts/dev-runner.ts"),
      "console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));",
    );
    const output = NodePath.join(directory, "capture");
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "profile-startup.mjs"), "--no-seed"],
      {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: "", T3CODE_STARTUP_PROFILE_DIR: output },
        encoding: "utf8",
      },
    );
    const runner = decodeRunner(stdout.trim().split("\n").at(-1));
    expect(runner.args).toEqual(["dev", "--no-seed"]);
    expect(NodeFS.readdirSync(output).sort()).toEqual(
      ["cpuprofile", "modules.json", "process.json"].map((suffix) => `${runner.pid}-0.${suffix}`),
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, "scripts/dev-runner.ts"),
      "process.kill(process.pid, 'SIGTERM');",
    );
    const interrupted = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "profile-startup.mjs")],
      {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: "", T3CODE_STARTUP_PROFILE_DIR: output },
      },
    );
    expect(interrupted.error).toBeUndefined();
    expect(interrupted.status).toBe(1);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
