/**
 * `alchemy dev` end-to-end: spawns the real CLI and talks to the Flue app on
 * its local dev server. The agent's model calls go through `env.AI`, which
 * dev proxies to Workers AI.
 */
import { afterAll, expect, test } from "bun:test";
import * as path from "node:path";
import { DevCli, fetchOk } from "@alchemy.run/test/DevCli";
import { createFlueClient } from "@flue/sdk";

const root = path.resolve(import.meta.dirname, "..");
const cli = new DevCli({ root, stage: "dev-cli-test" });

afterAll(async () => {
  await cli.stop();
  if (!process.env.NO_DESTROY) {
    cli.destroy();
  }
}, 180_000);

test("alchemy dev serves the app and the agent", async () => {
  cli.destroy();
  cli.start();
  const url = (await cli.outputUrlWhenReady("url", { tries: 300, delayMs: 1000 })).replace(
    /\/$/,
    "",
  );

  const ping = await fetchOk(`${url}/api/ping`);
  expect(await ping.json()).toEqual({ pong: true });

  const client = createFlueClient({ url: `${url}/agents/assistant/dev-${crypto.randomUUID()}` });
  const admission = await client.send({
    message: { kind: "user", body: "Reply with the single word PONG and nothing else." },
  });
  const reply = await client.read(admission);
  expect(reply.text.toUpperCase()).toContain("PONG");
}, 600_000);
