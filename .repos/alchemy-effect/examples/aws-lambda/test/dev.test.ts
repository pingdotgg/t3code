/**
 * True `alchemy dev` end-to-end for the Job app — the regression test for
 * the dev-mode apply failure where the SNS→Lambda glue resources
 * (AWS.SNS.Subscription and the AWS.Lambda.Permission behind
 * `consumeTopicNotifications`) were created against REAL AWS with floci
 * ARNs and died with `InvalidParameterException: Invalid parameter:
 * TopicArn` / `ResourceNotFoundException: Function not found`.
 *
 * This stack is also the mixed-mode case: the DynamoDB table, SQS queue,
 * SNS topic, Lambda function, event source mapping, subscription, and
 * permission are all local (floci), while the mode-agnostic CloudWatch
 * Dashboard + Alarm deploy live — so the run needs AWS credentials, and a
 * green apply proves local glue and live mode-agnostic resources coexist.
 *
 * Mirrored from examples/aws-dev/test/dev.test.ts (which owns the broader
 * per-binding + hot-reload coverage); this suite drives the real app:
 * POST a job over the emulator-served Function URL, read it back, and let
 * the notification publish ride the local Subscription.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so signals hit the actual CLI process, whose scope teardown
// kills the exec child and the provider sidecars.
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
// Isolated stage so this suite never fights integ.test.ts (same stack
// name) over state rows.
const STAGE = "dev-cli-test";

// The whole suite needs docker (floci runs as a container).
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

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

/** Fetch with retries — the emulator's URL proxy takes a moment to serve. */
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
      // proxy not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `${init?.method ?? "GET"} ${url} never returned 2xx (last status: ${last?.status})`,
  );
};

/** Extract a stack-output URL the CLI prints on stdout. */
const outputUrl = (key: string) =>
  output.match(new RegExp(`\\b${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

afterAll(async () => {
  if (proc?.pid) {
    // Ctrl-C semantics: signal the whole PROCESS GROUP (the CLI, its
    // `--watch` exec child, and the provider sidecars).
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
  if (!process.env.NO_DESTROY && dockerAvailable) {
    const destroyed = spawnSync(
      "bun",
      [alchemyBin, "destroy", "--stage", STAGE, "--yes"],
      {
        cwd: root,
        stdio: "inherit",
        timeout: 120_000,
      },
    );
    if (destroyed.status !== 0) {
      throw new Error(
        `alchemy destroy exited ${destroyed.status} — local teardown must succeed`,
      );
    }
  }
}, 180_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev applies the mixed local/live Job stack and serves jobs",
  async () => {
    proc = spawn("bun", [alchemyBin, "dev", "--stage", STAGE], {
      cwd: root,
      // Own process group, so teardown can deliver Ctrl-C to the whole
      // tree the way a terminal would.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pump(proc.stdout!);
    pump(proc.stderr!);

    // The first dev deploy may pull the floci image and provision the
    // local data plane before printing stack outputs.
    const url = await pollUntil(
      "url in stack outputs",
      () => outputUrl("url"),
      { tries: 300, delayMs: 1000 },
    );

    // Dev identity: the function URL is served locally, not by AWS
    // (e.g. http://<id>.lambda-url.us-east-1.localhost:<port>/). The port
    // is whatever the emulator bound — never hard-code it, only the URL
    // captured from the CLI's stdout is authoritative.
    expect(new URL(url).hostname).toEndWith("localhost");
    expect(url).not.toContain("amazonaws.com");

    // The bug failed the APPLY itself: Subscription/Permission creation
    // against real AWS with floci ARNs. Outputs printing means apply
    // succeeded, but pin the failure banner too so a partial apply that
    // still prints outputs can never sneak past.
    expect(output).not.toContain("apply failed");

    const api = new URL(url);
    api.search = "";

    // POST a job: stores it in the local table AND publishes the
    // job.created notification over the local topic — which only works
    // when the Subscription + invoke Permission were created on floci.
    const content = `hello from alchemy dev ${crypto.randomUUID()}`;
    const created = (await (
      await fetchOk(api, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: content,
      })
    ).json()) as { jobId: string };
    expect(created.jobId).toBeString();

    // Read it back through the local DynamoDB storage.
    const job = (await (
      await fetchOk(new URL(`/?jobId=${created.jobId}`, api))
    ).json()) as { id: string; content: string };
    expect(job.id).toBe(created.jobId);
    expect(job.content).toBe(content);
  },
  { timeout: 600_000 },
);
