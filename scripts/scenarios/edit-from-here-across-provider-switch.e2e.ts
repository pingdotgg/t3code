// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable beside the workspace.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const ACP = `
import { createInterface } from "node:readline";

const sessionId = "first-agent-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "first-agent", version: "1.0.0" }, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First agent reply." } });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "Edit from here rewinds a message sent after switching providers",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "first-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["first-agent"] = {
      driver: "acpRegistry",
      displayName: "First Agent",
      enabled: true,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: [script],
      },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      const { cli } = makeState(T3_HOME);
      let threadId: string | undefined;
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "First turn on first agent",
              "--title",
              "Switch rollback",
              "--provider",
              "first-agent",
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
      if (threadId === undefined) throw new Error("Could not start the first agent's turn.");

      await t3.open({ threadId });
      await expect(screen.getByText("First agent reply.")).toBeVisible({ timeout: 30_000 });

      await browser.locator("[data-chat-provider-model-picker-label]").first().tap();
      await browser.keyboard.type("Multi-turn");
      await browser.keyboard.press("Enter");
      await browser.keyboard.press("Escape");

      const prompt = "Second turn after switching providers";
      const composer = screen.getByRole("textbox");
      await composer.pressSequentially(prompt);
      await browser.keyboard.press("Enter");

      await expect(screen.getByText("first fixture turn complete")).toBeVisible({
        timeout: 60_000,
      });
      await expect(screen.getByRole("button", "Stop")).toHaveCount(0, { timeout: 60_000 });

      const userBubble = browser
        .locator("[data-user-message-bubble]")
        .filter({ hasText: prompt })
        .first();
      await expect(userBubble).toBeVisible({ timeout: 30_000 });
      await userBubble.hover();
      await expect(screen.getByRole("button", "Copy prompt link").last()).toBeVisible({
        timeout: 5_000,
      });

      const editFromHere = screen.getByRole("button", "Edit from here");
      try {
        await expect(editFromHere).toBeVisible({ timeout: 5_000 });
        await expect(editFromHere).toBeEnabled({ timeout: 5_000 });
      } finally {
        await userBubble.hover();
        await app.screenshot("after-provider-switch");
      }

      await editFromHere.tap();
      await screen.getByRole("button", "Revert and keep changes").tap();
      await expect(composer).toContainText(prompt, { timeout: 30_000 });
      await app.screenshot("restored-into-composer");
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
