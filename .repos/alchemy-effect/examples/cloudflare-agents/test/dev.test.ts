/**
 * `alchemy dev` end-to-end: spawns the real CLI and runs the same checks as
 * `integ.test.ts` against the local dev server.
 */
import { afterAll, test } from "bun:test";
import * as path from "node:path";
import { DevCli, fetchOk } from "@alchemy.run/test/DevCli";
import { checkAssets, checkCallables, checkMcp, checkSchedule } from "./checks.ts";

const root = path.resolve(import.meta.dirname, "..");
const cli = new DevCli({ root, stage: "dev-cli-test" });

afterAll(async () => {
  await cli.stop();
  if (!process.env.NO_DESTROY) {
    cli.destroy();
  }
}, 180_000);

test("alchemy dev serves the client, the agents and the MCP server", async () => {
  cli.destroy();
  cli.start();
  const url = (await cli.outputUrlWhenReady("url", { tries: 300, delayMs: 1000 })).replace(
    /\/$/,
    "",
  );
  await fetchOk(url);
  await checkAssets(url);
  await checkCallables(url);
  await checkSchedule(url);
  await checkMcp(url);
}, 600_000);
