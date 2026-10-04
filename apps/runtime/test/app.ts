import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import WebSocket from "ws";
import { RuntimeClient, type ConnectionState, type Socket } from "../../mobile/src/runtime/client.ts";
import type { ServerMessage, Session } from "../../../packages/protocol/src/index.ts";
import { startServer } from "../src/server.ts";

export const TOKEN = "a".repeat(64);
export async function app(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "t3mobile-test-"));
  const directory = join(home, "sessions");
  const project = join(home, "project");
  await mkdir(project);
  const options = { directory, token: TOKEN, port: 0, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/codex.ts", import.meta.url))], env: { ...process.env, FAKE_CODEX_HOME: home } };
  let server = await startServer(options);
  const port = server.port;
  let running = true;
  let socket: WebSocket;
  let state: ConnectionState = "disconnected";
  const sessions = new Map<string, Session>();
  const events: ServerMessage[] = [];
  const watchers = new Set<() => void>();
  const notify = () => { for (const check of watchers) check(); };
  const client = new RuntimeClient({ url: `ws://127.0.0.1:${port}`, token: TOKEN,
    socket: (url, protocols) => {
      socket = new WebSocket(url, protocols, { origin: `http://127.0.0.1:${port}` });
      return socket as unknown as Socket;
    },
    onState: (next) => { state = next; notify(); },
    onMessage: (message) => {
      events.push(message);
      if ("event" in message && message.event === "snapshot") {
        sessions.clear(); for (const session of message.sessions) sessions.set(session.id, session);
      } else if ("event" in message && message.event === "session") sessions.set(message.session.id, message.session);
      notify();
    },
  });
  const wait = async (condition: () => boolean, description: string) => {
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { watchers.delete(check); reject(Error(`Timed out: ${description}`)); }, 5000);
      const check = () => { if (condition()) { clearTimeout(timer); watchers.delete(check); resolve(); } };
      watchers.add(check); check();
    });
  };
  t.after(async () => { client.disconnect(); if (running) await server.close(); await rm(home, { recursive: true, force: true }); });
  client.connect();
  await wait(() => state === "connected", "pairing snapshot");
  return {
    client, sessions, events, project, directory, port, wait,
    async acknowledgeStart() { await writeFile(join(home, "acknowledge"), "continue"); },
    async finishResponse() { await writeFile(join(home, "finish-response"), "continue"); },
    async create() { return await client.request({ method: "session/create", params: { cwd: project, fullAccess: false } }) as Session; },
    async stopBackend() { running = false; await server.close(); await wait(() => state === "disconnected", "backend disconnected"); },
    async restartBackend() { server = await startServer({ ...options, port }); running = true; await wait(() => state === "connected", "reconnect snapshot"); },
  };
}
