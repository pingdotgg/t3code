// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const DRAFT = "Draft summary the agent discarded";
const REPLY = "Compaction did not finish.";
const ACP = `
import { createInterface } from "node:readline";

const sessionId = "compaction-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const respond = (id, result) => send({ id, result });
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    respond(id, { protocolVersion: 2, info: { name: "compaction-agent", version: "1.0.0" } });
  } else if (method === "session/new") {
    respond(id, { sessionId });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" });
    update({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "compact-1",
      content: { type: "text", text: ${JSON.stringify(DRAFT)} },
    });
    // The agent discards its draft when the compaction fails.
    update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "failed", summary: null });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(REPLY)} } });
    update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    respond(id, {});
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "A failed ACP compaction does not show the draft summary its agent cleared",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "compaction-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["compaction-agent"] = {
      driver: "acpRegistry",
      displayName: "Compaction Agent",
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
              "Compact the context.",
              "--title",
              "Failed compaction",
              "--provider",
              "compaction-agent",
              "--model",
              "default",
              "--wait",
              "--json",
            ],
            [0, 1],
          ),
        );
        if (!started.stdout.includes("threadId")) continue;
        const result = JSON.parse(started.stdout) as {
          threadId: string;
          status: string;
          reply: string | null;
        };
        if (result.status !== "completed" || !result.reply?.includes(REPLY)) {
          throw new Error(`Compaction turn did not complete: ${started.stdout} ${started.stderr}`);
        }
        threadId = result.threadId;
      }
      if (threadId === undefined) throw new Error("Could not start the compaction turn.");

      await t3.open({ threadId });
      await screen.getByText(REPLY, { exact: true }).waitFor({ timeout: 60_000 });
      const separator = screen.getByRole("separator", /^Context compaction failed/);
      await separator.waitFor({ timeout: 15_000 });
      try {
        await expect(separator).toHaveText("Context compaction failed");
      } finally {
        await app.screenshot("failed-compaction-row");
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
