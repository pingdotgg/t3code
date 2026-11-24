import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createT3Client } from "./rpc.mjs";
import { openProjection } from "./projection.mjs";

const { values } = parseArgs({ options: {
  "base-dir": { type: "string" }, port: { type: "string", default: "4319" },
  "web-origin": { type: "string" },
}});
if (!values["base-dir"]) throw Error("Informe --base-dir com o diretório da instância T3 isolada.");
const baseDir = resolve(values["base-dir"]);
const port = Number(values.port);
const rpc = createT3Client(baseDir);
const projection = openProjection(join(baseDir, "userdata/statev2.sqlite"));
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const webOrigin = values["web-origin"] && new URL(values["web-origin"]);
if (webOrigin && (!localHosts.has(webOrigin.hostname) || webOrigin.protocol !== "http:")) throw Error("A origem da interface precisa ser local.");
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, webOrigin?.origin]);
const busy = new Set();
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const httpError = (status, message) => Object.assign(Error(message), { status });

async function parseBody(req) {
  if (!/^application\/json\b/.test(req.headers["content-type"] || "")) throw httpError(415, "Envie JSON.");
  let n = 0;
  const chunks = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 64_000) throw httpError(413, "Mensagem longa demais.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw httpError(400, "Pedido inválido.");
}

function runtime() {
  try {
    const runtime = JSON.parse(readFileSync(join(baseDir, "userdata/server-runtime.json"), "utf8"));
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 1) throw Error();
    process.kill(runtime.pid, 0);
    return runtime;
  } catch { throw httpError(503, "A instância T3 local está desconectada."); }
}

async function act(id, input) {
  const { exists, snapshot, run } = projection.read(id);
  const commandId = input.commandId ?? randomUUID();
  if (typeof commandId !== "string" || !uuid.test(commandId)) throw httpError(400, "Identificador de comando inválido.");
  const shared = { commandId, threadId: id };
  const dispatch = payload => rpc("orchestration.dispatchCommand", { ...shared, ...payload });
  if (input.action === "send") {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) throw httpError(400, "Informe uma mensagem de até 16 mil caracteres.");
    const text = input.text.trim();
    if (!exists) {
      const title = (typeof input.title === "string" && input.title.trim()) || text;
      await rpc("orchestration.launchThread", {
        ...shared, ...projection.defaults, title: title.slice(0, 100),
        runtimeMode: "approval-required", interactionMode: "default", workspaceStrategy: { type: "root" },
        initialMessage: { text, attachments: [] },
      });
    } else {
      await dispatch({
        type: "message.dispatch", createdBy: "user", creationSource: "web", messageId: commandId,
        text, attachments: [],
        dispatchMode: { type: ["responding","working","pending"].includes(snapshot.status) ? "queue_after_active" : "start_immediately" },
      });
    }
  } else if (input.action === "interrupt" && exists && run && ["responding","working","pending"].includes(snapshot.status)) {
    await dispatch({ type: "run.interrupt", runId: run.id, holdQueue: true });
  } else if (input.action === "answer") {
    const req = snapshot.pending;
    if (!req || input.requestId !== req.id) throw httpError(409, "Esse pedido já foi encerrado.");
    const answer = { type: "runtime-request.respond", requestId: req.id };
    if (req.kind === "approval") {
      if (!["approve","decline"].includes(input.value)) throw httpError(400, "Selecione aprovar ou recusar.");
      answer.decision = input.value === "approve" ? "accept" : "decline";
    } else {
      const answers = {};
      for (const question of req.questions) {
        const value = input.answers?.[question.id] ?? (req.questions.length === 1 ? input.value : undefined);
        if (typeof value !== "string" || !value.trim()) throw httpError(400, "Responda cada pergunta.");
        answers[question.id] = question.options.find(option => option.label === value)?.value ?? value;
      }
      answer.answers = answers;
    }
    await dispatch(answer);
  } else { throw httpError(409, "Essa ação não está disponível nesta conversa."); }
  return projection.read(id).snapshot;
}

http.createServer(async (req, res) => {
  function json(code, body) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
    res.end(JSON.stringify(body));
  }
  try {
    const host = new URL("http://" + req.headers.host);
    if (!localHosts.has(host.hostname)) throw httpError(403, "Origem inválida.");
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) throw httpError(403, "Origem inválida.");
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type" });
        return res.end();
      }
    }
    const url = new URL(req.url, host);
    if (url.pathname === "/api/status" && req.method === "GET") return json(200, { connected: true, version: runtime().serverVersion });
    const id = /^\/api\/threads\/([a-f\d-]+)$/i.exec(url.pathname)?.[1];
    if (!id || !uuid.test(id)) throw httpError(404, "Conversa desconhecida.");
    runtime();
    if (req.method === "GET") return json(200, projection.read(id).snapshot);
    if (req.method !== "POST") throw httpError(405, "Método inválido.");
    const body = await parseBody(req);
    if (busy.has(id)) throw httpError(409, "Outra ação foi enviada nesta conversa.");
    busy.add(id);
    try { return json(200, await act(id, body)); } finally { busy.delete(id); }
  } catch (e) { return json(e.status ?? 502, { error: e.message }); }
}).listen(port, "127.0.0.1", () => console.log(`Estúdio · ponte T3 em http://127.0.0.1:${port}`));
