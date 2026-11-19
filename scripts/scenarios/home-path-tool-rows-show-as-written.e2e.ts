// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const HOME_PATH = "~/.claude/CLAUDE.md";
const REPLY = "Updated your global instructions.";
const ACP = `
import { createInterface } from "node:readline";

const sessionId = "home-path-scenario";
const path = ${JSON.stringify(HOME_PATH)};
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read", status: "pending", rawInput: { path } });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "# Global instructions" } }],
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      kind: "edit",
      title: "Edit global instructions",
      status: "completed",
      content: [{
        type: "diff",
        path,
        oldText: "# Global instructions\\n",
        newText: "# Global instructions\\nPrefer small diffs.\\n",
        changes: [{ operation: "update", path }],
      }],
    });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(REPLY)} } });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "Files an agent read and edited in the home folder show their ~/ paths, not paths under the project",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "home-path-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["home-path-agent"] = {
      driver: "acpRegistry",
      displayName: "Home path agent",
      enabled: true,
      config: { source: "local", commandPath: process.execPath, commandArgs: [script] },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      const { cli } = makeState(T3_HOME);
      // The watcher reloads settings asynchronously. Retry only before a thread was created.
      let threadId: string | undefined;
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "Tidy up my global instructions",
              "--title",
              "Home path tools",
              "--provider",
              "home-path-agent",
              "--model",
              "default",
              "--wait",
              "--json",
            ],
            [0, 1],
          ),
        );
        if (!started.stdout.includes("threadId")) continue;
        threadId = (JSON.parse(started.stdout) as { threadId: string }).threadId;
      }
      if (threadId === undefined) throw new Error("Could not start the home path turn.");

      await t3.open({ threadId });
      await screen.getByText(REPLY, { exact: true }).waitFor({ timeout: 60_000 });
      await screen.getByRole("button", "Worked for", { exact: false }).tap();
      await screen.getByRole("button", "Read 1 file and changed 1 file").tap();
      await screen.getByRole("button", /^Read .*CLAUDE\.md/).tap();
      await screen.getByText('"# Global instructions"', { exact: true }).waitFor();
      await app.screenshot("read-and-edit-rows");
      await expect(screen.getByText("/~/", { exact: false })).toHaveCount(0);
      await expect(screen.getByText(HOME_PATH, { exact: true })).toHaveCount(2);
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
