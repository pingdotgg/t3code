import { chmod, writeFile } from "node:fs/promises";
import { pair } from "./pair.ts";
import { pairingCode } from "./pairing-input.ts";

const endpoint = process.env.T3_MCP_URL;
let mcpToken = process.env.T3_MCP_TOKEN ?? "";
const watchToken = process.env.T3_PEBBLE_TOKEN;
const keyPath = process.env.T3_PEBBLE_KEY_PATH ?? ".eleven-key";
let elevenKey = (await Bun.file(keyPath).exists()) ? (await Bun.file(keyPath).text()).trim() : process.env.ELEVENLABS_API_KEY ?? "";
if (!endpoint || !watchToken) {
  throw new Error("Set T3_MCP_URL and T3_PEBBLE_TOKEN");
}

let session: string | null = null;
let sequence = 0;
let protocolVersion = "2025-03-26";
async function rpc(method: string, params: object) {
  const response = await fetch(endpoint!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  });
  const sessionHeader = response.headers.get("mcp-session-id");
  if (!response.ok) { session = null; throw new Error(`T3 MCP returned ${response.status}`); }
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5)
    : text;
  if (!payload) throw new Error("Empty T3 response");
  const result = JSON.parse(payload);
  if (result.error || result.result?.isError) throw new Error("T3 request failed");
  session = sessionHeader ?? session;
  return result.result?.structuredContent ?? result.result;
}
let connecting: Promise<unknown> | undefined;
async function initialize() {
  const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-pebble", version: "0.1.0" } });
  protocolVersion = initialized.protocolVersion ?? protocolVersion;
  const response = await fetch(endpoint!, {
    method: "POST",
    headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session, "mcp-protocol-version": protocolVersion } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (!response.ok) { session = null; throw new Error(`T3 MCP initialization returned ${response.status}`); }
}
async function call(name: string, args: object) {
  if (!mcpToken) throw new Error("Pair the watch companion first");
  if (!session || connecting) {
    connecting ??= initialize().finally(() => { connecting = undefined; });
    await connecting;
  }
  return rpc("tools/call", { name, arguments: args });
}
let metadata: { machine: string; projects: Record<string, string>; expires: number } | undefined;
async function threadMetadata() {
  if (metadata && metadata.expires > Date.now()) return metadata;
  const environment = await call("t3_environment_read", {});
  const projects: Record<string, string> = {};
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = await call("t3_project_list", { cursor, limit: 100 });
    for (const project of page.projects) projects[project.id] = project.workspaceRoot;
    cursor = page.nextCursor;
  }
  return metadata = { machine: environment.label, projects, expires: Date.now() + 300000 };
}
export const server = Bun.serve({
  hostname: process.env.T3_PEBBLE_HOST ?? "127.0.0.1",
  ...(process.env.T3_PEBBLE_CERT && process.env.T3_PEBBLE_KEY ? { tls: { cert: Bun.file(process.env.T3_PEBBLE_CERT), key: Bun.file(process.env.T3_PEBBLE_KEY) } } : {}),
  port: Number(process.env.T3_PEBBLE_PORT ?? 9383),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/configure") {
      return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>T3 Code settings</title><style>*{box-sizing:border-box}body{margin:0;background:#171717;color:#f4f4f5;font:16px system-ui,sans-serif}main{max-width:560px;margin:auto;padding:24px 20px 48px}h1{font-size:25px;margin:0 0 8px}p{color:#b9b9bf;line-height:1.45;margin:0 0 18px}section{background:#242426;border:1px solid #404044;border-radius:14px;padding:18px;margin:16px 0}h2{font-size:18px;margin:0 0 8px}label{display:block;font-weight:600;margin:18px 0 8px}input{width:100%;min-height:48px;padding:12px;border:1px solid #777780;border-radius:8px;background:#151517;color:#fff;font:inherit}input:focus{outline:2px solid #ff806b;outline-offset:2px}button{min-height:44px;border:0;border-radius:8px;background:#ef5a47;color:white;font:600 16px system-ui;padding:10px 18px;margin-top:12px}.secondary{background:#3b3b40;width:100%}.status{margin:10px 0 0;color:#fff;min-height:1em}small{display:block;color:#b9b9bf;line-height:1.4;margin-top:8px}</style></head><body><main><h1>T3 Code</h1><p>Connect your watch and choose a voice.</p><section><h2>Connect to T3 Code</h2><p>Create a pairing link in T3 Code under Settings → Sharing &amp; access, then paste the full URL.</p><form id="pair"><label for="code">Pairing URL</label><input id="code" type="password" autocomplete="off" autocapitalize="none" required><button>Connect</button><p id="pair-status" class="status" role="status"></p></form></section><section><h2>Spoken responses</h2><p>Use ElevenLabs to read new replies aloud on your watch.</p><form id="eleven"><label for="key">ElevenLabs API key</label><input id="key" type="password" autocomplete="off" autocapitalize="none" required><small>Your key is stored on your Mac and is never shown here.</small><button>Save key</button><p id="key-status" class="status" role="status"></p></form></section><button id="done" class="secondary">Done</button></main><script>const token=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);async function save(path,body,status){status.textContent='Saving…';try{const r=await fetch(path,{method:'POST',headers:{'authorization':'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Could not save. Please check and try again.');status.textContent='Saved.';return true}catch(e){status.textContent=e.message;return false}}document.querySelector('#pair').onsubmit=async e=>{e.preventDefault();if(await save('/pair',{code:document.querySelector('#code').value},document.querySelector('#pair-status')))document.querySelector('#code').value=''};document.querySelector('#eleven').onsubmit=async e=>{e.preventDefault();if(await save('/eleven-key',{key:document.querySelector('#key').value},document.querySelector('#key-status')))document.querySelector('#key').value=''};document.querySelector('#done').onclick=()=>location.href='pebblejs://close#'+encodeURIComponent(JSON.stringify({url:location.origin,token:token}))</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (req.headers.get("authorization") !== `Bearer ${watchToken}`) return new Response("Unauthorized", { status: 401 });
    try {
      if (req.method === "POST" && url.pathname === "/pair") {
        const body = await req.json();
        if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 2048) return new Response("Invalid code", { status: 400 });
        const code = pairingCode(body.code);
        if (!code) return new Response("Invalid pairing code or URL", { status: 400 });
        const origin = new URL(endpoint!).origin;
        const token = await pair(origin, code);
        await writeFile(".mcp-token", token, { mode: 0o600 });
        await chmod(".mcp-token", 0o600);
        mcpToken = token; session = null; connecting = undefined; metadata = undefined;
        return Response.json({ connected: true });
      }
      if (req.method === "POST" && url.pathname === "/eleven-key") {
        const body = await req.json();
        if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 1024) return new Response("Invalid key", { status: 400 });
        await writeFile(keyPath, body.key.trim(), { mode: 0o600 });
        await chmod(keyPath, 0o600);
        elevenKey = body.key.trim();
        return Response.json({ saved: true });
      }
      if (req.method === "GET" && url.pathname === "/threads") {
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) return new Response("Invalid cursor", { status: 400 });
        const page = await call("t3_thread_list", { allProjects: true, limit: 20, cursor });
        const info = await threadMetadata();
        return Response.json({ ...page, threads: page.threads.map((thread: { projectId: string }) => ({ ...thread, machine: info.machine, directory: info.projects[thread.projectId] ?? "" })) });
      }
      if (req.method === "POST" && url.pathname === "/read") {
        const { threadId } = await req.json();
        if (typeof threadId !== "string" || !threadId) return new Response("Invalid thread", { status: 400 });
        const head = await call("t3_thread_read", { threadId, limit: 1 });
        const afterPosition = Math.max(0, head.thread.itemCount - 26);
        return Response.json(await call("t3_thread_read", { threadId, view: "activity", limit: 25, maxCharsPerItem: 4000, ...(afterPosition ? { afterPosition } : {}) }));
      }
      if (req.method === "POST" && url.pathname === "/send") {
        const { threadId, message } = await req.json();
        if (typeof threadId !== "string" || !threadId || typeof message !== "string" || !message.trim() || message.length > 512) return new Response("Invalid message", { status: 400 });
        return Response.json(await call("t3_thread_send", { threadId, message, mode: "queue" }));
      }
      if (req.method === "POST" && url.pathname === "/speech") {
        const { text } = await req.json();
        if (typeof text !== "string" || !text || text.length > 4000) return new Response("Invalid text", { status: 400 });
        if (!elevenKey) return new Response("Configure the ElevenLabs key in Pebble settings", { status: 400 });
        const voice = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
        const audio = await fetch(`${process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_8000`, {
          method: "POST", headers: { "xi-api-key": elevenKey!, "content-type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
        });
        if (!audio.ok) return new Response("Speech generation failed", { status: 502 });
        return new Response(audio.body, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return new Response("Request failed", { status: 502 });
    }
  },
});
