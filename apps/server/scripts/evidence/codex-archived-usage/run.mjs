// Runs every fixture row against one checkout and prints one JSON line per row.
// usage: node run.mjs <repo> <outDir> <basePort> [rows...]
// Each row gets a fresh fixture, T3 home and server process: a warm usage scan
// cache would hide the archived_sessions omission.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const [repo, outDir, basePortArg, ...rowArgs] = process.argv.slice(2);
const rows = rowArgs.length > 0 ? rowArgs : ["A", "B", "C", "D1", "D2", "D3", "D4"];
const fixtureScript = NodePath.join(import.meta.dirname, "make-fixture.sh");
const require = NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"));
const load = (specifier) => import(NodeURL.pathToFileURL(require.resolve(specifier)).href);
const Effect = await load("effect/Effect");
const Layer = await load("effect/Layer");
const { Socket } = await load("effect/socket");
const { RpcClient, RpcSerialization } = await load("effect/rpc");
const C = await import(
  NodeURL.pathToFileURL(NodePath.join(repo, "packages/contracts/src/index.ts")).href
);

const untilDay = new Date().toISOString().slice(0, 10);
const sinceDay = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
const totalTokens = (t) =>
  t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;

async function runRow(row, port) {
  const root = NodePath.join(outDir, row);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeChildProcess.execFileSync("bash", [fixtureScript, row, root]);
  const t3Home = NodePath.join(root, "t3");
  const origin = `http://127.0.0.1:${port}`;
  const bootstrap = NodeCrypto.randomUUID();
  const server = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      cwd: repo,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: NodePath.join(root, "home"),
        CODEX_HOME: NodePath.join(root, "codex"),
        T3CODE_HOME: t3Home,
      },
    },
  );
  server.stdio[3].end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const log = NodeFS.createWriteStream(NodePath.join(root, "server.log"));
  let exitCode = null;
  server.once("exit", (code, signal) => (exitCode = code ?? signal));
  try {
    await new Promise((resolve, reject) => {
      let tail = "";
      for (const stream of [server.stdout, server.stderr]) {
        stream.on("data", (chunk) => {
          const text = chunk.toString().replaceAll(bootstrap, "[REDACTED]");
          log.write(text);
          tail = (tail + text).slice(-8192);
          if (tail.includes("startup phase: complete")) resolve();
        });
      }
      server.once("exit", (code) => reject(new Error(`server exited ${code} before startup`)));
      setTimeout(() => reject(new Error("startup timeout")), 90_000).unref();
    });
    const token = await (
      await fetch(`${origin}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: bootstrap,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      })
    ).json();
    const headers = {
      Authorization: `Bearer ${token.access_token}`,
      [C.ORCHESTRATION_PROTOCOL_HEADER]: String(C.ORCHESTRATION_PROTOCOL_VERSION),
    };
    const { ticket } = await (
      await fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers })
    ).json();
    const socket = Socket.layerWebSocket(
      `ws://127.0.0.1:${port}/ws?orchestrationProtocol=${C.ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
    ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerJson),
    );
    const call = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(C.WsRpcGroup);
        return yield* client[C.WS_METHODS.serverGetUsageSummary]({
          sinceDay,
          untilDay,
          timeZone: "UTC",
          awaitRefresh: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(protocol),
        Effect.match({
          onSuccess: (summary) => ({ summary }),
          onFailure: (error) => ({ error: String(error?.message ?? error) }),
        }),
      ),
    );
    const health = await fetch(`${origin}/`).then(
      (response) => response.status,
      (error) => `fetch failed: ${error.message}`,
    );
    const result = { row, error: call.error ?? null };
    if (call.summary) {
      const buckets = call.summary.buckets.filter((bucket) => bucket.provider === "codex");
      const sources = call.summary.sources.filter((s) => s.fingerprint.provider === "codex");
      Object.assign(result, {
        codexTokens: buckets.reduce((n, bucket) => n + totalTokens(bucket.totals), 0),
        codexSessions: sources.reduce((n, s) => n + s.distinctSessions, 0),
        sources: sources.map((s) => ({
          dir: NodePath.relative(NodePath.join(root, "codex"), s.fingerprint.resolvedHomePath),
          status: s.status,
          scannedFiles: s.scannedFiles,
          skippedFiles: s.skippedFiles,
          malformedRecords: s.malformedRecords,
          distinctSessions: s.distinctSessions,
          message: s.message ?? null,
        })),
      });
    }
    result.serverAliveAfterCall = exitCode === null && typeof health === "number";
    result.httpStatusAfterCall = health;
    return result;
  } catch (error) {
    return { row, error: String(error?.message ?? error), serverAliveAfterCall: exitCode === null };
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
    // Restore permissions from the chmod 000 rows so the scratch dir can be removed.
    NodeChildProcess.spawnSync("chmod", ["-R", "u+rwx", NodePath.join(root, "codex")]);
  }
}

for (const [index, row] of rows.entries()) {
  console.log(JSON.stringify(await runRow(row, Number(basePortArg) + index)));
}
