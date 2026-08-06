// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe } from "vite-plus/test";
import { readWorkflowScript } from "./workflowScriptQuery.ts";

const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_script_test__");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(NodeOS.tmpdir(), "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
try {
  NodeFS.symlinkSync(outside, link);
} catch (error) {
  // Tolerate only "already exists" from a prior run — any other failure
  // (EPERM etc.) must fail setup, or the escape test below would pass
  // vacuously on "not-found" without testing containment.
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }
}
if (!NodeFS.lstatSync(link).isSymbolicLink()) {
  throw new Error("test setup: sneaky.js must be a symlink");
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
});

describe("readWorkflowScript containment", () => {
  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("rejects relative and non-js paths", () =>
    Effect.gen(function* () {
      const relative = yield* Effect.exit(readWorkflowScript({ scriptPath: "run.js" }));
      assert.equal(relative._tag, "Failure");
      const nonJs = yield* Effect.exit(
        readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts") }),
      );
      assert.equal(nonJs._tag, "Failure");
    }),
  );

  effectIt.effect("rejects paths outside the root and symlink escapes", () =>
    Effect.gen(function* () {
      const escaped = yield* Effect.exit(readWorkflowScript({ scriptPath: outside }));
      assert.equal(escaped._tag, "Failure");
      // A symlink INSIDE the root pointing outside must fail specifically on
      // realpath re-containment — a "not-found" would mean the link was
      // never exercised and the assertion proves nothing.
      const sneaky = yield* Effect.exit(
        readWorkflowScript({ scriptPath: link }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      );
      assert.equal(sneaky._tag, "Success");
      if (sneaky._tag === "Success") {
        assert.equal(sneaky.value, "outside-root");
      }
    }),
  );
});
