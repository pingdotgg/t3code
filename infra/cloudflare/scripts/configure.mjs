import * as NodeChildProcess from "node:child_process";
import { parseOrigin } from "../src/origin.ts";

const [mode, value, ...extra] = process.argv.slice(2);
if (!["--local", "--remote"].includes(mode) || !value || extra.length) {
  console.error("Usage: pnpm run configure --local|--remote <upstream-origin>");
  process.exit(1);
}
const origin = parseOrigin(value, mode === "--local").origin;
const sql = `INSERT INTO gateway_config (id, upstream_origin) VALUES (1, '${origin.replaceAll("'", "''")}') ON CONFLICT(id) DO UPDATE SET upstream_origin = excluded.upstream_origin, updated_at = CURRENT_TIMESTAMP;`;
const result = NodeChildProcess.spawnSync(
  "pnpm",
  ["dlx", "wrangler@4.149.0", "d1", "execute", "DB", mode, "--command", sql],
  { stdio: "inherit", cwd: new URL("..", import.meta.url) },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
