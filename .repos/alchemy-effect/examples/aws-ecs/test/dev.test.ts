/**
 * True `alchemy dev` end-to-end for the orders app: spawns the REAL CLI
 * (mirroring examples/aws-dev/test/dev.test.ts) and drives the WHOLE stack
 * against the floci emulator — no cloud credentials, no cloud resources:
 *
 *   - VPC / subnets / routing / security groups  → floci EC2
 *   - shared ALB + listener + path rules         → floci ELBv2 (the ALB's
 *     DNS resolves to 127.0.0.1 and is host-routed on the gateway port)
 *   - OrdersTable                                → floci DynamoDB
 *   - Api (bundled main:) + Web (registry image) → real containers run by
 *     floci's ECS engine, registered behind the emulated ALB
 *   - SeedTask (one-shot, launched via the RunTask binding from
 *     POST /api/seed) + HeartbeatSchedule        → floci ECS + Scheduler
 *   - HOT RELOAD → editing src/Api.ts swaps the running Api container's
 *     image without a redeploy
 */
import { afterAll, expect, test } from "bun:test";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });

// Hot-reload surface: the Api service source. The test rewrites it in
// place with the CLI running, then restores it.
const apiPath = path.join(root, "src", "Api.ts");
const apiSource = fs.readFileSync(apiPath, "utf8");
const MARKER = 'service: "orders-api"';
const MARKER_V2 = 'service: "orders-api-v2"';

// The whole suite needs docker (floci and the service containers).
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(apiPath, apiSource);

  await cli.stop();
  if (!process.env.NO_DESTROY && dockerAvailable) {
    cli.destroy({ timeout: 300_000 });
  }
}, 400_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev runs the orders app fully locally with hot reload",
  async () => {
    cli.start();

    // The first dev deploy builds the Api/SeedTask/Report images and pulls
    // the Web image before printing stack outputs.
    const url = await cli.pollUntil(
      "url in stack outputs",
      () => cli.outputUrl("url"),
      {
        tries: 600,
        delayMs: 1000,
      },
    );
    const apiUrl = await cli.pollUntil("apiUrl in stack outputs", () =>
      cli.outputUrl("apiUrl"),
    );
    const seedUrl = await cli.pollUntil("seedUrl in stack outputs", () =>
      cli.outputUrl("seedUrl"),
    );

    // Dev identity: the emulated ALB's DNS resolves to 127.0.0.1 — no real
    // AWS. The port is whatever the emulator gateway bound; only the URLs
    // captured from the CLI's stdout are authoritative.
    expect(url).not.toContain("amazonaws.com");
    expect(cli.output).not.toContain("apply failed");

    // Api service behind the shared ALB's `/api/*` rule.
    const orders = (await (await fetchOk(apiUrl)).json()) as {
      count: number;
      orders: unknown[];
    };
    expect(orders.count).toBeNumber();

    // Web service behind the catch-all `/*` rule (external nginx image).
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Server");

    // POST /api/seed launches the one-shot SeedTask on the local cluster
    // via the RunTask binding; it seeds three orders into the local table.
    await fetchOk(seedUrl, { method: "POST" });
    const seeded = await cli.pollUntil(
      "seeded orders to appear",
      async () => {
        const res = await fetch(apiUrl);
        if (!res.ok) return undefined;
        const body = (await res.json()) as { count: number };
        return body.count >= 3 ? body.count : undefined;
      },
      { tries: 120, delayMs: 1000 },
    );
    expect(seeded).toBeGreaterThanOrEqual(3);

    // ── HOT RELOAD: rewrite src/Api.ts with the CLI still running — the
    // dev watcher rebuilds the image and rolls the service's container ──
    fs.writeFileSync(apiPath, apiSource.replace(MARKER, MARKER_V2));
    const fallbackUrl = new URL(apiUrl);
    fallbackUrl.pathname = "/api/ping"; // unmatched /api/* → fallback JSON
    await cli.pollUntil(
      "hot-swapped api (v2 marker)",
      async () => {
        try {
          const res = await fetch(fallbackUrl);
          if (!res.ok) return undefined;
          const body = (await res.json()) as { service?: string };
          return body.service === "orders-api-v2" ? true : undefined;
        } catch {
          return undefined; // mid-roll
        }
      },
      { tries: 240, delayMs: 1000 },
    );

    // Restore — the swap back is itself a second hot reload and leaves
    // the checked-in tree clean. The seeded data survives the roll.
    fs.writeFileSync(apiPath, apiSource);
    await cli.pollUntil(
      "restored api (v1 marker)",
      async () => {
        try {
          const res = await fetch(fallbackUrl);
          if (!res.ok) return undefined;
          const body = (await res.json()) as { service?: string };
          return body.service === "orders-api" ? true : undefined;
        } catch {
          return undefined; // mid-roll
        }
      },
      { tries: 240, delayMs: 1000 },
    );
    const afterReload = (await (await fetchOk(apiUrl)).json()) as {
      count: number;
    };
    expect(afterReload.count).toBeGreaterThanOrEqual(3);
  },
  { timeout: 1_200_000 },
);
