import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const RULES_DIR = import.meta.dirname;
const VP = NodePath.join(RULES_DIR, "../../apps/board/node_modules/.bin/vp");
const PLUGINS = {
  "anti-slop": NodePath.join(RULES_DIR, "anti-slop/index.ts"),
  project: NodePath.join(RULES_DIR, "project/index.mjs"),
};

/**
 * Lints source text with one standards rule at `error` through the same `vp lint -c` path the
 * check uses, and returns that rule's diagnostics. `ruleId` is `<plugin>/<rule>`.
 */
export const createRuleFixture = (ruleId, options = []) => {
  const [plugin, rule] = ruleId.split("/");
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `${rule}-`));
  NodeTest.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const config = NodePath.join(directory, "oxlint.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: plugin, specifier: PLUGINS[plugin] }],
      rules: { [ruleId]: ["error", ...options] },
    }),
  );

  return (source, relativeFile = "fixture.ts") => {
    const file = NodePath.join(directory, relativeFile);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, source);
    const result = NodeChildProcess.spawnSync(VP, ["lint", "-c", config, "--format=json", file], {
      encoding: "utf8",
    });
    NodeAssert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
    return JSON.parse(result.stdout).diagnostics.filter((diagnostic) =>
      diagnostic.code?.includes(rule),
    );
  };
};
