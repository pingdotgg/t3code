#!/usr/bin/env node
// Installs the omp-kit plugin into Claude Code's user scope.
// `--config-dir <dir>` (or CLAUDE_CONFIG_DIR) targets an isolated Claude config instead of ~/.claude.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const MARKETPLACE = "agent-board";
const PLUGIN = "omp-kit";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const MARKETPLACE_DIR = NodeURL.fileURLToPath(new URL("../plugins", import.meta.url));

/** Runs each step that is not done yet and returns one status line per step. */
export function install(env) {
  const claude = (...args) =>
    NodeChildProcess.execFileSync("claude", ["plugin", ...args], { env, encoding: "utf8" });
  const claudeJson = (...args) => JSON.parse(claude(...args, "--json"));
  const lines = [];

  const marketplace = claudeJson("marketplace", "list").find((entry) => entry.name === MARKETPLACE);
  if (marketplace && marketplace.path !== MARKETPLACE_DIR) {
    throw new Error(
      `Marketplace ${MARKETPLACE} already points at ${marketplace.path}. Remove it with \`claude plugin marketplace remove ${MARKETPLACE}\` and rerun.`,
    );
  }
  if (marketplace) {
    lines.push(`marketplace ${MARKETPLACE}: skipped, already added`);
  } else {
    claude("marketplace", "add", MARKETPLACE_DIR);
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
  return lines;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({ options: { "config-dir": { type: "string" } } });
  const env = { ...process.env };
  if (values["config-dir"]) env.CLAUDE_CONFIG_DIR = NodePath.resolve(values["config-dir"]);
  try {
    for (const line of install(env)) console.log(line);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
