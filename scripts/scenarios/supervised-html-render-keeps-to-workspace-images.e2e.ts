import { ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PROBE = ProviderInstanceId.make("htmlProbe");
// Eight bytes are enough for the server's PNG check.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

// An ACP agent that reaches T3's tools the way every ACP agent does: it starts the MCP server
// T3 names in `session/new` and calls `html_render` with the HTML between the prompt's markers.
const PROBE_AGENT = String.raw`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const sessions = new Map();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const callTool = (server, name, args) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 1) {
      write({ method: "notifications/initialized" });
      write({ id: 2, method: "tools/call", params: { name, arguments: args } });
    } else if (message.id === 2) {
      child.kill();
      resolve(message.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(message.error) }] });
    }
  });
  child.on("error", reject);
  write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "html-probe", version: "1" } } });
});
const handle = async (message) => {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [], agentInfo: { name: "html-probe", version: "1" } };
    case "session/new": {
      const sessionId = "probe-" + Math.random().toString(36).slice(2);
      sessions.set(sessionId, params.mcpServers ?? []);
      return { sessionId, models: { currentModelId: "default", availableModels: [{ modelId: "default", name: "Probe" }] } };
    }
    case "session/prompt": {
      const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
      const html = /<!--probe-->([\s\S]*?)<!--\/probe-->/.exec(text)?.[1] ?? "";
      const server = (sessions.get(params.sessionId) ?? []).find((entry) => entry.name === "t3-code");
      let summary;
      if (server === undefined) {
        summary = "PROBE NO-T3-TOOLS";
      } else {
        const result = await callTool(server, "html_render", { html, title: "Probe", height: 120 });
        const said = (result.content ?? []).map((part) => part.text ?? "").join(" ");
        const attachmentId = result.structuredContent?.htmlRender?.attachmentId ?? "";
        summary = (result.isError ? "PROBE REFUSED " : "PROBE PUBLISHED " + attachmentId + " ") + said.slice(0, 400);
      }
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary } } } });
      return { stopReason: "end_turn" };
    }
    case "session/close":
    case "session/set_model":
    case "session/set_mode":
    case "authenticate":
      return {};
    default:
      throw Object.assign(new Error("Method not found: " + message.method), { code: -32601 });
  }
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined || message.id === null) return;
  handle(message).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message) } }),
  );
});
`;

test(
  "A supervised thread's html_render inlines workspace images and refuses others",
  WEB,
  async ({ t3, app, screen }) => {
    const origin = app.baseUrl ?? "";
    const workspace = await t3.project("charts", { "chart.png": PNG });
    const { outside, agent, attachments } = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const probeDir = path.join(T3_HOME, "html-probe");
        yield* fs.makeDirectory(probeDir, { recursive: true });
        const outside = path.join(probeDir, "outside-secret.png");
        yield* fs.writeFile(outside, PNG);
        const agent = path.join(probeDir, "agent.mjs");
        yield* fs.writeFileString(agent, PROBE_AGENT);
        return { outside, agent, attachments: path.join(T3_HOME, "userdata", "attachments") };
      }),
    );
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        const settings = yield* client["server.getSettings"]({});
        yield* client["server.updateSettings"]({
          patch: {
            defaultRuntimeMode: "approval-required",
            providerInstances: {
              ...settings.providerInstances,
              [PROBE]: {
                displayName: "HTML probe",
                driver: "acpRegistry",
                config: { source: "local", commandPath: process.execPath, commandArgs: [agent] },
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );
    const { cli } = makeState(T3_HOME);
    const ask = async (html: string) => {
      const { stdout } = await runPromise(
        cli(
          [
            "thread",
            "start",
            workspace,
            `<!--probe-->${html}<!--/probe-->`,
            "--title",
            "HTML probe",
            "--provider",
            PROBE,
            "--model",
            "default",
            "--wait",
            "--json",
          ],
          [0, 2],
        ),
      );
      const run = JSON.parse(stdout) as {
        readonly threadId: string;
        readonly reply: string | null;
      };
      return { threadId: run.threadId, reply: run.reply ?? stdout };
    };
    const insideImage = `${workspace}/chart.png`;

    // The workspace image still renders for a supervised thread, on base and head alike.
    const inside = (await ask(`<img src="${insideImage}">`)).reply;
    expect(inside).toContain("PROBE PUBLISHED");
    const insideId = /PROBE PUBLISHED (\S+)/.exec(inside)?.[1] ?? "";
    const insidePage = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* fs.readDirectory(attachments, { recursive: true });
        const file = files.find((name) => name.endsWith(`${insideId}.html`));
        return file === undefined ? "" : yield* fs.readFileString(`${attachments}/${file}`);
      }),
    );
    expect(insidePage).toContain(PNG_DATA_URI);

    // An image outside the workspace is refused, and never read into the page.
    const { threadId, reply: outsideReply } = await ask(
      `<img src="${insideImage}"><img src="${outside}">`,
    );
    await t3.open({ threadId });
    await expect(screen.getByText("PROBE", { exact: false }).first()).toBeVisible();
    await app.screenshot("outside-image");
    expect(outsideReply).toContain("PROBE REFUSED");
    expect(outsideReply).toContain("outside this thread's workspace");
  },
);
