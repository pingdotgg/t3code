// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable that runs acp-mcp-call fallbacks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const ACP = `
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const sessionId = "html-render-fallback-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (update) => send({ method: "session/update", params: { sessionId, update } });

const heredocCommand = [
  'ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call html_render - <<\\'EOF\\'',
  '{"html":"<h1>Heredoc page</h1>","title":"Heredoc proof","height":200}',
  "EOF",
].join("\\n");

const wrapperBody = [
  'const { execFileSync } = require("node:child_process");',
  'const args = [...(process.env.T3_ACP_MCP_ENTRYPOINT ? [process.env.T3_ACP_MCP_ENTRYPOINT] : []), "acp-mcp-call", "html_render", JSON.stringify({ html: "<h1>Wrapper page</h1>", title: "Wrapper proof", height: 200 })];',
  'process.stdout.write(execFileSync(process.env.T3_ACP_MCP_NODE, args, { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }));',
].join(" ");
const wrapperCommand = "node -e " + JSON.stringify(wrapperBody);

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "html-render-fallback-agent", version: "1.0.0" },
        agentCapabilities: {},
        authMethods: [],
      },
    });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "heredoc-render",
      title: "Ran command",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: heredocCommand },
    });
    const heredocStdout = execFileSync("/bin/sh", ["-c", heredocCommand], { encoding: "utf8" });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "heredoc-render",
      status: "completed",
      rawOutput: { stdout: heredocStdout, exit_code: 0 },
    });

    update({
      sessionUpdate: "tool_call",
      toolCallId: "wrapper-render",
      title: "Ran command",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: wrapperCommand },
    });
    const wrapperStdout = execFileSync(process.execPath, ["-e", wrapperBody], { encoding: "utf8" });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "wrapper-render",
      status: "completed",
      rawOutput: { stdout: wrapperStdout, exit_code: 0 },
    });

    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Rendered both fallback pages." },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "Multi-line and scripted acp-mcp-call html_render fallbacks render inline",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", {});
    const script = NodePath.join(project, "html-render-fallback-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.providerInstances["html-render-fallback-agent"] = {
      driver: "acpRegistry",
      displayName: "HTML Render Fallback Agent",
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
      // The watcher reloads settings asynchronously. Retry only before a thread was created.
      let threadId: string | undefined;
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "Render both inline pages.",
              "--title",
              "ACP html_render fallback",
              "--provider",
              "html-render-fallback-agent",
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
      if (threadId === undefined) {
        throw new Error("Could not start the html_render fallback agent's turn.");
      }

      await t3.open({ threadId });
      await expect(screen.getByText("Rendered both fallback pages.")).toBeVisible();
      const heredocIframe = browser.locator('iframe[title="Heredoc proof"]');
      const wrapperIframe = browser.locator('iframe[title="Wrapper proof"]');
      const heredocFrame = browser.frameLocator('iframe[title="Heredoc proof"]');
      const wrapperFrame = browser.frameLocator('iframe[title="Wrapper proof"]');
      try {
        await expect(heredocIframe).toBeVisible();
        await expect(wrapperIframe).toBeVisible();
        await expect(heredocFrame.locator("body")).toContainText("Heredoc page");
        await expect(wrapperFrame.locator("body")).toContainText("Wrapper page");
      } finally {
        await app.screenshot("inline-pages");
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
