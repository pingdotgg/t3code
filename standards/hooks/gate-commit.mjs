#!/usr/bin/env node
// Claude Code PreToolUse hook: denies `git commit` and `git push` while the standards check has findings.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CHECK = NodePath.join(import.meta.dirname, "..", "check-added-diagnostics.mjs");
const COMMIT_OR_PUSH = /\bgit\s+(?:(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*(?:commit|push)\b/;

const input = JSON.parse(NodeFS.readFileSync(0, "utf8"));
if (!COMMIT_OR_PUSH.test(input.tool_input?.command ?? "")) process.exit(0);

const result = NodeChildProcess.spawnSync(process.execPath, [CHECK], {
  cwd: input.cwd,
  encoding: "utf8",
});
if (result.status === 0) process.exit(0);

const detail = (result.status === 1 ? result.stdout : result.stderr).trim();
const heading =
  result.status === 1
    ? "Blocked: the standards check has findings on lines this branch added. Fix them, then retry."
    : "Blocked: the standards check could not run.";
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${heading}\n${detail}`,
    },
  }),
);
