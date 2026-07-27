import * as AWS from "alchemy/AWS";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack, { benchMicrovm } from "../alchemy.run.ts";

/**
 * Cold-start benchmark driver. Deploys the {@link Stack} once, drives a
 * batched-concurrent boot/shutdown load against every variant, records each
 * sample DIRECTLY (no stdout parsing), then writes:
 *
 * - `data/samples-<run>.csv`  — one row per boot (raw, for plotting)
 * - `report/summary.csv`      — per-variant aggregate stats
 * - `report/report.md`        — human-readable markdown report
 *
 * Methodology: targets run sequentially so they never contend for shared
 * quotas. Each round uses distinct keys → distinct instances; a round boots its
 * instances, waits for each to reach usable service, then shuts them all down
 * before the next round, and the round-over-round trend shows image/edge warm-up.
 *
 * - Containers are measured UNDER CONCURRENT LOAD: BATCHES rounds × CONCURRENCY
 *   simultaneous boots (no comparable per-instance API throttle).
 * - MicroVMs are measured INDEPENDENTLY: MICROVM_BOOTS serial boots at
 *   concurrency 1. The Lambda MicroVM API is throttled per account/Region
 *   (RunMicrovm 5 TPS/burst 5, TerminateMicrovm 10 TPS), so booting >1 at once
 *   would measure API admission, not VM cold start.
 *
 * MicroVM variants (Lambda + cross-cloud Worker hosts) only run when the stack
 * was deployed with `BENCH_MICROVM=1`. Set `NO_DESTROY=1` to keep the deploy
 * between runs while iterating.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
  state: Alchemy.localState(),
});

const HOOK_TIMEOUT = 1_500_000;
const TEST_TIMEOUT = 3_000_000;

// Containers tolerate high concurrency (no comparable per-instance API limit),
// so they're measured under concurrent load: CONCURRENCY boots per round.
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 10);
const BATCHES = Number(process.env.BENCH_BATCHES ?? 10);

// MicroVM cold starts MUST be measured independently. The Lambda MicroVM API is
// throttled per account/Region — RunMicrovm is 5 TPS / burst 5, SuspendMicrovm
// 2 TPS, TerminateMicrovm 10 TPS
// (https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#microvms-quotas).
// Booting N>1 at once means boots 2..N partly measure API admission/throttling
// instead of VM cold start. So MicroVM defaults to concurrency 1 (each boot is a
// fully isolated launch→ready→terminate), sampled MICROVM_BOOTS times serially.
const MICROVM_CONCURRENCY = Number(process.env.BENCH_MICROVM_CONCURRENCY ?? 1);
const MICROVM_BOOTS = Number(process.env.BENCH_MICROVM_BOOTS ?? 25);

// Optional comma-separated variant filter (e.g. `BENCH_VARIANTS=opencode`) to
// re-run a subset without re-measuring everything.
const VARIANT_FILTER = process.env.BENCH_VARIANTS
  ? new Set(process.env.BENCH_VARIANTS.split(","))
  : undefined;
const REQUEST_TIMEOUT = "240 seconds";

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each request opens a fresh connection rather
// than pinning to one edge/host over a pooled keep-alive socket.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

interface Target {
  /** Coarse environment, e.g. `container`, `lambda→microvm`, `worker→microvm`. */
  readonly env: string;
  readonly host: string;
  readonly variant: string;
  readonly label: string;
  /** Query param naming the instance: containers use `name`, MicroVMs use `key`. */
  readonly keyParam: "name" | "key";
  /** Shutdown addresses by the boot key (`name`) or by the returned id (`id`). */
  readonly shutdownBy: "name" | "id";
  /** Instances booted simultaneously per round (1 = fully isolated boots). */
  readonly concurrency: number;
  /** Number of rounds; total samples = rounds × concurrency. */
  readonly rounds: number;
}

interface Sample {
  readonly env: string;
  readonly variant: string;
  readonly label: string;
  readonly batch: number;
  readonly key: string;
  /** Inside the host: start → usable service. */
  readonly readyMs: number | undefined;
  /** Wall-clock latency of the boot request, measured by the client (outside). */
  readonly outside: number;
  readonly ok: boolean;
  readonly error: string | undefined;
}

const waitForHost = (url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status !== 200
          ? Effect.fail(new Error(`host not ready: ${r.status}`))
          : Effect.flatMap(r.text, (body) =>
              body.includes(DEPLOY_PLACEHOLDER) || !body.includes("ok")
                ? Effect.fail(new Error(`not ready: ${body.slice(0, 80)}`))
                : Effect.succeed(body),
            ),
      ),
      Effect.timeout("30 seconds"),
      Effect.retry({
        schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        times: 30,
      }),
    );
  });

// Boot ONE fresh instance and time it from the outside. Returns the recorded
// sample plus the instance id (when the host reports one, for id-based
// shutdown). Does NOT shut down — the batch tears its instances down together.
const bootOne = (t: Target, batch: number, key: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const q = `variant=${t.variant}&${t.keyParam}=${encodeURIComponent(key)}`;
    const start = yield* Effect.sync(() => Date.now());
    const result = yield* client.get(`${t.host}/boot?${q}`).pipe(
      Effect.flatMap((r) =>
        Effect.map(r.text, (body) => ({ status: r.status, body })),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.map((res) => ({ ok: true as const, ...res })),
      Effect.catch((err) =>
        Effect.succeed({ ok: false as const, error: String(err) }),
      ),
    );
    const outside = (yield* Effect.sync(() => Date.now())) - start;

    const base = {
      env: t.env,
      variant: t.variant,
      label: t.label,
      batch,
      key,
      outside,
    };

    if (!result.ok) {
      return {
        sample: { ...base, readyMs: undefined, ok: false, error: result.error },
        id: undefined,
      };
    }
    if (result.status !== 200) {
      return {
        sample: {
          ...base,
          readyMs: undefined,
          ok: false,
          error: `HTTP ${result.status} ${result.body.slice(0, 160)}`,
        },
        id: undefined,
      };
    }
    const parsed = (() => {
      try {
        return JSON.parse(result.body) as { id?: string; readyMs?: number };
      } catch {
        return {} as { id?: string; readyMs?: number };
      }
    })();
    return {
      sample: { ...base, readyMs: parsed.readyMs, ok: true, error: undefined },
      id: parsed.id,
    };
  });

// Stop one instance (best-effort, untimed) so the next batch is a fresh cold
// start and we never hold more than `concurrency` instances at once.
const shutdownOne = (t: Target, key: string, id: string | undefined) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const target = t.shutdownBy === "id" ? id : key;
    if (target === undefined) return;
    const q = `variant=${t.variant}&${t.shutdownBy}=${encodeURIComponent(target)}`;
    yield* client
      .get(`${t.host}/shutdown?${q}`)
      .pipe(Effect.timeout("60 seconds"), Effect.ignore);
  });

const runTarget = (t: Target, nonce: string) =>
  Effect.gen(function* () {
    // Untimed warm-up: the FIRST pull of a freshly-pushed image onto a cold
    // edge/host costs tens of seconds — a one-time DEPLOY artifact, not a
    // per-cold-start cost. Boot+shutdown once before timing so the image is
    // distributed and we measure container/VM cold start, not first-pull.
    const warm = `${nonce}-${t.env}-${t.variant}-warm`;
    const { id: warmId } = yield* bootOne(t, 0, warm);
    yield* shutdownOne(t, warm, warmId);

    const samples: Sample[] = [];
    for (let b = 1; b <= t.rounds; b++) {
      const keys = Array.from(
        { length: t.concurrency },
        (_, i) => `${nonce}-${t.env}-${t.variant}-b${b}-${i}`,
      );
      const outcomes = yield* Effect.forEach(
        keys,
        (key) => bootOne(t, b, key),
        { concurrency: t.concurrency },
      );
      samples.push(...outcomes.map((o) => o.sample));
      yield* Effect.forEach(
        outcomes.map((o, i) => ({ key: keys[i], id: o.id })),
        ({ key, id }) => shutdownOne(t, key, id),
        { concurrency: t.concurrency },
      );
    }
    return samples;
  });

const stats = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: pct(50),
    p95: pct(95),
  };
};

const sN = (n: number) => `${(n / 1000).toFixed(1)}s`;

const csvEscape = (v: string | number | boolean | undefined) => {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const buildSamplesCsv = (samples: ReadonlyArray<Sample>) => {
  const header = [
    "env",
    "variant",
    "label",
    "batch",
    "key",
    "readyMs",
    "outside",
    "ok",
    "error",
  ].join(",");
  const rows = samples.map((s) =>
    [
      s.env,
      s.variant,
      s.label,
      s.batch,
      s.key,
      s.readyMs ?? "",
      s.outside,
      s.ok,
      s.error,
    ]
      .map(csvEscape)
      .join(","),
  );
  return [header, ...rows].join("\n") + "\n";
};

// One aggregate row per (env, variant): ready-to-service stats + per-batch
// mean trend, computed from the readyMs of successful samples.
const summarize = (samples: ReadonlyArray<Sample>) => {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = `${s.env}\u0000${s.variant}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  return [...groups.values()].map((g) => {
    const ready = stats(
      g.map((s) => s.readyMs).filter((m): m is number => typeof m === "number"),
    );
    const outside = stats(g.filter((s) => s.ok).map((s) => s.outside));
    // Variable round count per target (containers vs serial MicroVM), so derive
    // the span from the samples themselves rather than a global batch count.
    const maxBatch = g.reduce((m, s) => Math.max(m, s.batch), 0);
    const byBatch: Array<number | undefined> = [];
    for (let b = 1; b <= maxBatch; b++) {
      const xs = g
        .filter((s) => s.batch === b)
        .map((s) => s.readyMs)
        .filter((m): m is number => typeof m === "number");
      byBatch.push(xs.length > 0 ? stats(xs).mean : undefined);
    }
    return {
      env: g[0].env,
      variant: g[0].variant,
      label: g[0].label,
      ok: g.filter((s) => s.ok).length,
      total: g.length,
      ready,
      outside,
      byBatch,
    };
  });
};

type Summary = ReturnType<typeof summarize>[number];

const buildSummaryCsv = (rows: ReadonlyArray<Summary>) => {
  const header = [
    "env",
    "variant",
    "ok",
    "total",
    "ready_min_ms",
    "ready_p50_ms",
    "ready_p95_ms",
    "ready_mean_ms",
    "ready_max_ms",
    // Per-round mean trend (semicolon-separated; round count varies by target).
    "round_means_ms",
  ].join(",");
  const lines = rows.map((r) =>
    [
      r.env,
      r.variant,
      r.ok,
      r.total,
      r.ready.min,
      r.ready.p50,
      r.ready.p95,
      r.ready.mean,
      r.ready.max,
      r.byBatch.map((b) => b ?? "").join(";"),
    ]
      .map(csvEscape)
      .join(","),
  );
  return [header, ...lines].join("\n") + "\n";
};

const buildReport = (
  rows: ReadonlyArray<Summary>,
  meta: { runId: string; total: number },
) => {
  const head =
    "| environment | variant | ok | ready p50 | ready p95 | ready mean | ready max | first → last round (mean) |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map((r) => {
    const first = r.byBatch[0];
    const last = [...r.byBatch].reverse().find((b) => b !== undefined);
    const trend =
      first !== undefined && last !== undefined
        ? `${sN(first)} → ${sN(last)}`
        : "—";
    return `| ${r.env} | ${r.variant} | ${r.ok}/${r.total} | ${sN(r.ready.p50)} | ${sN(r.ready.p95)} | ${sN(r.ready.mean)} | ${sN(r.ready.max)} | ${trend} |`;
  });
  return [
    `# Cold-start benchmark`,
    ``,
    `Run \`${meta.runId}\` — ${meta.total} samples. Metric: **time to usable service** (host start → first successful request).`,
    ``,
    `Methodology: targets run sequentially so they never contend for shared quotas. Containers are measured under concurrent load (${BATCHES} rounds × ${CONCURRENCY} simultaneous boots). MicroVMs are measured **independently** — ${MICROVM_BOOTS} serial boots at concurrency ${MICROVM_CONCURRENCY} — because the Lambda MicroVM API is throttled per account/Region (RunMicrovm 5 TPS/burst 5, TerminateMicrovm 10 TPS), so concurrent boots would measure API admission rather than VM cold start. Each boot launches, waits until the service is usable, then terminates before the next; the image is pre-warmed once (untimed) so we measure cold start, not first-pull distribution.`,
    ``,
    head,
    sep,
    ...body,
    ``,
    `Raw per-boot samples: \`data/samples-${meta.runId}.csv\`. Aggregates: \`report/summary.csv\`.`,
    ``,
  ].join("\n");
};

const buildTargets = (outputs: {
  containerWorkerUrl: string;
  lambdaUrl?: string;
  microvmWorkerUrl?: string;
}): Target[] => {
  const clean = (u: string) => u.replace(/\/+$/, "");
  const targets: Target[] = [
    {
      env: "container",
      host: clean(outputs.containerWorkerUrl),
      variant: "effectful",
      label: "Cloudflare container (bundled Effect image)",
      keyParam: "name",
      shutdownBy: "name",
      concurrency: CONCURRENCY,
      rounds: BATCHES,
    },
    {
      env: "container",
      host: clean(outputs.containerWorkerUrl),
      variant: "bun",
      label: "Cloudflare container (oven/bun, no Effect bundle)",
      keyParam: "name",
      shutdownBy: "name",
      concurrency: CONCURRENCY,
      rounds: BATCHES,
    },
    {
      env: "container",
      host: clean(outputs.containerWorkerUrl),
      variant: "remote",
      label: "Cloudflare container (remote echo image)",
      keyParam: "name",
      shutdownBy: "name",
      concurrency: CONCURRENCY,
      rounds: BATCHES,
    },
    {
      env: "container",
      host: clean(outputs.containerWorkerUrl),
      variant: "opencode",
      label: "Cloudflare container (opencode server, eager entrypoint)",
      keyParam: "name",
      shutdownBy: "name",
      concurrency: CONCURRENCY,
      rounds: BATCHES,
    },
  ];
  if (benchMicrovm && outputs.lambdaUrl && outputs.microvmWorkerUrl) {
    const lambda = clean(outputs.lambdaUrl);
    const worker = clean(outputs.microvmWorkerUrl);
    // Per host, the node-vs-bun matrix: effectful (alchemy/Effect bundle) on
    // each runtime, the raw baseline on each runtime, plus the Python external.
    const microvmVariants: ReadonlyArray<{ variant: string; label: string }> = [
      { variant: "effectful-bun", label: "effectful (Effect bundle, bun)" },
      { variant: "effectful-node", label: "effectful (Effect bundle, node)" },
      { variant: "bun", label: "bun baseline (raw Bun.serve)" },
      { variant: "node", label: "node baseline (raw http)" },
      { variant: "external", label: "external (Python Dockerfile)" },
      // The MicroVM image build starts opencode and snapshots the running
      // memory, so each boot resumes with the server already up.
      { variant: "opencode", label: "opencode (snapshotted eager server)" },
    ];
    for (const host of [
      { env: "lambda→microvm", url: lambda },
      { env: "worker→microvm", url: worker },
    ]) {
      for (const v of microvmVariants) {
        targets.push({
          env: host.env,
          host: host.url,
          variant: v.variant,
          label: `${host.env} (${v.label})`,
          keyParam: "key",
          shutdownBy: "id",
          // Isolated, serial boots — see the MICROVM_CONCURRENCY rationale above.
          concurrency: MICROVM_CONCURRENCY,
          rounds: MICROVM_BOOTS,
        });
      }
    }
  }
  return targets;
};

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test(
  "cold-start benchmark → data/*.csv + report/report.md",
  Effect.gen(function* () {
    const outputs = (yield* stack) as {
      containerWorkerUrl: string;
      lambdaUrl?: string;
      microvmWorkerUrl?: string;
    };
    const targets = buildTargets(outputs).filter(
      (t) => VARIANT_FILTER === undefined || VARIANT_FILTER.has(t.variant),
    );

    // Wait for each distinct host to answer before timing.
    const hosts = [...new Set(targets.map((t) => t.host))];
    yield* Effect.forEach(hosts, waitForHost, { concurrency: hosts.length });

    const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));

    const samples: Sample[] = [];
    for (const t of targets) {
      samples.push(...(yield* runTarget(t, nonce)));
    }

    const rows = summarize(samples);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(import.meta.dirname, "..");
    const dataDir = path.join(root, "data");
    const reportDir = path.join(root, "report");
    yield* fs.makeDirectory(dataDir, { recursive: true });
    yield* fs.makeDirectory(reportDir, { recursive: true });

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    yield* fs.writeFileString(
      path.join(dataDir, `samples-${runId}.csv`),
      buildSamplesCsv(samples),
    );
    yield* fs.writeFileString(
      path.join(reportDir, "summary.csv"),
      buildSummaryCsv(rows),
    );
    yield* fs.writeFileString(
      path.join(reportDir, "report.md"),
      buildReport(rows, { runId, total: samples.length }),
    );

    yield* Effect.sync(() =>
      console.log(
        `\nWrote ${samples.length} samples → data/samples-${runId}.csv` +
          `\nReport → report/report.md\n`,
      ),
    );

    // Informational, but a run where nothing started indicates a broken deploy.
    expect(samples.filter((s) => s.ok).length).toBeGreaterThan(0);
  }),
  { timeout: TEST_TIMEOUT },
);
