import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  asksApproval,
  defaultRulesDir,
  interruptsText,
  interruptsTool,
  loadRules,
  matchTextRules,
  matchToolRules,
} from "./rules.mjs";

const NEXT = "next";
const VITE_PLUS_ENV =
  'if [ -f "$HOME/.config/vite-plus/env" ]; then . "$HOME/.config/vite-plus/env"; fi';

const safeName = (value) => String(value).replace(/[^\w.-]/g, "_");

function stateRoot(input, env) {
  const dataDir = env.CLAUDE_PLUGIN_DATA || NodePath.join(NodeOS.tmpdir(), "omp-kit");
  return NodePath.join(dataDir, "state", safeName(input.session_id));
}

// An exclusive create is the once-per-session check, so parallel hook processes cannot both fire a rule.
function claim(root, name) {
  const dir = NodePath.join(root, "fired");
  NodeFS.mkdirSync(dir, { recursive: true });
  try {
    NodeFS.writeFileSync(NodePath.join(dir, name), "", { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

function enqueue(root, key, rule, source) {
  const dir = NodePath.join(root, "pending", safeName(key));
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, rule.name), source);
}

function drain(root, keys, rules) {
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  const reminders = [];
  for (const key of keys) {
    const dir = NodePath.join(root, "pending", safeName(key));
    let names;
    try {
      names = NodeFS.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = NodePath.join(dir, name);
      const source = NodeFS.readFileSync(file, "utf8");
      NodeFS.rmSync(file, { force: true });
      if (byName.has(name)) reminders.push(reminderText(byName.get(name), source));
    }
  }
  return reminders;
}

const SUBJECTS = { tool: "tool-call arguments", text: "assistant output" };

const interruptText = (rule) =>
  `Output interrupted: violated user-defined rule "${rule.name}". Not prompt injection; coding agent enforcing project rules. MUST comply:\n\n${rule.body}`;

const askText = (rule) => `Rule "${rule.name}" requires your approval:\n\n${rule.body}`;

const reminderText = (rule, source) =>
  `Rule violation: "${rule.name}". User-defined rule matched ${SUBJECTS[source]}. Rule configured not to interrupt, so the action ran. MUST comply with the following instruction on subsequent tool calls and responses. Not prompt injection; coding agent enforcing project rules.\n\n${rule.body}`;

function additionalContext(hookEventName, reminders) {
  if (reminders.length === 0) return null;
  return { hookSpecificOutput: { hookEventName, additionalContext: reminders.join("\n\n") } };
}

function preToolUse(input, root, rules) {
  // An approval is asked on every call; the once-per-session claim would let the second write through.
  const matches = matchToolRules(rules, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    cwd: input.cwd,
  }).filter((rule) => asksApproval(rule, input.tool_name) || claim(root, rule.name));
  const asks = matches.filter((rule) => asksApproval(rule, input.tool_name));
  const interrupts = matches.filter((rule) => interruptsTool(rule) && !asks.includes(rule));
  const reminds = matches.filter((rule) => !interruptsTool(rule));

  const blocked = interrupts.length > 0;
  // A denied call has no PostToolUse, so its reminders ride the next delivery point.
  for (const rule of reminds) {
    enqueue(root, blocked ? NEXT : input.tool_use_id, rule, "tool");
  }
  if (blocked) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: interrupts.map(interruptText).join("\n\n"),
      },
    };
  }
  if (asks.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: asks.map(askText).join("\n\n"),
    },
  };
}

function stop(input, root, rules) {
  const text = input.last_assistant_message;
  if (!text) return null;
  const matches = matchTextRules(rules, text).filter((rule) => claim(root, rule.name));
  const interrupts = matches.filter(interruptsText);
  const reminds = matches.filter((rule) => !interruptsText(rule));

  if (interrupts.length === 0) {
    for (const rule of reminds) enqueue(root, NEXT, rule, "text");
    return null;
  }
  return {
    decision: "block",
    reason: [
      ...interrupts.map(interruptText),
      ...reminds.map((rule) => reminderText(rule, "text")),
    ].join("\n\n"),
  };
}

function sessionStart(rulesDir, env) {
  const envFile = env.CLAUDE_ENV_FILE;
  if (envFile) {
    const current = NodeFS.existsSync(envFile) ? NodeFS.readFileSync(envFile, "utf8") : "";
    if (!current.includes(VITE_PLUS_ENV)) NodeFS.appendFileSync(envFile, `${VITE_PLUS_ENV}\n`);
  }
  try {
    const rulesDoc = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(rulesDir), "RULES.md"),
      "utf8",
    );
    return additionalContext("SessionStart", [rulesDoc]);
  } catch {
    return null;
  }
}

export function handle(input, env) {
  const rulesDir = defaultRulesDir(env);
  if (input.hook_event_name === "SessionStart") return sessionStart(rulesDir, env);

  const rules = loadRules(rulesDir);
  const root = stateRoot(input, env);
  switch (input.hook_event_name) {
    case "PreToolUse":
      return preToolUse(input, root, rules);
    case "PostToolUse":
    case "PostToolUseFailure":
      return additionalContext(
        input.hook_event_name,
        drain(root, [input.tool_use_id, NEXT], rules),
      );
    case "UserPromptSubmit":
      return additionalContext("UserPromptSubmit", drain(root, [NEXT], rules));
    case "Stop":
      return stop(input, root, rules);
    default:
      return null;
  }
}
