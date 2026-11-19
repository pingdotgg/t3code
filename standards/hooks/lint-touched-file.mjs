#!/usr/bin/env node
// Claude Code PostToolUse hook: reports standards findings on the lines an edit just added, as extra context.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CHECK = NodePath.join(import.meta.dirname, "..", "check-added-diagnostics.mjs");

const input = JSON.parse(NodeFS.readFileSync(0, "utf8"));
const file = input.tool_input?.file_path;
if (!file) process.exit(0);

const result = NodeChildProcess.spawnSync(
  process.execPath,
  [CHECK, "--lint-only", "--files", file],
  { cwd: input.cwd, encoding: "utf8" },
);
if (result.status === 0) process.exit(0);

const detail = (result.status === 1 ? result.stdout : result.stderr).trim();
const heading =
  result.status === 1
    ? "Standards findings on lines you just added. Fix them before moving on:"
    : "The standards check could not run:";
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `${heading}\n${detail}`,
    },
  }),
);
