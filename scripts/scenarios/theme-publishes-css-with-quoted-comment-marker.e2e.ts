// @effect-diagnostics nodeBuiltinImport:off -- The scenario stages a local ACP executable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const THEME = {
  name: "Literal CSS",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
  css: '[data-chat-header]::before { content: "/*"; } /* note */ [data-chat-header]::after { content: "@import"; }',
};
const PUBLISHED = "Published Literal CSS.";
const REFUSED =
  'Theme not published: Theme "literal-css" has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.';
const ACP = `
import { request as post } from "node:http";
import { createInterface } from "node:readline";

const sessionId = "theme-publish-scenario";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const respond = (id, result) => send({ id, result });
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
let mcp = { endpoint: process.env.T3_ACP_MCP_ENDPOINT, authorization: process.env.T3_ACP_MCP_AUTHORIZATION };
let mcpSession;
async function request(message) {
  const body = await new Promise((resolve, reject) => {
    const req = post(mcp.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: mcp.authorization,
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
      },
    }, (response) => {
      mcpSession = response.headers["mcp-session-id"] ?? mcpSession;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", ...message }));
  });
  if (message.id === undefined) return;
  const payload = body.split("\\n").find((line) => line.startsWith("data: "))?.slice(6) ?? body;
  const { result, error } = JSON.parse(payload);
  if (error) throw new Error(JSON.stringify(error));
  return result;
}
async function setTheme() {
  await request({ id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "theme-agent", version: "1" },
  } });
  await request({ method: "notifications/initialized" });
  const result = await request({ id: 2, method: "tools/call", params: {
    name: "t3_theme_set", arguments: { themeId: "literal-css", theme: ${JSON.stringify(THEME)} },
  } });
  const { published, themeId } = result.structuredContent ?? {};
  if (result.isError !== true && published === true && themeId === "literal-css") {
    return ${JSON.stringify(PUBLISHED)};
  }
  const text = result.content.map(({ text }) => text).join(" ");
  return "Theme not published: " + (text.startsWith("{") ? JSON.parse(text).message : text);
}
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    respond(id, { protocolVersion: 2, info: { name: "theme-agent", version: "1.0.0" } });
  } else if (method === "session/new") {
    const env = params.mcpServers?.find((server) => server.name === "t3-code")?.env ?? [];
    const value = (name) => env.find((entry) => entry.name === name)?.value;
    mcp = {
      endpoint: value("T3_ACP_MCP_ENDPOINT") ?? mcp.endpoint,
      authorization: value("T3_ACP_MCP_AUTHORIZATION") ?? mcp.authorization,
    };
    respond(id, { sessionId });
  } else if (method === "session/prompt") {
    const text = await setTheme().catch((error) => "Theme tool failed: " + error.message);
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    respond(id, {});
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "An agent can publish a theme with comment markers inside CSS strings",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const script = NodePath.join(project, "theme-acp.mjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    await NodeFSP.writeFile(script, ACP);
    settings.defaultRuntimeMode = "full-access";
    settings.providerInstances["theme-agent"] = {
      driver: "acpRegistry",
      displayName: "Theme Agent",
      enabled: true,
      config: { source: "local", commandPath: process.execPath, commandArgs: [script] },
    };
    try {
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      const { cli } = makeState(T3_HOME);
      let threadId: string | undefined;
      let replyText = "";
      for (let attempt = 0; attempt < 8 && threadId === undefined; attempt++) {
        const started = await runPromise(
          cli(
            [
              "thread",
              "start",
              project,
              "Publish the Literal CSS theme.",
              "--title",
              "Publish theme",
              "--provider",
              "theme-agent",
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
        // Base reaches the tool and gets its CSS refusal; anything else is a broken setup.
        if (
          result.status !== "completed" ||
          (result.reply !== PUBLISHED && result.reply !== REFUSED)
        ) {
          throw new Error(
            `Theme turn did not reach the theme tool: ${started.stdout} ${started.stderr}`,
          );
        }
        threadId = result.threadId;
        replyText = result.reply;
      }
      if (threadId === undefined) throw new Error("Could not start the theme publish turn.");

      await t3.open({ threadId });
      const reply = screen.getByText(replyText, { exact: true });
      await reply.waitFor({ timeout: 60_000 });
      try {
        await expect(reply).toHaveText(PUBLISHED);
      } finally {
        await app.screenshot("theme-publish-reply");
      }
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
    }
  },
);
