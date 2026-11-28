// @effect-diagnostics nodeBuiltinImport:off - a plain Node server streams the fake OpenCode SSE feed.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

// An OpenCode 1.19.5 server with background subagents on (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS,
// which T3 never sets). Frames follow v1.19.5 source: tool/task.ts injects a finished background
// task's result as a synthetic prompt on the parent session; session/prompt.ts saves it, then
// reports busy; session/status.ts reports idle, then session.idle.
const ROOT = "ses_scenario_root";
const CHILD = "ses_scenario_child";
const MODEL = { providerID: "openai", modelID: "gpt-5.4-mini" };
const WAKE_TEXT = "The background task returned CHILD_OK.";

function fakeOpenCode() {
  const streams = new Set<NodeHttp.ServerResponse>();
  let sequence = 0;
  const emit = (type: string, properties: unknown) => {
    const frame = `data: ${JSON.stringify({ id: `evt_${++sequence}`, type, properties })}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const session = (id: string) => ({
    id,
    slug: id,
    version: "1.19.5",
    projectID: "global",
    directory: "/tmp",
    title: id,
    time: { created: 1, updated: 1 },
    ...(id === CHILD ? { parentID: ROOT } : {}),
  });
  const user = (sessionID: string, id: string) =>
    emit("message.updated", {
      sessionID,
      info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model: MODEL },
    });
  const answer = (sessionID: string, id: string, parentID: string, text: string) => {
    const info = {
      id,
      parentID,
      sessionID,
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...MODEL,
    };
    emit("message.updated", { sessionID, info: { ...info, time: { created: 2 } } });
    emit("message.part.updated", {
      sessionID,
      part: { id: `prt_${id}`, messageID: id, sessionID, type: "text", text },
      time: 2,
    });
    emit("message.updated", {
      sessionID,
      info: { ...info, time: { created: 2, completed: 3 }, finish: "stop" },
    });
  };
  const status = (sessionID: string, type: "busy" | "idle") => {
    emit("session.status", { sessionID, status: { type } });
    if (type === "idle") emit("session.idle", { sessionID });
  };
  const task = (state: "running" | "completed") =>
    emit("message.part.updated", {
      sessionID: ROOT,
      part: {
        id: "prt_task",
        messageID: "msg_tool_step",
        sessionID: ROOT,
        type: "tool",
        tool: "task",
        callID: "call_task",
        state: {
          status: state,
          title: "Return CHILD_OK",
          input: {
            description: "Return CHILD_OK",
            prompt: "Respond exactly CHILD_OK.",
            subagent_type: "general",
            background: true,
          },
          metadata: { sessionId: CHILD, background: true, jobId: CHILD },
          time: { start: 1, ...(state === "completed" ? { end: 2 } : {}) },
          ...(state === "completed" ? { output: "Background task started" } : {}),
        },
      },
      time: 1,
    });

  // The foreground turn launches the task in the background and settles before it finishes.
  const runPrompt = (messageID: string) => {
    user(ROOT, messageID);
    status(ROOT, "busy");
    emit("session.created", { sessionID: CHILD, info: session(CHILD) });
    task("running");
    user(CHILD, "msg_child_prompt");
    task("completed");
    emit("session.status", { sessionID: CHILD, status: { type: "busy" } });
    answer(ROOT, "msg_root_answer", messageID, "PARENT_OK");
    status(ROOT, "idle");
  };
  const finishBackgroundTask = () => {
    answer(CHILD, "msg_child_answer", "msg_child_prompt", "CHILD_OK");
    status(CHILD, "idle");
    user(ROOT, "msg_background_result");
    emit("message.part.updated", {
      sessionID: ROOT,
      part: {
        id: "prt_background_result",
        messageID: "msg_background_result",
        sessionID: ROOT,
        type: "text",
        synthetic: true,
        text: `<task id="${CHILD}" state="completed">\n<summary>Background task completed: Return CHILD_OK</summary>\n<task_result>\nCHILD_OK\n</task_result>\n</task>`,
      },
      time: 3,
    });
    status(ROOT, "busy");
    answer(ROOT, "msg_wake_answer", "msg_background_result", WAKE_TEXT);
    status(ROOT, "idle");
  };

  const server = NodeHttp.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://opencode").pathname;
    let body = "";
    for await (const chunk of request) body += chunk;
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (path === "/api/info") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end("<!doctype html>");
    }
    if (path === "/global/health") return json({ healthy: true, version: "1.19.5" });
    if (path === "/provider") {
      const model = { id: MODEL.modelID, name: "GPT-5.4 mini", release_date: "2026-01-01" };
      return json({
        all: [{ id: MODEL.providerID, name: "OpenAI", models: { [model.id]: model } }],
        default: { [MODEL.providerID]: model.id },
        connected: [MODEL.providerID],
      });
    }
    if (path === "/agent") return json([{ name: "build", mode: "primary" }]);
    if (path === "/command" || path === "/skill") return json([]);
    if (path === "/session/status") return json({});
    if (path === "/session" && request.method === "POST") return json(session(ROOT));
    const match = /^\/session\/([^/]+)(?:\/([a-z_]+))?$/.exec(path);
    if (match !== null) {
      const [, id = ROOT, action] = match;
      if (action === undefined) return json(session(id));
      if (action === "children") return json([]);
      if (action === "abort") return json(true);
      if (action === "prompt_async") {
        response.writeHead(204).end();
        return runPrompt(JSON.parse(body).messageID);
      }
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  return { server, finishBackgroundTask };
}

test(
  "An OpenCode 1.x background task's result wakes its settled thread",
  WEB,
  async ({ t3, app, screen }) => {
    const opencode = fakeOpenCode();
    await new Promise<void>((resolve) => opencode.server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = opencode.server.address() as NodeNet.AddressInfo;
      const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
      const settings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      settings.providerInstances.opencode = {
        driver: "opencode",
        enabled: true,
        config: { serverUrl: `http://127.0.0.1:${port}` },
      };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      const project = await t3.project("demo");
      const { cli } = makeState(T3_HOME);
      const start = [
        "thread",
        "start",
        project,
        "Delegate a background task, then reply PARENT_OK.",
        "--title",
        "Background wake",
        "--provider",
        "opencode",
        "--model",
        `${MODEL.providerID}/${MODEL.modelID}`,
        "--json",
      ];
      // The settings watcher enables OpenCode a moment after the write.
      let started = "";
      await expect
        .poll(
          async () => {
            const result = await runPromise(cli(start, [0, 1])).catch(() => undefined);
            if (result?.stdout.includes("threadId")) started = result.stdout;
            return started.length > 0;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const { threadId } = JSON.parse(started) as { threadId: string };
      await t3.open({ threadId });

      await expect(screen.getByText("PARENT_OK")).toBeVisible({ timeout: 60_000 });
      opencode.finishBackgroundTask();
      await expect(screen.getByText(WAKE_TEXT)).toBeVisible({ timeout: 30_000 });
      // OpenCode's own turn is a second run, and it settles.
      await expect
        .poll(
          async () => {
            const shown = await runPromise(cli(["thread", "show", threadId, "--json"]));
            const { thread } = JSON.parse(shown.stdout) as {
              thread: { runCount: number; status: string };
            };
            return `${thread.runCount} runs, ${thread.status}`;
          },
          { timeout: 30_000 },
        )
        .toBe("2 runs, completed");
      await app.screenshot("background-result");
    } finally {
      opencode.server.closeAllConnections();
      opencode.server.close();
    }
  },
);
