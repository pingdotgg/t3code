// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { makeClaudeCliQuery } from "./ClaudeCliTransport.ts";

/**
 * A fake `claude` binary (Node script) that speaks the stream-json control
 * protocol just enough to exercise the transport end to end:
 *  - answers the `initialize` control request with account + commands,
 *  - on a user message, emits one assistant message then a result,
 *  - answers `interrupt`,
 *  - when FAKE_EMIT_PERMISSION=1, sends a `can_use_tool` control request and
 *    echoes the decision back as a system message.
 */
const FAKE_CLI = `
let buffer = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    send({
      type: "control_response",
      response: {
        request_id: msg.request_id,
        subtype: "success",
        response: {
          account: { email: "user@example.com", subscriptionType: "claude_pro_subscription", tokenSource: "oauth" },
          commands: [{ name: "compact", description: "Compact" }],
        },
      },
    });
    if (process.env.FAKE_EMIT_PERMISSION === "1") {
      send({
        type: "control_request",
        request_id: "perm-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
      });
    }
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    send({ type: "control_response", response: { request_id: msg.request_id, subtype: "success", response: {} } });
    return;
  }
  if (msg.type === "control_response") {
    // Our answer to the can_use_tool request — echo the decision out.
    send({ type: "system", subtype: "permission_decision", decision: msg.response?.response });
    send({ type: "result", subtype: "success", is_error: false, session_id: "s1", uuid: "r-perm" });
    return;
  }
  if (msg.type === "user") {
    send({ type: "system", subtype: "init", session_id: "s1" });
    send({ type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }] }, session_id: "s1" });
    send({ type: "result", subtype: "success", is_error: false, session_id: "s1", uuid: "r1" });
    return;
  }
}
`;

function makeFakeCli(): { dir: string; cliPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-cli-transport-"));
  const cliPath = path.join(dir, "fake-cli.mjs");
  writeFileSync(cliPath, FAKE_CLI, "utf8");
  return { dir, cliPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function* once(message: unknown): AsyncGenerator<unknown> {
  yield message;
}

async function* never(signal: AbortSignal): AsyncGenerator<unknown> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("ClaudeCliTransport", () => {
  it("streams assistant + result messages from a user prompt", async () => {
    const fake = makeFakeCli();
    try {
      const query = makeClaudeCliQuery({
        prompt: once({
          type: "user",
          session_id: "",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
          parent_tool_use_id: null,
        }) as AsyncIterable<never>,
        options: { pathToClaudeCodeExecutable: fake.cliPath } as never,
      });

      const types: string[] = [];
      for await (const message of query) {
        types.push((message as { type: string }).type);
        if ((message as { type: string }).type === "result") break;
      }
      query.close();

      assert.deepEqual(types, ["system", "assistant", "result"]);
    } finally {
      fake.cleanup();
    }
  });

  it("resolves initialize() with the account + commands payload", async () => {
    const fake = makeFakeCli();
    const abort = new AbortController();
    try {
      const query = makeClaudeCliQuery({
        prompt: never(abort.signal) as AsyncIterable<never>,
        options: { pathToClaudeCodeExecutable: fake.cliPath } as never,
      });
      const init = await query.initialize();
      abort.abort();
      query.close();

      assert.equal(init.account?.email, "user@example.com");
      assert.equal(init.account?.subscriptionType, "claude_pro_subscription");
      assert.equal(init.account?.tokenSource, "oauth");
      assert.deepEqual(init.commands, [{ name: "compact", description: "Compact" }]);
    } finally {
      fake.cleanup();
    }
  });

  it("round-trips an interrupt control request", async () => {
    const fake = makeFakeCli();
    const abort = new AbortController();
    try {
      const query = makeClaudeCliQuery({
        prompt: never(abort.signal) as AsyncIterable<never>,
        options: { pathToClaudeCodeExecutable: fake.cliPath } as never,
      });
      await query.initialize();
      // Resolves only if the fake answered the control request by request_id.
      await query.interrupt();
      abort.abort();
      query.close();
      assert.ok(true);
    } finally {
      fake.cleanup();
    }
  });

  it("bridges inbound can_use_tool to the canUseTool callback", async () => {
    const fake = makeFakeCli();
    const abort = new AbortController();
    process.env.FAKE_EMIT_PERMISSION = "1";
    try {
      let sawToolName: string | undefined;
      const query = makeClaudeCliQuery({
        prompt: never(abort.signal) as AsyncIterable<never>,
        options: {
          pathToClaudeCodeExecutable: fake.cliPath,
          canUseTool: async (toolName: string) => {
            sawToolName = toolName;
            return { behavior: "allow", updatedInput: { command: "ls" } };
          },
        } as never,
      });

      let decision: unknown;
      for await (const message of query) {
        const m = message as { type: string; subtype?: string; decision?: unknown };
        if (m.type === "system" && m.subtype === "permission_decision") decision = m.decision;
        if (m.type === "result") break;
      }
      abort.abort();
      query.close();

      assert.equal(sawToolName, "Bash");
      assert.deepEqual(decision, { behavior: "allow", updatedInput: { command: "ls" } });
    } finally {
      delete process.env.FAKE_EMIT_PERMISSION;
      fake.cleanup();
    }
  });

  it("ends the iterator cleanly when the process exits", async () => {
    const fake = makeFakeCli();
    try {
      const query = makeClaudeCliQuery({
        prompt: once({
          type: "user",
          session_id: "",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
          parent_tool_use_id: null,
        }) as AsyncIterable<never>,
        options: { pathToClaudeCodeExecutable: fake.cliPath } as never,
      });

      let count = 0;
      for await (const _message of query) {
        count += 1;
        if (count > 10) break;
      }
      // Iterator returned (process exits after closing stdin) without hanging.
      assert.ok(count >= 3);
    } finally {
      fake.cleanup();
    }
  });
});
