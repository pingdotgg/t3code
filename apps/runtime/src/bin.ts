import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { startServer } from "./server.ts";

const directory = process.env.T3MOBILE_HOME ?? join(homedir(), ".t3mobile");
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenPath = join(directory, "pairing-token");
try {
  const file = await open(tokenPath, "wx", 0o600);
  try { await file.writeFile(randomBytes(32).toString("hex")); } finally { await file.close(); }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const token = (await readFile(tokenPath, "utf8")).trim();
const port = Number(process.env.T3MOBILE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid T3MOBILE_PORT");
const server = await startServer({ directory, token, port, command: process.env.T3MOBILE_CODEX_BIN ?? "codex" });
console.log(`T3 Mobile backend: ws://127.0.0.1:${server.port}`);
console.log(`Pairing credential: copy the contents of ${tokenPath} into the app. Keep this file private.`);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => { process.exitCode = 0; }).catch((error) => { console.error(error); process.exitCode = 1; });
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
