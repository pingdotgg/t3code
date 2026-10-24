import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const fixture = JSON.parse(NodeFS.readFileSync(new URL("./provider.json", import.meta.url)));
const stateDir = process.env.ISSUE_8640_STATE;
if (!stateDir) throw new Error("ISSUE_8640_STATE must name the isolated fixture state directory");
const original = globalThis.fetch;
const base = "/api/repos/pingdotgg/t3code";
const pullPath = `${base}/pulls/23210`;
const page = { items: [], next: null };
const log = (value) =>
  NodeFS.appendFileSync(
    NodePath.join(stateDir, "provider.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + "\n",
  );
globalThis.fetch = async (...args) => {
  const url = new URL(String(args[0]?.url ?? args[0]));
  if (url.origin !== "https://git.cafe" || !url.pathname.startsWith("/api/"))
    return original(...args);
  // Only reads are staged; anything else must fail loudly rather than fake success or reach GitCafe.
  const method = String(args[1]?.method ?? args[0]?.method ?? "GET").toUpperCase();
  if (method !== "GET")
    throw new Error(`Unexpected GitCafe fixture request: ${method} ${url.pathname}`);
  const stage = NodeFS.readFileSync(NodePath.join(stateDir, "stage"), "utf8").trim();
  const changed = stage === "title" || stage === "success";
  const { changedTitle, changedUpdatedAt, ...pull } = fixture;
  if (changed) {
    pull.title = changedTitle;
    pull.updatedAt = changedUpdatedAt;
  }
  let data;
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname === pullPath) data = pull;
  else if (pathname === `${base}/pulls`)
    data = { items: [{ ...pull, title: fixture.title, updatedAt: fixture.updatedAt }], next: null };
  else if (pathname === `${pullPath}/status`)
    data = {
      merge: {
        conflicts: "unknown",
        fastForward: true,
        strategies: ["merge", "squash", "rebase"],
        permitted: true,
      },
      checks: { pending: stage === "success" ? 0 : 1, failing: 0, total: 2 },
    };
  else if (pathname === `${base}/commits/${pull.headOid}/checks`)
    data = {
      items: [
        {
          name: "Fixture integration — long check name for narrow responsive layouts",
          status: stage === "success" ? "completed" : "in_progress",
          conclusion: stage === "success" ? "success" : null,
          summary: null,
          detailsUrl: "https://git.cafe/pingdotgg/t3code/pulls/23210",
        },
        {
          name: "Fixture lint",
          status: "completed",
          conclusion: "success",
          summary: null,
          detailsUrl: null,
        },
      ],
      next: null,
    };
  else if (pathname === `${pullPath}/stack`) data = { stack: null };
  else if (pathname === `${pullPath}/changes`)
    data = { version: 1, headOid: pull.headOid, comparisonBaseOid: pull.observedBaseOid, ...page };
  else if (
    [
      `${pullPath}/comments`,
      `${pullPath}/reviews`,
      `${pullPath}/commits`,
      `${pullPath}/reactions`,
    ].includes(pathname)
  )
    data = page;
  else if (pathname === `${base}/filter-options`)
    data = { actors: [{ actorId: "act_fixture", handle: "juliusmarminge" }] };
  else throw new Error(`Unhandled GitCafe fixture request: ${method} ${pathname}`);
  log({ stage, path: pathname, updatedAt: pull.updatedAt, title: pull.title });
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
log({
  event: "preload",
  normalization:
    "raw merge.conflicts clean normalized to schema-accepted unknown; fixed fixture response",
});

// Count transport milestones without retaining request payloads, headers or credentials.
const { createRequire } = await import("node:module");
const requirePlatform = createRequire(import.meta.resolve("@effect/platform-node/NodeHttpServer"));
const { WebSocketServer } = requirePlatform("ws");
const emit = WebSocketServer.prototype.emit;
WebSocketServer.prototype.emit = function (event, ...values) {
  if (event === "connection") {
    const socket = values[0];
    const methods = new Map();
    const inspect = (direction, raw) => {
      let messages;
      try {
        messages = JSON.parse(String(raw));
      } catch {
        return;
      }
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (!message || typeof message !== "object") continue;
        if (direction === "in" && message._tag === "Request") {
          methods.set(String(message.id), message.tag);
          if (String(message.tag).startsWith("pullRequests."))
            log({ event: "rpc-request", method: message.tag, id: String(message.id) });
        }
        const method = methods.get(String(message.requestId));
        if (direction === "out" && method?.startsWith("pullRequests."))
          log({ event: "rpc-response", method, kind: message._tag, id: String(message.requestId) });
      }
    };
    socket.on("message", (data) => inspect("in", data));
    const send = socket.send;
    socket.send = function (data, ...rest) {
      inspect("out", data);
      return send.call(this, data, ...rest);
    };
  }
  return emit.call(this, event, ...values);
};
