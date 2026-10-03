// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, assert } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerSettings from "../serverSettings.ts";
import { readWorkflowScript } from "./workflowScriptQuery.ts";

// A Claude instance with its own home: scripts live under <home>/projects,
// never the real ~/.claude/projects.
const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-script-test-"));
const claudeHome = NodePath.join(sandbox, "claude-home");
const root = NodePath.join(claudeHome, "projects", "-repo");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(sandbox, "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
// Planted only where the host allows it; the escape test is skipped
// otherwise rather than passing vacuously on "not-found".
if (symlinksSupported) {
  NodeFS.symlinkSync(outside, link);
  if (!NodeFS.lstatSync(link).isSymbolicLink()) {
    throw new Error("test setup: sneaky.js must be a symlink");
  }
}

afterAll(() => {
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerSettings.ServerSettingsService.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: claudeHome },
      },
    },
  }),
);

effectIt.layer(testLayer)("readWorkflowScript containment", (it) => {
  it.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  it.effect("rejects relative and non-js paths", () =>
    Effect.gen(function* () {
      const relative = yield* Effect.exit(readWorkflowScript({ scriptPath: "run.js" }));
      assert.equal(relative._tag, "Failure");
      const nonJs = yield* Effect.exit(
        readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts") }),
      );
      assert.equal(nonJs._tag, "Failure");
    }),
  );

  it.effect.skipIf(!symlinksSupported)("rejects paths outside the root and symlink escapes", () =>
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
