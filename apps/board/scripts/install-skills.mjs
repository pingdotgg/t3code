#!/usr/bin/env node
// Installs the pstack-t3 skills for Claude Code (user-scope plugin) and Codex (linked skill folders),
// and turns on Codex memories.
// `--config-dir <dir>` (or CLAUDE_CONFIG_DIR) and `--codex-home <dir>` (or CODEX_HOME) target isolated homes instead of ~/.claude and ~/.codex.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const MARKETPLACE = "pstack-t3";
const PLUGIN = "pstack-t3";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const DEFAULT_SOURCE = "13kparkin/pstack-t3";

const toml = (text) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** Sets `key = value` inside `[table]`, editing lines so every other key and comment stays as written. */
function setTomlKey(text, table, key, value) {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (header === -1) {
    return `${toml(text)}${text === "" ? "" : "\n"}[${table}]\n${key} = ${value}\n`;
  }
  let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const own = lines.findIndex(
    (line, i) => i > header && i < end && new RegExp(`^\\s*${key}\\s*=`).test(line),
  );
  if (own !== -1) {
    lines[own] = lines[own].replace(/^(\s*\S+\s*=\s*)([^\s#]+)/, (whole, head, current) =>
      current === value ? whole : `${head}${value}`,
    );
  } else {
    let at = end;
    while (at > header + 1 && lines[at - 1].trim() === "") at -= 1;
    lines.splice(at, 0, `${key} = ${value}`);
  }
  return lines.join("\n");
}

function enableMemories(codexHome) {
  const file = NodePath.join(codexHome, "config.toml");
  const before = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  const after = setTomlKey(
    setTomlKey(before, "features", "memories", "true"),
    "memories",
    "disable_on_external_context",
    "false",
  );
  if (after === before) return "codex memories: skipped, already on";
  NodeFS.mkdirSync(codexHome, { recursive: true });
  NodeFS.writeFileSync(file, after);
  return "codex memories: turned on";
}

function linkSkill(skillsDir, name, target) {
  const link = NodePath.join(skillsDir, name);
  let existing = null;
  try {
    existing = NodeFS.lstatSync(link);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing === null) {
    NodeFS.mkdirSync(skillsDir, { recursive: true });
    NodeFS.symlinkSync(target, link, "dir");
    return `codex skill ${name}: linked`;
  }
  if (!existing.isSymbolicLink()) return `codex skill ${name}: left alone, ${link} is not a link`;
  const current = NodePath.resolve(skillsDir, NodeFS.readlinkSync(link));
  return current === target
    ? `codex skill ${name}: skipped, already linked`
    : `codex skill ${name}: left alone, ${link} points at ${current}`;
}

/** Runs each step that is not done yet and returns one status line per step. */
export function install(env, { codexHome, source = DEFAULT_SOURCE }) {
  const claude = (...args) =>
    NodeChildProcess.execFileSync("claude", ["plugin", ...args], { env, encoding: "utf8" });
  const claudeJson = (...args) => JSON.parse(claude(...args, "--json"));
  const marketplaceEntry = () =>
    claudeJson("marketplace", "list").find((entry) => entry.name === MARKETPLACE);
  const lines = [];

  if (marketplaceEntry()) {
    lines.push(`marketplace ${MARKETPLACE}: skipped, already added`);
  } else {
    claude("marketplace", "add", source);
    lines.push(`marketplace ${MARKETPLACE}: added`);
  }

  const plugin = claudeJson("list").find(
    (entry) => entry.id === PLUGIN_ID && entry.scope === "user",
  );
  if (plugin?.enabled) {
    lines.push(`plugin ${PLUGIN_ID}: skipped, already installed and enabled`);
  } else if (plugin) {
    claude("enable", PLUGIN_ID, "--scope", "user");
    lines.push(`plugin ${PLUGIN_ID}: enabled`);
  } else {
    claude("install", PLUGIN_ID, "--scope", "user");
    lines.push(`plugin ${PLUGIN_ID}: installed`);
  }

  // The marketplace clone is the one folder that `claude plugin marketplace update` keeps current, so the Codex links follow it.
  const skillsRoot = NodePath.join(marketplaceEntry().installLocation, "skills");
  for (const entry of NodeFS.readdirSync(skillsRoot).sort()) {
    const dir = NodePath.join(skillsRoot, entry);
    if (NodeFS.existsSync(NodePath.join(dir, "SKILL.md"))) {
      lines.push(linkSkill(NodePath.join(codexHome, "skills"), entry, dir));
    }
  }
  lines.push(enableMemories(codexHome));
  return lines;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "config-dir": { type: "string" },
      "codex-home": { type: "string" },
      source: { type: "string" },
    },
  });
  const env = { ...process.env };
  if (values["config-dir"]) env.CLAUDE_CONFIG_DIR = NodePath.resolve(values["config-dir"]);
  const codexHome = NodePath.resolve(
    values["codex-home"] ?? env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"),
  );
  try {
    for (const line of install(env, { codexHome, source: values.source })) console.log(line);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
