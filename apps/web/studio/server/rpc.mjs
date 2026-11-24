import { execFile as run } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(run);

// The token stays inside this loopback bridge. Its scopes cannot manage providers or settings.
export function createT3Client(baseDir) {
  let token;
  let expires = 0;
  async function issueToken() {
    const args = ["auth", "session", "issue", "--scope", "orchestration:read", "--scope", "orchestration:operate", "--ttl", "1h", "--token-only"];
    const windows = process.platform === "win32";
    const { stdout } = await execFile(windows ? "cmd.exe" : "t3", windows ? ["/d", "/c", "t3", ...args] : args, {
      env: { ...process.env, T3CODE_HOME: baseDir }, windowsHide: true, timeout: 15_000,
    });
    expires = Date.now() + 55 * 60_000;
    return stdout.trim();
  }

  async function ticket() {
    if (!token || expires < Date.now()) token = issueToken().catch((e) => { token = undefined; throw e; });
    const { origin } = JSON.parse(await readFile(join(baseDir, "userdata/server-runtime.json"), "utf8"));
    const url = new URL(origin);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") throw Error("O T3 precisa usar o endereço local desta instância.");
    const response = await fetch(new URL("/api/auth/websocket-ticket/rpc", url), {
      method: "POST", headers: { authorization: "Bearer " + await token }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { token = undefined; throw Error("O T3 recusou a sessão local (" + response.status + ")."); }
    const { ticket } = await response.json();
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("orchestrationProtocol", "2");
    url.searchParams.set("wsTicket", ticket);
    return url;
  }

  return async function rpc(tag, payload) {
    const ws = new WebSocket(await ticket());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error("O T3 demorou a confirmar a operação.")), 20_000);
      function finish(err, value) {
        clearTimeout(timer);
        ws.onclose = ws.onerror = null;
        ws.close();
        if (err) reject(err); else resolve(value);
      }
      ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag !== "Exit") return;
        if (msg.exit._tag === "Success") finish(null, msg.exit.value);
        else finish(Error("O T3 recusou a operação: " + JSON.stringify(msg.exit.cause).slice(0, 650)));
      };
      ws.onerror = ws.onclose = () => finish(Error("Conexão local com o T3 interrompida."));
    });
  };
}
