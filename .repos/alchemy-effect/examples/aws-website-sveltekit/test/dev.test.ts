/**
 * True `alchemy dev` end-to-end for the SvelteKit site: spawns the REAL
 * CLI (mirroring examples/aws-dev/test/dev.test.ts), which runs the Vite
 * dev server as the local `Website.Server` provider — no Lambda, no
 * CloudFront, no S3; the only cloud touch is the state store.
 *
 * Coverage:
 *   - stack output    → `url` is a local dev-server address (port is
 *                       whatever the framework bound — never hard-coded)
 *   - SSR env parity  → `/` renders the GREETING declared in alchemy.run.ts
 *                       (read via `process.env` in +page.server.ts)
 *   - routing         → `/about` (prerendered route) serves
 *   - static assets   → `/robots.txt` from static/
 *   - HOT RELOAD      → editing src/routes/+page.svelte is served by
 *                       Vite's HMR without a redeploy
 */
import { afterAll, expect, test } from "bun:test";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Isolated stage so this suite never fights integ.test.ts (same stack
// name) over state rows.
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });

// Hot-reload surface: the SSR index page. The test rewrites it in place
// with the CLI running, then restores it.
const pagePath = path.join(root, "src", "routes", "+page.svelte");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "SvelteKit on AWS";
const MARKER_V2 = "SvelteKit on AWS [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);

  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the SvelteKit site locally with hot reload",
  async () => {
    cli.start();

    const url = await cli.outputUrlWhenReady("url", {
      tries: 180,
      delayMs: 1000,
    });

    // Dev identity: the framework dev server, not CloudFront. The port is
    // whatever the framework bound — only the URL captured from the CLI's
    // stdout is authoritative.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("cloudfront.net");

    // SSR env parity: GREETING from alchemy.run.ts reaches the dev server
    // (read via `process.env` in +page.server.ts's load).
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Hello from SvelteKit on AWS!");
    expect(home).toContain(MARKER);

    // Prerendered route serves through the dev server.
    const about = await fetchOk(new URL("/about", url));
    expect(about.status).toBe(200);

    // Static asset from static/.
    const robots = await (await fetchOk(new URL("/robots.txt", url))).text();
    expect(robots).toContain("User-agent:");

    // ── HOT RELOAD: rewrite the index page with the CLI still running —
    // the framework dev server serves the new markup without a deploy ──
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await cli.pollUntil(
      "hot-reloaded page (v2 marker)",
      async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          const html = await res.text();
          return html.includes(MARKER_V2) ? true : undefined;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );

    // Restore — the swap back is itself a second hot reload and leaves
    // the checked-in tree clean.
    fs.writeFileSync(pagePath, pageSource);
    await cli.pollUntil(
      "restored page (v2 marker gone)",
      async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          const html = await res.text();
          return html.includes(MARKER_V2) ? undefined : true;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );
  },
  { timeout: 600_000 },
);
