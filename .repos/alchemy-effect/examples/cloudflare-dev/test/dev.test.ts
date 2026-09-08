/**
 * True `alchemy dev` end-to-end: spawns the REAL CLI and drives every local
 * binding over HTTP.
 *
 * This is a different code path from `integ.test.ts`, which deploys through
 * the test harness (`Test.make({ dev: true })`). The harness mirrors the RPC
 * sidecar topology, but only this test covers the CLI itself: arg parsing,
 * the `bin/exec` child under `--watch`, the `ALCHEMY_RPC_SPAWNER_URL`
 * handshake, and provider sidecars whose lifetime is tied to the CLI
 * process. #1007 (local D1 migrations crashing under `alchemy dev` but not
 * under the harness) is the class of bug this suite exists to catch.
 *
 * Coverage per binding, all against the local simulators (no cloud
 * resources beyond the state store):
 *   - assets            → `/` serves the static index
 *   - vars + secrets    → `/env` echoes MY_VARIABLE / MY_SECRET
 *   - self_url          → `/env`.PUBLIC_URL and EffectWorker `/url`
 *   - Durable Object    → `/counter` increments across requests
 *   - R2                → `/r2` put/get/list roundtrip
 *   - D1 + migrations   → `/d1` inserts into the `greetings` table, which
 *                         exists ONLY if `./migrations` applied through the
 *                         real dev path
 *   - Queue + Consumer  → `/queue/send` produces, the local broker delivers
 *                         to the `queue()` handler, `/queue/messages` reads
 *   - wasm modules      → `/wasm` on both entrypoint styles
 *   - KV (Effect-style) → EffectWorker `/` lists the namespace
 *   - Workflow          → `/workflow/start` + status poll to completion
 *   - Container         → `/sandbox` fetches through the local container
 *   - Cache API         → `/cache` misses then hits
 *   - Rate limit        → `/ratelimit` throttles the third call
 *   - versionMetadata   → `/version` returns a stubbed id
 *   - Service binding   → `/service` calls EffectWorker worker-to-worker
 *   - Secrets Store     → MediaWorker `/secret` echoes the seeded value
 *
 * The heavier local simulators (Browser, Images, Stream, email, tail
 * consumers, cron, secret_key, Analytics Engine) are covered end-to-end by
 * integ.test.ts — the binding lowering is identical under both topologies,
 * so this suite pins only the cheap ones on the CLI path.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { WORKFLOW_SECRET_VALUE } from "../src/NotifyWorkflow.ts";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so `proc.kill()` signals the actual CLI process, whose scope
// teardown kills the exec child and the provider sidecars.
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
// Isolated stage so this suite never fights `integ.test.ts` (same stack
// name) over state rows.
const STAGE = "dev-cli-test";

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

/** Fetch with retries — a fresh workerd takes a moment to start serving. */
const fetchOk = async (
  url: string | URL,
  init?: RequestInit,
  { tries = 20, delayMs = 500 }: { tries?: number; delayMs?: number } = {},
) => {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetch(url, init);
      if (last.ok) return last;
    } catch {
      // dev proxy not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `${init?.method ?? "GET"} ${url} never returned 2xx (last status: ${last?.status})`,
  );
};

/** Extract a worker URL from the stack outputs the CLI prints on stdout. */
const outputUrl = (key: string) =>
  output.match(new RegExp(`${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

afterAll(async () => {
  if (proc?.pid) {
    // Ctrl-C semantics: signal the whole PROCESS GROUP (the CLI, its
    // `--watch` exec child, and the provider sidecars). Signaling only the
    // CLI process orphans the exec child, which then keeps the stack's
    // state locked and blocks the destroy below.
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
  "alchemy dev serves every local binding end-to-end",
  async () => {
    proc = spawn("bun", [alchemyBin, "dev", "--stage", STAGE], {
      cwd: root,
      // Own process group, so teardown can deliver Ctrl-C to the whole tree
      // the way a terminal would.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pump(proc.stdout!);
    pump(proc.stderr!);

    // The first dev deploy applies D1 migrations through the sidecar,
    // prepares the sandbox image, boots workerd, and then prints the stack
    // outputs.
    const asyncWorker = await pollUntil(
      "asyncWorker url in stack outputs",
      () => outputUrl("asyncWorker"),
      { tries: 300, delayMs: 1000 },
    );
    const effectWorker = await pollUntil(
      "effectWorker url in stack outputs",
      () => outputUrl("effectWorker"),
      { tries: 30, delayMs: 1000 },
    );
    const mediaWorker = await pollUntil(
      "mediaWorker url in stack outputs",
      () => outputUrl("mediaWorker"),
      { tries: 30, delayMs: 1000 },
    );

    // Assets: the fallthrough route serves ./assets/index.html.
    const index = await (await fetchOk(asyncWorker)).text();
    expect(index).toContain("<h1>Hello, world!</h1>");

    // Plain-text vars, secrets, and the self_url binding.
    const env = (await (
      await fetchOk(new URL("/env", asyncWorker))
    ).json()) as Record<string, unknown>;
    expect(env.MY_VARIABLE).toBe("my-variable-abc123");
    expect(env.MY_SECRET).toBe("my-secret-abc123");
    expect(env.PUBLIC_URL).toBe(asyncWorker.replace(/\/$/, ""));

    // Durable Object: state persists across requests.
    const count = (body: string) =>
      Number(body.match(/^Hello, world! (\d+)$/)?.[1]);
    const first = await (
      await fetchOk(new URL("/counter", asyncWorker))
    ).text();
    const second = await (
      await fetchOk(new URL("/counter", asyncWorker))
    ).text();
    expect(count(second)).toBe(count(first) + 1);

    // R2: put/get/list against the local simulator.
    const r2 = (await (await fetchOk(new URL("/r2", asyncWorker))).json()) as {
      text: string;
      keys: string[];
    };
    expect(r2.text).toBe("hello from r2");
    expect(r2.keys).toContain("hello.txt");

    // D1: the `greetings` table exists ONLY if ./migrations applied through
    // the real `alchemy dev` path — the #1007 repro.
    const d1 = (await (await fetchOk(new URL("/d1", asyncWorker))).json()) as {
      text: string | null;
    };
    expect(d1.text).toBe("hello from d1");

    // wasm modules ship through the bundler for both entrypoint styles.
    for (const worker of [asyncWorker, effectWorker]) {
      const wasm = (await (await fetchOk(new URL("/wasm", worker))).json()) as {
        result: number;
      };
      expect(wasm.result).toBe(7);
    }

    // Queue: produce over the binding; the local broker delivers to the
    // `queue()` handler, which records into the QueueMessages DO.
    const message = { text: "hello from alchemy dev", sentAt: Date.now() };
    await fetchOk(new URL("/queue/send", asyncWorker), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const received = await pollUntil(
      "queue message to be consumed",
      async () => {
        const res = await fetch(new URL("/queue/messages", asyncWorker));
        if (!res.ok) return undefined;
        const messages = (await res.json()) as Array<{
          body: { sentAt: number };
        }>;
        return messages.find((m) => m.body.sentAt === message.sentAt);
      },
      { tries: 50, delayMs: 500 },
    );
    expect(received).toMatchObject({ body: message });

    // Cache API: per-run key — first miss, second hit.
    const cacheKey = crypto.randomUUID();
    const cacheOnce = async () =>
      (await (
        await fetchOk(new URL(`/cache?key=${cacheKey}`, asyncWorker))
      ).json()) as { hit: boolean };
    expect((await cacheOnce()).hit).toBe(false);
    expect((await cacheOnce()).hit).toBe(true);

    // Rate limit: 2 per 10s per key — the third call is throttled.
    const rlKey = crypto.randomUUID();
    const limitOnce = async () =>
      (await (
        await fetchOk(new URL(`/ratelimit?key=${rlKey}`, asyncWorker))
      ).json()) as { success: boolean };
    expect((await limitOnce()).success).toBe(true);
    expect((await limitOnce()).success).toBe(true);
    expect((await limitOnce()).success).toBe(false);

    // Version metadata: locally stubbed with a random id.
    const version = (await (
      await fetchOk(new URL("/version", asyncWorker))
    ).json()) as { id: string };
    expect(typeof version.id).toBe("string");
    expect(version.id.length).toBeGreaterThan(0);

    // Service binding: AsyncWorker calls EffectWorker worker-to-worker. The
    // dev registry may pick the peer up asynchronously, so allow retries.
    const service = (await (
      await fetchOk(new URL("/service", asyncWorker), undefined, {
        tries: 30,
        delayMs: 1000,
      })
    ).json()) as { url: string };
    expect(service.url).toBe(effectWorker.replace(/\/$/, ""));

    // Secrets Store: the seeded value round-trips through the binding.
    const secret = (await (
      await fetchOk(new URL("/secret", mediaWorker))
    ).json()) as { value: string };
    expect(secret.value).toBe("store-secret-abc123");

    // KV via the Effect-style binding: EffectWorker's root route lists the
    // namespace.
    const kv = (await (await fetchOk(effectWorker)).json()) as {
      keys: unknown[];
      list_complete: boolean;
    };
    expect(Array.isArray(kv.keys)).toBe(true);
    expect(typeof kv.list_complete).toBe("boolean");

    // self_url, Effect-style: `yield* Worker.URL` at init.
    const self = (await (
      await fetchOk(new URL("/url", effectWorker))
    ).json()) as { url: string };
    expect(self.url).toBe(effectWorker.replace(/\/$/, ""));

    // Workflow: start an instance and poll it to completion — pins the
    // workflows binding, the KV roundtrip task inside it, and plantime
    // secret resolution.
    const roomId = `dev-cli-${Math.random().toString(36).slice(2, 10)}`;
    const started = (await (
      await fetchOk(new URL(`/workflow/start/${roomId}`, effectWorker), {
        method: "POST",
      })
    ).json()) as { instanceId: string };
    const status = await pollUntil(
      "workflow to settle",
      async () => {
        const res = await fetch(
          new URL(`/workflow/status/${started.instanceId}`, effectWorker),
        );
        if (!res.ok) return undefined;
        const s = (await res.json()) as {
          status: string;
          output?: { text?: string; secret?: string };
          error?: unknown;
        };
        return s.status === "complete" || s.status === "errored"
          ? s
          : undefined;
      },
      { tries: 60, delayMs: 2000 },
    );
    expect(status.error).toBeFalsy();
    expect(status.status).toBe("complete");
    expect(status.output?.text).toBe("Processed: hello from workflow");
    expect(status.output?.secret).toBe(WORKFLOW_SECRET_VALUE);

    // Container: the sandbox route proxies into the locally-running
    // container (docker), env vars included. Generous retry budget — the
    // container may still be pulling/starting on first request.
    const sandbox = await (
      await fetchOk(new URL("/sandbox", effectWorker), undefined, {
        tries: 120,
        delayMs: 1000,
      })
    ).text();
    expect(sandbox).toBe(
      "Hello from Sandbox container! GREETING=hello-from-env",
    );
  },
  { timeout: 600_000 },
);
