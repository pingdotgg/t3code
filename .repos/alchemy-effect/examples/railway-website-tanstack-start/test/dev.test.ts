/**
 * True `alchemy dev` end-to-end for the TanStack Start site: spawns the
 * REAL CLI (mirroring examples/aws-dev/test/dev.test.ts), which runs the
 * Vite dev server as the local `Website.Server` provider — no Railway
 * Service, no Railway, no S3; the only cloud touch is the state store.
 *
 * Coverage:
 *   - stack output    → `url` is a local dev-server address (port is
 *                       whatever the framework bound — never hard-coded)
 *   - SSR env parity  → `/` renders the GREETING declared in alchemy.run.ts
 *                       (read via a TanStack Start server function)
 *   - HOT RELOAD      → editing src/routes/index.tsx is served by
 *                       Vite's HMR without a redeploy
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
const STAGE = "dev-cli-test";

const pagePath = path.join(root, "src", "routes", "index.tsx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "Styled with Tailwind CSS";
const MARKER_V2 = "Styled with Tailwind CSS [dev-v2]";

let proc: ReturnType<typeof spawn> | undefined;
let output = "";

const pump = (stream: NodeJS.ReadableStream) => {
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.DEBUG) process.stderr.write(text);
  });
};

/** Bounded poll for a (possibly async) producer to yield a value. */
const pollUntil = async <T>(
  what: string,
  f: () => T | undefined | Promise<T | undefined>,
  { tries = 30, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const value = await f();
    if (value !== undefined) return value;
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${what}.\n--- alchemy dev output (tail) ---\n${output.slice(-4000)}`,
  );
};

/** Fetch with retries — the dev server takes a moment to start serving. */
const fetchOk = async (
  url: string | URL,
  { tries = 30, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
) => {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetch(url);
      if (last.ok) return last;
    } catch {
      // dev server not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `GET ${url} never returned 2xx (last status: ${last?.status})`,
  );
};

/** Extract the stack-output URL the CLI prints on stdout. */
const outputUrl = () => output.match(/\burl:\s*['"]?(http[^\s'",]+)/)?.[1];

afterAll(async () => {
  fs.writeFileSync(pagePath, pageSource);

  if (proc?.pid) {
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc!.pid!, signal);
      } catch {
        // group already gone
      }
    };
    const exited = new Promise((resolve) => proc!.once("exit", resolve));
    killGroup("SIGINT");
    await Promise.race([exited, Bun.sleep(15_000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
      killGroup("SIGKILL");
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
  }
  if (!process.env.NO_DESTROY) {
    spawnSync("bun", [alchemyBin, "destroy", "--stage", STAGE, "--yes"], {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
    });
  }
}, 180_000);

test(
  "alchemy dev serves the TanStack Start site locally with hot reload",
  async () => {
    proc = spawn("bun", [alchemyBin, "dev", "--stage", STAGE], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pump(proc.stdout!);
    pump(proc.stderr!);

    const url = await pollUntil("url in stack outputs", outputUrl, {
      tries: 180,
      delayMs: 1000,
    });

    // Dev identity: the framework dev server, not Railway. The port is
    // whatever the framework bound — only the URL captured from the CLI's
    // stdout is authoritative.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("example.invalid");

    // SSR env parity: GREETING from alchemy.run.ts reaches the dev server
    // (read via a TanStack Start server function).
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Hello from TanStack Start on Railway!");
    expect(home).toContain(MARKER);

    // ── HOT RELOAD: rewrite the index page with the CLI still running —
    // the framework dev server serves the new markup without a deploy ──
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await pollUntil(
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

    fs.writeFileSync(pagePath, pageSource);
    await pollUntil(
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
