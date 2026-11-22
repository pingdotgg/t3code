// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable and its release gate.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const FILE = "location-proof.ts";
const ACP = `
import { unwatchFile, watchFile } from "node:fs";
import { createInterface } from "node:readline";

const [file, gate] = process.argv.slice(2);
const sessionId = "location-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "location-agent", version: "1.0.0" }, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit", kind: "edit", status: "in_progress" });
    // The agent names the file it edits only after announcing the tool call.
    update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", locations: [{ path: file }] });
    watchFile(gate, { interval: 100 }, (stat) => {
      if (stat.nlink === 0) return;
      unwatchFile(gate);
      update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" });
      send({ id, result: { stopReason: "end_turn" } });
    });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "A running ACP edit names the file a location-only tool_call_update reports",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", { [`src/${FILE}`]: "export {};\n" });
    const script = NodePath.join(project, "location-acp.mjs");
    const gate = NodePath.join(project, "release-edit");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["location-agent"] = {
      driver: "acpRegistry",
      displayName: "Location Agent",
      enabled: true,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: [script, NodePath.join(project, "src", FILE), gate],
      },
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
              "Edit the proof file.",
              "--title",
              "Location-only update",
              "--provider",
              "location-agent",
              "--model",
              "default",
              "--json",
            ],
            [0, 1],
          ),
        );
        if (!started.stdout.includes("threadId")) continue;
        threadId = (JSON.parse(started.stdout) as { threadId: string }).threadId;
      }
      if (threadId === undefined) throw new Error("Could not start the location agent's turn.");

      await t3.open({ threadId });
      await screen.getByText("Working for", { exact: false }).first().waitFor({ timeout: 60_000 });
      try {
        await expect(screen.getByRole("button", /^demo\/src\/location-proof\.ts$/)).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await app.screenshot("running-edit-row");
      }
    } finally {
      try {
        await NodeFSP.writeFile(gate, "");
      } finally {
        await NodeFSP.writeFile(settingsPath, originalSettings);
      }
    }
  },
);
