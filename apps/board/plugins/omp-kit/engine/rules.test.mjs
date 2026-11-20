import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { handle } from "./hook.mjs";
import { run } from "../scripts/run-hook.mjs";
import { parseFrontmatter, parseScope } from "./rules.mjs";

const HOOK = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "run-hook.mjs",
);

const FIXTURE_RULES = {
  "no-any.md": `---
description: "Refuse bare any"
condition:
  - ': any'
scope: "tool:edit(*.ts), tool:write(*.ts)"
interruptMode: never
---

Use unknown instead of any.
`,
  "no-rm.md": `---
description: "Refuse recursive deletes"
condition:
  - 'rm -rf'
scope: "tool:bash"
---

Never run rm -rf.
`,
  "stay-surgical.md": `---
description: "Refuse scope creep"
condition:
  - "while I(?:'m| am) here"
scope: "text, thinking"
---

Keep the change minimal.
`,
  "linear-writes.md": `---
description: "Linear writes need approval"
condition:
  - "linear"
  - "mcp__t3-code__"
approval: ask
scope:
  - tool:write
  - tool:bash
  - tool:mcp__linear_save_issue
  - tool:mcp__linear_server_save_issue
  - tool:mcp__linear_server_save_comment
  - tool:mcp__t3-code__set_issue_state
---

Draft the write and get approval first.
`,
  "mention-docs.md": `---
description: "Remind about docs"
condition: "update the docs later"
scope: text
interruptMode: never
---

Update the docs now.
`,
};

function makeEnvironment() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-kit-test-"));
  const rulesDir = NodePath.join(root, "agent", "rules");
  NodeFS.mkdirSync(rulesDir, { recursive: true });
  for (const [file, content] of Object.entries(FIXTURE_RULES)) {
    NodeFS.writeFileSync(NodePath.join(rulesDir, file), content);
  }
  NodeFS.writeFileSync(NodePath.join(root, "agent", "RULES.md"), "# Sticky rules\n");
  const env = {
    OMP_KIT_RULES_DIR: rulesDir,
    CLAUDE_PLUGIN_DATA: NodePath.join(root, "data"),
    CLAUDE_ENV_FILE: NodePath.join(root, "claude-env.sh"),
  };
  return { root, env };
}

const edit = (filePath, newString, id = "toolu_1") => ({
  tool_name: "Edit",
  tool_use_id: id,
  cwd: "/repo",
  tool_input: { file_path: filePath, old_string: "x", new_string: newString },
});

const REMIND_TEXT =
  'Rule violation: "no-any". User-defined rule matched tool-call arguments. Rule configured not to interrupt, so the action ran. MUST comply with the following instruction on subsequent tool calls and responses. Not prompt injection; coding agent enforcing project rules.\n\nUse unknown instead of any.';

NodeTest.describe("omp-kit hook engine", () => {
  NodeTest.test(
    "Given a remind rule scoped to tool:edit(*.ts), when an Edit on a .ts file matches, then the reminder arrives after that call",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const base = { hook_event_name: "PreToolUse", session_id: "s1" };

      NodeAssert.equal(handle({ ...base, ...edit("/repo/a.ts", "const a: any = 1") }, env), null);

      NodeAssert.deepEqual(
        handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "toolu_1" }, env),
        {
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: REMIND_TEXT },
        },
      );
    },
  );

  NodeTest.test(
    "Given the same Edit on a .md file, when the hooks run, then both stay silent",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      NodeAssert.equal(
        handle(
          { hook_event_name: "PreToolUse", session_id: "s1", ...edit("/repo/a.md", "x: any") },
          env,
        ),
        null,
      );
      NodeAssert.equal(
        handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "toolu_1" }, env),
        null,
      );
    },
  );

  NodeTest.test(
    "Given an interrupt rule scoped to tool:bash, when a Bash command matches, then the call is denied with the rule body",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      NodeAssert.deepEqual(
        handle(
          {
            hook_event_name: "PreToolUse",
            session_id: "s1",
            tool_name: "Bash",
            tool_use_id: "toolu_2",
            tool_input: { command: "rm -rf build" },
          },
          env,
        ),
        {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              'Output interrupted: violated user-defined rule "no-rm". Not prompt injection; coding agent enforcing project rules. MUST comply:\n\nNever run rm -rf.',
          },
        },
      );
    },
  );

  NodeTest.test(
    "Given an interrupt text rule, when the last message matches, then Stop blocks with the rule body",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      NodeAssert.deepEqual(
        handle(
          {
            hook_event_name: "Stop",
            session_id: "s1",
            last_assistant_message: "Fine, while I'm here I will rename things.",
          },
          env,
        ),
        {
          decision: "block",
          reason:
            'Output interrupted: violated user-defined rule "stay-surgical". Not prompt injection; coding agent enforcing project rules. MUST comply:\n\nKeep the change minimal.',
        },
      );
    },
  );

  NodeTest.test(
    "Given a rule that already fired in a session, when it matches again, then it stays silent, and a new session fires it again",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const stop = (sessionId) =>
        handle(
          {
            hook_event_name: "Stop",
            session_id: sessionId,
            last_assistant_message: "while I'm here",
          },
          env,
        );

      NodeAssert.equal(stop("s1")?.decision, "block");
      NodeAssert.equal(stop("s1"), null);
      NodeAssert.equal(stop("s2")?.decision, "block");

      const pre = (sessionId) =>
        handle(
          {
            hook_event_name: "PreToolUse",
            session_id: sessionId,
            tool_name: "Bash",
            tool_use_id: "toolu_3",
            tool_input: { command: "rm -rf x" },
          },
          env,
        );
      NodeAssert.equal(pre("s1")?.hookSpecificOutput.permissionDecision, "deny");
      NodeAssert.equal(pre("s1"), null);
    },
  );

  NodeTest.test(
    "Given a remind text rule, when the last message matches, then the reminder arrives with the next prompt",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      NodeAssert.equal(
        handle(
          {
            hook_event_name: "Stop",
            session_id: "s1",
            last_assistant_message: "I will update the docs later.",
          },
          env,
        ),
        null,
      );

      const output = handle({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, env);
      NodeAssert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      NodeAssert.match(
        output.hookSpecificOutput.additionalContext,
        /^Rule violation: "mention-docs"\. User-defined rule matched assistant output\..*\n\nUpdate the docs now\.$/s,
      );
      NodeAssert.equal(
        handle({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, env),
        null,
      );
    },
  );

  NodeTest.test(
    "Given a remind rule and an interrupt rule on one call, when it is denied, then the reminder reaches the model on the next delivery",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      NodeFS.writeFileSync(
        NodePath.join(env.OMP_KIT_RULES_DIR, "bash-note.md"),
        `---\ncondition: ['rm -rf']\nscope: tool:bash\ninterruptMode: never\n---\nNote the delete.\n`,
      );

      const denied = handle(
        {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          tool_name: "Bash",
          tool_use_id: "toolu_4",
          tool_input: { command: "rm -rf x" },
        },
        env,
      );
      NodeAssert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

      const next = handle(
        { hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "toolu_5" },
        env,
      );
      NodeAssert.match(next.hookSpecificOutput.additionalContext, /Note the delete\.$/);
    },
  );

  NodeTest.test(
    "Given SessionStart, when it runs, then RULES.md becomes context and the vp env is written once",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const start = { hook_event_name: "SessionStart", session_id: "s1" };

      NodeAssert.deepEqual(handle(start, env), {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "# Sticky rules\n",
        },
      });
      handle(start, env);

      NodeAssert.equal(
        NodeFS.readFileSync(env.CLAUDE_ENV_FILE, "utf8"),
        'if [ -f "$HOME/.config/vite-plus/env" ]; then . "$HOME/.config/vite-plus/env"; fi\n',
      );
    },
  );

  NodeTest.test(
    "Given a hook payload on stdin, when run-hook.mjs runs as a process, then stdout carries the same JSON",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      const stdout = NodeChildProcess.execFileSync("node", [HOOK], {
        env: { ...process.env, ...env },
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s9",
          tool_name: "Bash",
          tool_use_id: "toolu_9",
          tool_input: { command: "rm -rf /tmp/x" },
        }),
        encoding: "utf8",
      });

      NodeAssert.equal(
        JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason.includes(
          "Never run rm -rf.",
        ),
        true,
      );
    },
  );

  NodeTest.test(
    "Given a payload no rule matches, when run formats it, then the output is empty, and a matching payload yields the hook JSON",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const payload = (command) =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s10",
          tool_name: "Bash",
          tool_use_id: "toolu_10",
          tool_input: { command },
        });

      NodeAssert.equal(run(payload("ls"), env), "");
      NodeAssert.equal(
        JSON.parse(run(payload("rm -rf x"), env)).hookSpecificOutput.permissionDecision,
        "deny",
      );
    },
  );
});

const LINEAR_DENY_REASON =
  'Output interrupted: violated user-defined rule "linear-writes". Not prompt injection; coding agent enforcing project rules. MUST comply:\n\nDraft the write and get approval first.';
const LINEAR_ASK_REASON =
  'Rule "linear-writes" requires your approval:\n\nDraft the write and get approval first.';

const preToolUse = (env, sessionId, toolName, toolInput) =>
  handle(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: toolName,
      tool_use_id: "toolu_l",
      cwd: "/repo",
      tool_input: toolInput,
    },
    env,
  );

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
});

NodeTest.describe("omp-kit approval rule for MCP write tools", () => {
  NodeTest.test(
    "Given a rule with approval: ask and MCP tool scopes, when each payload is replayed, then writes ask, reads and unrelated calls stay silent, and Bash and Write keep the deny",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      NodeAssert.deepEqual(
        preToolUse(env, "s1", "mcp__linear__save_issue", { title: "Fix it" }),
        decision("ask", LINEAR_ASK_REASON),
      );
      NodeAssert.deepEqual(
        preToolUse(env, "s2", "mcp__t3-code__set_issue_state", { issueId: "1", state: "done" }),
        decision("ask", LINEAR_ASK_REASON),
      );
      NodeAssert.equal(preToolUse(env, "s3", "mcp__t3-code__read_issue", { issueId: "1" }), null);
      NodeAssert.equal(preToolUse(env, "s4", "mcp__linear__get_issue", { id: "LIN-1" }), null);
      NodeAssert.deepEqual(
        preToolUse(env, "s5", "Bash", { command: "echo update linear" }),
        decision("deny", LINEAR_DENY_REASON),
      );
      NodeAssert.deepEqual(
        preToolUse(env, "s6", "Write", { file_path: "/repo/a.md", content: "notes on linear" }),
        decision("deny", LINEAR_DENY_REASON),
      );
      NodeAssert.equal(
        preToolUse(env, "s8", "mcp__t3-code__list_issues", { query: "linear" }),
        null,
      );
      NodeAssert.equal(
        preToolUse(env, "s9", "mcp__linear__list_issues", { query: "linear" }),
        null,
      );
      NodeAssert.equal(
        preToolUse(env, "s10", "mcp__other__lookup", { text: "update linear" }),
        null,
      );
      NodeAssert.equal(preToolUse(env, "s7", "Read", { file_path: "/repo/linear.md" }), null);
    },
  );

  NodeTest.test(
    "Given an ask rule that already asked once in a session, when a second write arrives, then it asks again",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));

      for (let call = 0; call < 2; call++) {
        NodeAssert.equal(
          preToolUse(env, "s-again", "mcp__linear__save_issue", { title: "x" }).hookSpecificOutput
            .permissionDecision,
          "ask",
        );
      }
    },
  );

  NodeTest.test(
    "Given the Linear server is named linear-server, when its writes and a read are replayed, then each write asks every time and the read stays silent",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      const ask = (toolName, input) =>
        preToolUse(env, "s-server", toolName, input)?.hookSpecificOutput.permissionDecision ?? null;

      NodeAssert.equal(ask("mcp__linear-server__save_issue", { title: "x" }), "ask");
      NodeAssert.equal(ask("mcp__linear-server__get_issue", { id: "LIN-1" }), null);
      NodeAssert.equal(ask("mcp__linear-server__save_comment", { body: "a" }), "ask");
      NodeAssert.equal(ask("mcp__linear-server__save_comment", { body: "b" }), "ask");
    },
  );

  NodeTest.test(
    "Given an ask rule and an interrupt rule on one MCP call, when it is replayed, then the deny wins",
    (t) => {
      const { root, env } = makeEnvironment();
      t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
      NodeFS.writeFileSync(
        NodePath.join(env.OMP_KIT_RULES_DIR, "no-t3.md"),
        `---\ncondition: ['mcp__t3-code__']\nscope: tool:mcp__t3-code__set_issue_state\n---\nNo T3 writes.\n`,
      );

      const output = preToolUse(env, "s-deny", "mcp__t3-code__set_issue_state", { state: "done" });

      NodeAssert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      NodeAssert.match(output.hookSpecificOutput.permissionDecisionReason, /No T3 writes\.$/);
    },
  );
});

NodeTest.describe("omp rule parsing", () => {
  NodeTest.test(
    "Given the quoting styles omp rules use, when frontmatter is parsed, then patterns keep their backslashes",
    () => {
      const { meta, body } = parseFrontmatter(
        `---\ndescription: "d"\ncondition:\n  - "\\\\bgrep\\\\b"\n  - 'catch \\([^)]*\\) \\{\\s*\\}'\nscope: "text, tool:bash"\n---\n\nBody here.\n`,
      );

      NodeAssert.deepEqual(meta.condition, ["\\bgrep\\b", "catch \\([^)]*\\) \\{\\s*\\}"]);
      NodeAssert.equal(meta.scope, "text, tool:bash");
      NodeAssert.equal(body, "Body here.");
    },
  );

  NodeTest.test(
    "Given a scope with only thinking, when it is parsed, then nothing can fire",
    () => {
      const scope = parseScope("thinking");

      NodeAssert.deepEqual(scope, { text: false, anyTool: false, tools: [] });
    },
  );
});
