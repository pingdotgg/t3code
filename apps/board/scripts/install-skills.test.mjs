import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { install } from "./install-skills.mjs";

const SCRIPT = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "install-skills.mjs",
);

// A `claude` executable that keeps its marketplaces and plugins in a JSON file and logs every call.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2).slice(1);
state.calls.push({ args, configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
const [first, second] = args;
if (first === "marketplace" && second === "list") console.log(JSON.stringify(state.marketplaces));
else if (first === "marketplace" && second === "add") state.marketplaces.push({ name: "pstack-t3", source: "github", installLocation: process.env.FAKE_CLAUDE_CLONE });
else if (first === "list") console.log(JSON.stringify(state.plugins));
else if (first === "install") state.plugins.push({ id: args[1], scope: "user", enabled: true });
else if (first === "enable") state.plugins.forEach((plugin) => (plugin.enabled = true));
fs.writeFileSync(file, JSON.stringify(state));
`;

function makeWorld(t, { seed = () => ({}), config } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "install-skills-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });

  const clone = NodePath.join(root, "clone");
  for (const name of ["how", "poteto-mode"]) {
    NodeFS.mkdirSync(NodePath.join(clone, "skills", name), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(clone, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  NodeFS.mkdirSync(NodePath.join(clone, "skills", "scripts-only"));

  const stateFile = NodePath.join(root, "state.json");
  NodeFS.writeFileSync(
    stateFile,
    JSON.stringify({ marketplaces: [], plugins: [], calls: [], ...seed(clone) }),
  );
  const codexHome = NodePath.join(root, "codex");
  if (config !== undefined) {
    NodeFS.mkdirSync(codexHome);
    NodeFS.writeFileSync(NodePath.join(codexHome, "config.toml"), config);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CLAUDE_STATE: stateFile,
    FAKE_CLAUDE_CLONE: clone,
  };
  const state = () => JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
  // Lists every entry under `dir`, showing a symlink as `path -> target` and not descending into it.
  const files = (dir, prefix = "") =>
    NodeFS.existsSync(dir)
      ? NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const path = `${prefix}${entry.name}`;
          const full = NodePath.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            return [`${path} -> ${NodePath.relative(root, NodeFS.readlinkSync(full))}`];
          }
          return entry.isDirectory() ? [path, ...files(full, `${path}/`)] : [path];
        })
      : [];
  return { root, env, state, codexHome, clone, files };
}

const mutatingCalls = (state) =>
  state.calls.filter(({ args }) =>
    ["marketplace add", "install", "enable"].includes(
      args[0] === "marketplace" ? `marketplace ${args[1]}` : args[0],
    ),
  );

NodeTest.describe("install-skills", () => {
  NodeTest.test(
    "Given a fresh home, when the installer runs twice, then the first run installs and links and the second changes nothing",
    (t) => {
      const { env, state, codexHome, files } = makeWorld(t);

      NodeAssert.deepEqual(install(env, { codexHome }), [
        "marketplace pstack-t3: added",
        "plugin pstack-t3@pstack-t3: installed",
        "codex skill how: linked",
        "codex skill poteto-mode: linked",
        "codex memories: turned on",
      ]);
      NodeAssert.deepEqual(files(codexHome), [
        "config.toml",
        "skills",
        "skills/how -> clone/skills/how",
        "skills/poteto-mode -> clone/skills/poteto-mode",
      ]);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(codexHome, "config.toml"), "utf8"),
        "[features]\nmemories = true\n\n[memories]\ndisable_on_external_context = false\n",
      );
      const callsAfterFirst = mutatingCalls(state()).length;
      const configAfterFirst = NodeFS.readFileSync(NodePath.join(codexHome, "config.toml"), "utf8");

      NodeAssert.deepEqual(install(env, { codexHome }), [
        "marketplace pstack-t3: skipped, already added",
        "plugin pstack-t3@pstack-t3: skipped, already installed and enabled",
        "codex skill how: skipped, already linked",
        "codex skill poteto-mode: skipped, already linked",
        "codex memories: skipped, already on",
      ]);
      NodeAssert.equal(mutatingCalls(state()).length, callsAfterFirst);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(codexHome, "config.toml"), "utf8"),
        configAfterFirst,
      );
      NodeAssert.deepEqual(files(codexHome), [
        "config.toml",
        "skills",
        "skills/how -> clone/skills/how",
        "skills/poteto-mode -> clone/skills/poteto-mode",
      ]);
    },
  );

  NodeTest.test(
    "Given the plugin is installed but disabled, when the installer runs, then it enables the plugin",
    (t) => {
      const { env, codexHome } = makeWorld(t, {
        seed: (clone) => ({
          marketplaces: [{ name: "pstack-t3", source: "github", installLocation: clone }],
          plugins: [{ id: "pstack-t3@pstack-t3", scope: "user", enabled: false }],
        }),
      });

      NodeAssert.deepEqual(install(env, { codexHome }).slice(0, 2), [
        "marketplace pstack-t3: skipped, already added",
        "plugin pstack-t3@pstack-t3: enabled",
      ]);
    },
  );

  NodeTest.test(
    "Given a Codex skill link that points elsewhere and a real folder, when the installer runs, then it reports both and leaves them alone",
    (t) => {
      const { root, env, codexHome, files } = makeWorld(t);
      const skills = NodePath.join(codexHome, "skills");
      NodeFS.mkdirSync(NodePath.join(root, "elsewhere", "how"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(skills, "poteto-mode"), { recursive: true });
      NodeFS.symlinkSync(NodePath.join(root, "elsewhere", "how"), NodePath.join(skills, "how"));

      NodeAssert.deepEqual(install(env, { codexHome }).slice(2, 4), [
        `codex skill how: left alone, ${NodePath.join(skills, "how")} points at ${NodePath.join(root, "elsewhere", "how")}`,
        `codex skill poteto-mode: left alone, ${NodePath.join(skills, "poteto-mode")} is not a link`,
      ]);
      NodeAssert.deepEqual(files(codexHome), [
        "config.toml",
        "skills",
        "skills/how -> elsewhere/how",
        "skills/poteto-mode",
      ]);
    },
  );

  NodeTest.test(
    "Given a Codex config with other keys, when the installer runs, then it adds only the two memory keys",
    (t) => {
      const { env, codexHome } = makeWorld(t, {
        config: [
          "# my setup",
          'model = "gpt-5"',
          "",
          "[features]",
          "web_search = true",
          "memories = false # off for now",
          "",
          "[memories]",
          "max_notes = 20",
          "",
          "[tui]",
          'theme = "dark"',
          "",
        ].join("\n"),
      });

      install(env, { codexHome });

      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(codexHome, "config.toml"), "utf8"),
        [
          "# my setup",
          'model = "gpt-5"',
          "",
          "[features]",
          "web_search = true",
          "memories = true # off for now",
          "",
          "[memories]",
          "max_notes = 20",
          "disable_on_external_context = false",
          "",
          "[tui]",
          'theme = "dark"',
          "",
        ].join("\n"),
      );
    },
  );

  NodeTest.test(
    "Given --config-dir and --codex-home, when the script runs, then claude targets that config and Codex files land in that home",
    (t) => {
      const { env, state, codexHome, files } = makeWorld(t);

      const stdout = NodeChildProcess.execFileSync(
        "node",
        [SCRIPT, "--config-dir", "/tmp/isolated", "--codex-home", codexHome],
        { env, encoding: "utf8" },
      );

      NodeAssert.match(stdout, /plugin pstack-t3@pstack-t3: installed/);
      NodeAssert.deepEqual(
        [...new Set(state().calls.map((call) => call.configDir))],
        ["/tmp/isolated"],
      );
      NodeAssert.deepEqual(files(codexHome), [
        "config.toml",
        "skills",
        "skills/how -> clone/skills/how",
        "skills/poteto-mode -> clone/skills/poteto-mode",
      ]);
    },
  );
});
