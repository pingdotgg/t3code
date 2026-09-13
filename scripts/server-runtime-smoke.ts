// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Plain Node script; the ready deadline and kill escalation are wall-clock timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Runs the built CLI under Bun and checks the headers Effect attaches through
// its pre-response handler. The in-process suite runs on Node and cannot see a
// bundle that loads a second `effect` under Bun, causing the affected CORS,
// compression, and pairing-cookie mutations to be omitted (#8878, #7756).

const distDir = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../apps/server/dist",
);
type Response = { status: number; headers: NodeHttp.IncomingHttpHeaders; body: Buffer };
const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      authenticated: Schema.Boolean,
      auth: Schema.Struct({ sessionCookieName: Schema.NonEmptyString }),
    }),
  ),
);
const decodeAuthenticated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ authenticated: Schema.Boolean })),
);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not allocate a TCP port."));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    probe.once("error", reject);
  });

const request = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  new Promise<Response>((resolve, reject) => {
    const client = NodeHttp.request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    client.on("response", (response) => response.on("error", reject));
    client.on("error", reject);
    client.setTimeout(5_000, () => client.destroy(new Error(`${path} timed out.`)));
    client.end(body);
  });

const expectHeader = (response: Response, name: string, expected: string, what: string) => {
  if (response.status !== 200 || response.headers[name] !== expected) {
    throw new Error(
      `${what}: expected 200 with ${name} "${expected}", got ${response.status} with ${JSON.stringify(response.headers[name] ?? null)}.`,
    );
  }
};

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      key !== "VITE_DEV_SERVER_URL" &&
      key !== "T3_SERVICE_LAUNCHER_CONTEXT" &&
      !key.startsWith("T3CODE_"),
  ),
);
const port = await freePort();
const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bun-smoke-"));
const args = [
  "serve",
  "--mode",
  "web",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--base-dir",
  baseDir,
  "--no-browser",
];
const child = NodeChildProcess.spawn("bun", [NodePath.join(distDir, "bin.mjs"), ...args], {
  cwd: distDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise<void>((resolve) => {
  child.once("exit", () => resolve());
  child.once("error", () => resolve());
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
try {
  const token = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Server was not ready within 60 seconds.")),
      60_000,
    );
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      reject(new Error(`Server exited early (${code ?? signal}).`));
    });
    child.stdout.on("data", () => {
      const match = /^Token: (\S+)$/mu.exec(stdout);
      if (match?.[1] && stdout.includes("T3 Code server is ready.")) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
  });
  const descriptor = await request(port, "GET", "/.well-known/t3/environment", {
    origin: "https://app.t3.codes",
  });
  expectHeader(
    descriptor,
    "access-control-allow-origin",
    "*",
    "CORS on the environment descriptor",
  );
  const session = await request(port, "GET", "/api/auth/session", {});
  const sessionBody = decodeSession(session.body.toString());
  const { sessionCookieName } = sessionBody.auth;
  if (session.status !== 200 || sessionBody.authenticated) {
    throw new Error("Expected an unauthenticated session before pairing.");
  }
  const compressed = await request(port, "GET", "/", { "accept-encoding": "gzip" });
  expectHeader(compressed, "content-encoding", "gzip", "Compression on the web client");
  const uncompressed = await request(port, "GET", "/", {});
  if (
    uncompressed.status !== 200 ||
    !NodeZlib.gunzipSync(compressed.body).equals(uncompressed.body)
  ) {
    throw new Error("Gzip response did not decode to the web client.");
  }
  const pairing = await request(
    port,
    "POST",
    "/api/auth/browser-session",
    { "content-type": "application/json" },
    JSON.stringify({ credential: token }),
  );
  const cookies = ([] as Array<string>).concat(pairing.headers["set-cookie"] ?? []);
  const authenticated =
    pairing.status === 200 && decodeAuthenticated(pairing.body.toString()).authenticated;
  if (!authenticated || !cookies.some((cookie) => cookie.startsWith(`${sessionCookieName}=`))) {
    throw new Error(
      `Pairing: expected 200, authenticated: true, and a session cookie; got ${pairing.status}.`,
    );
  }
  const replay = await request(port, "GET", "/api/auth/session", {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
  });
  if (replay.status !== 200 || !decodeAuthenticated(replay.body.toString()).authenticated) {
    throw new Error("The pairing cookie did not authenticate a subsequent request.");
  }
  Effect.runSync(
    Console.log("Bun runtime smoke passed: CORS, compression, and the pairing cookie are present."),
  );
} catch (error) {
  const tail = stderr.split("\n").slice(-20).join("\n");
  // Startup failures are logged to stdout; stop before the credential/QR output.
  const startup = stdout.split("T3 Code server is ready.")[0]?.split("\n").slice(-20).join("\n");
  Effect.runSync(
    Console.error(
      `${error instanceof Error ? error.message : String(error)}\n--- server startup ---\n${startup}\n--- server stderr ---\n${tail}`,
    ),
  );
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKill.unref();
    child.kill("SIGTERM");
    await exited;
    clearTimeout(forceKill);
  }
  NodeFS.rmSync(baseDir, { recursive: true, force: true });
}
