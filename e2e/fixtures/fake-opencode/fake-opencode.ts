// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalConsole:off globalTimers:off - stdlib-only fake CLI, outside any Effect runtime.
/**
 * Deterministic stand-in for the OpenCode 1.x CLI. The server runs `opencode serve` per
 * session and talks to it over HTTP and SSE through `@opencode-ai/sdk/v2`, whose response
 * types the routes below are checked against. Prompts follow ../scenario.ts; `write <file>`
 * asks for approval when the session's permission rules say `ask` for bash.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import type {
  Agent,
  AssistantMessage,
  Event,
  GlobalHealthResponses,
  Part,
  PermissionRuleset,
  ProviderListResponse,
  Session,
} from "@opencode-ai/sdk/v2";

import {
  WAITING_TEXT,
  type JsonSchema,
  flagValue,
  replyText,
  scenarioFor,
  textGenerationOutput,
  writeCommand,
  writeScenarioFile,
} from "../scenario.ts";

const VERSION = "1.14.39";
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
} else if (args[0] === "serve") {
  serve(Number(flagValue(args, "--port") ?? "0"), flagValue(args, "--hostname") ?? "127.0.0.1");
} else {
  process.stderr.write(`fake opencode: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}

/** An SDK event without the `id` that `emit` assigns. */
type PermissionReply = "once" | "always" | "reject";

type EventBody = Event extends infer E ? (E extends { id: string } ? Omit<E, "id"> : never) : never;

const id = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID().replaceAll("-", "")}`;

/** Serves the subset of the OpenCode HTTP API the T3 adapter, probe, and titles use. */
function serve(port: number, hostname: string) {
  const sessions = new Map<string, { session: Session; permission: PermissionRuleset }>();
  const pendingPermissions = new Map<string, (reply: PermissionReply) => void>();
  const listeners = new Set<NodeHttp.ServerResponse>();
  const providerID = "fake";
  const modelID = "fake-model";

  const emit = (event: EventBody) => {
    const frame = `data: ${JSON.stringify({ ...event, id: id("evt") })}\n\n`;
    for (const listener of listeners) listener.write(frame);
  };

  const newSession = (directory: string, permission: PermissionRuleset): Session => {
    const now = Date.now();
    const session: Session = {
      id: id("ses"),
      slug: "fake-session",
      version: VERSION,
      projectID: "global",
      directory,
      title: "Fake OpenCode session",
      time: { created: now, updated: now },
    };
    sessions.set(session.id, { session, permission });
    return session;
  };

  /** Last matching rule wins, as in OpenCode. */
  const bashAction = (permission: PermissionRuleset) =>
    permission.toReversed().find((rule) => rule.permission === "bash" || rule.permission === "*")
      ?.action ?? "allow";

  const status = (sessionID: string, type: "busy" | "idle") =>
    emit({ type: "session.status", properties: { sessionID, status: { type } } });

  const textPart = (sessionID: string, messageID: string, text: string): Part => ({
    id: id("prt"),
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: Date.now(), end: Date.now() },
  });

  const assistantInfo = (
    sessionID: string,
    parentID: string,
    messageID: string,
  ): AssistantMessage => ({
    id: messageID,
    sessionID,
    parentID,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: sessions.get(sessionID)?.session.directory ?? "/", root: "/" },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID,
    providerID,
    time: { created: Date.now(), completed: Date.now() },
  });

  const say = (sessionID: string, userMessageID: string, text: string) => {
    const messageID = id("msg");
    emit({
      type: "message.part.updated",
      properties: { sessionID, part: textPart(sessionID, messageID, text), time: Date.now() },
    });
    emit({
      type: "message.updated",
      properties: { sessionID, info: assistantInfo(sessionID, userMessageID, messageID) },
    });
  };

  const runPrompt = async (sessionID: string, messageID: string, prompt: string) => {
    emit({
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID, modelID },
        },
      },
    });
    status(sessionID, "busy");
    const scenario = scenarioFor(prompt);
    if (scenario.kind === "wait") {
      say(sessionID, messageID, WAITING_TEXT);
      return;
    }
    if (scenario.kind === "reply") {
      say(sessionID, messageID, replyText("OpenCode", prompt));
      status(sessionID, "idle");
      return;
    }
    const { fileName } = scenario;
    const entry = sessions.get(sessionID);
    const action = entry === undefined ? "deny" : bashAction(entry.permission);
    let allowed = action === "allow";
    if (action === "ask") {
      const requestID = id("per");
      const reply = await new Promise<PermissionReply>((resolve) => {
        pendingPermissions.set(requestID, resolve);
        emit({
          type: "permission.asked",
          properties: {
            id: requestID,
            sessionID,
            permission: "bash",
            patterns: [writeCommand(fileName)],
            metadata: { command: writeCommand(fileName) },
            always: [],
          },
        });
      });
      emit({ type: "permission.replied", properties: { sessionID, requestID, reply } });
      allowed = reply === "once" || reply === "always";
    }
    if (allowed && entry !== undefined) writeScenarioFile(entry.session.directory, fileName);
    say(
      sessionID,
      messageID,
      allowed ? `Wrote ${fileName}.` : `Okay, I did not write ${fileName}.`,
    );
    status(sessionID, "idle");
  };

  const readBody = (request: NodeHttp.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => resolve(raw === "" ? {} : JSON.parse(raw)));
    });

  const server = NodeHttp.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${hostname}`);
    const path = url.pathname;
    const method = request.method ?? "GET";
    const json = (body: unknown, code = 200) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const sessionRoute = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(path);

    if (path === "/event" || path === "/global/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }
    if (path === "/global/health") {
      json({ healthy: true, version: VERSION } satisfies GlobalHealthResponses[200]);
      return;
    }
    if (path === "/provider") {
      json({
        all: [
          {
            id: providerID,
            name: "Fake",
            source: "custom",
            env: [],
            options: {},
            models: {
              [modelID]: {
                id: modelID,
                providerID,
                name: "Fake OpenCode Model",
                api: { id: modelID, url: "http://127.0.0.1:9", npm: "@ai-sdk/openai-compatible" },
                capabilities: {
                  temperature: false,
                  reasoning: false,
                  attachment: false,
                  toolcall: true,
                  input: { text: true, audio: false, image: false, video: false, pdf: false },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 128_000, output: 8_192 },
                status: "active",
                options: {},
                headers: {},
                release_date: "2026-01-01",
              },
            },
          },
        ],
        connected: [providerID],
        default: { [providerID]: modelID },
      } satisfies ProviderListResponse);
      return;
    }
    if (path === "/agent") {
      json([
        { name: "build", mode: "primary", native: true, permission: [], options: {} },
      ] satisfies Array<Agent>);
      return;
    }
    if (path === "/skill" || path === "/command") return json([]);
    if (path === "/mcp") return json(method === "POST" ? true : {});
    if (path === "/session/status") return json({});
    if (path === "/config") return json({});
    if (path === "/path")
      return json({ home: "/", state: "/", config: "/", worktree: "/", directory: "/" });
    if (path === "/session" && method === "POST") {
      const body = await readBody(request);
      // The SDK puts the directory in the query on GETs and in a header on everything else.
      const header = request.headers["x-opencode-directory"];
      const directory =
        url.searchParams.get("directory") ??
        (typeof header === "string" ? decodeURIComponent(header) : process.cwd());
      json(newSession(directory, (body.permission as PermissionRuleset | undefined) ?? []));
      return;
    }
    const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(path);
    if (permissionReply !== null && method === "POST") {
      const body = await readBody(request);
      const resolve = pendingPermissions.get(permissionReply[1] ?? "");
      pendingPermissions.delete(permissionReply[1] ?? "");
      const reply = body.reply === "once" || body.reply === "always" ? body.reply : "reject";
      resolve?.(reply);
      json(true);
      return;
    }
    if (sessionRoute !== null) {
      const [, sessionID = "", action] = sessionRoute;
      const entry = sessions.get(sessionID);
      if (entry === undefined)
        return json({ name: "NotFoundError", data: { message: "session" } }, 404);
      if (action === undefined && method === "PATCH") {
        const body = await readBody(request);
        if (body.permission !== undefined) entry.permission = body.permission as PermissionRuleset;
        return json(entry.session);
      }
      if (action === undefined) return json(entry.session);
      if (action === "children") return json([]);
      if (action === "abort") {
        for (const resolve of pendingPermissions.values()) resolve("reject");
        pendingPermissions.clear();
        status(sessionID, "idle");
        return json(true);
      }
      if (action === "prompt_async" && method === "POST") {
        const body = await readBody(request);
        const parts =
          (body.parts as ReadonlyArray<{ type: string; text?: string }> | undefined) ?? [];
        const prompt = parts
          .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
          .join("\n");
        response.writeHead(204).end();
        void runPrompt(sessionID, String(body.messageID ?? id("msg")), prompt);
        return;
      }
      if (action === "message" && method === "POST") {
        const body = await readBody(request);
        const parts =
          (body.parts as ReadonlyArray<{ type: string; text?: string }> | undefined) ?? [];
        const prompt = parts
          .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
          .join("\n");
        const schema = (body.format as { schema?: JsonSchema } | undefined)?.schema ?? {
          type: "object",
          properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
        };
        const messageID = id("msg");
        json({
          info: assistantInfo(sessionID, id("msg"), messageID),
          parts: [
            textPart(sessionID, messageID, JSON.stringify(textGenerationOutput(schema, prompt))),
          ],
        });
        return;
      }
      if (action === "message") return json([]);
    }
    json({ name: "NotFoundError", data: { message: `fake opencode: ${method} ${path}` } }, 404);
  });

  server.listen(port, hostname, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;
    console.log(`opencode server listening on http://${hostname}:${actualPort}`);
  });
  // `close()` alone waits for the SDK's keep-alive connections, so drop them and exit.
  const shutdown = () => {
    for (const listener of listeners) listener.end();
    server.closeAllConnections();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Each session gets its own `serve`; exit if the server that spawned it is gone.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) shutdown();
  }, 1_000).unref();
}
