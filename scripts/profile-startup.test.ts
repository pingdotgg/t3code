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
        "--import",
        NodePath.join(import.meta.dirname, "profile-startup.mjs"),
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
