/**
 * Throughput benchmarks against a **deployed** git-service stack
 * (DESIGN.md §14–15): turns the estimated scaling table into measured
 * numbers, one benchmark per named bottleneck.
 *
 * These are measurements, not assertions about performance: each case
 * prints a line and asserts only *correctness* (every operation succeeded),
 * so the suite can never fail because a datacenter had a slow minute. Read
 * the printed table to see where the service actually stands.
 *
 * Run:
 *   bun run test test/GitBench.e2e.test.ts --profile testing
 *   BENCH_SCALE=4 ... to make every workload 4x bigger
 *
 * Skipped under `--fast`.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { GitApi } from "@/Git/Api.ts";
import { verifyPackResponse } from "./harness/pack.ts";
import { makeTestStack, TEST_SECRET } from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = makeTestStack("GitBenchStack");

/** Scales every workload; 1 keeps a full run inside the alarm/test budget. */
const SCALE = Number.parseInt(process.env.BENCH_SCALE ?? "1", 10) || 1;

const skipBench = !!process.env.FAST;

// ── plumbing ────────────────────────────────────────────────────────────────

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

class ShellError extends Data.TaggedError("ShellError")<{
  readonly script: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return `bench shell exited ${this.exitCode}\n${this.script}\n${this.stderr}`;
  }
}

const sh = Effect.fn(function* (cwd: string, script: string) {
  const handle = yield* ChildProcess.make("sh", ["-ec", script], {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Bench Bot",
      GIT_AUTHOR_EMAIL: "bench@example.com",
      GIT_COMMITTER_NAME: "Bench Bot",
      GIT_COMMITTER_EMAIL: "bench@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    extendEnv: true,
  });
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  return { script, exitCode, stdout: stdout.trim(), stderr };
}, Effect.timeout("240 seconds"));

const mustSh = Effect.fn(function* (cwd: string, script: string) {
  const result = yield* sh(cwd, script);
  if (result.exitCode !== 0) return yield* new ShellError(result);
  return result;
});

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-bench-" });
});

const edgeRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("15 seconds"),
    Effect.retry({ schedule: Schedule.spaced("1500 millis"), times: 40 }),
  );

const purgeRepo = Effect.fn(function* (
  url: string,
  owner: string,
  repo: string,
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  yield* admin.repos.delete({ params: { owner, repo } }).pipe(
    Effect.catchTag("RepoNotFound", () => Effect.void),
    edgeRetry,
  );
  yield* admin.repos.get({ params: { owner, repo } }).pipe(
    edgeRetry,
    Effect.as(false),
    Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 60,
    }),
  );
});

const freshRepo = Effect.fn(function* (
  url: string,
  owner: string,
  name: string,
  options?: { readonly public?: boolean },
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  const created = yield* Effect.gen(function* () {
    yield* purgeRepo(url, owner, name);
    return yield* admin.repos
      .create({ payload: { owner, name, public: options?.public } })
      .pipe(edgeRetry);
  }).pipe(
    Effect.retry({
      while: (error: { readonly _tag?: string }) =>
        error._tag === "RepoAlreadyExists",
      schedule: Schedule.spaced("1 second"),
      times: 3,
    }),
  );
  const parsed = new URL(url);
  return {
    admin,
    token: TEST_SECRET,
    remote: `${parsed.protocol}//x:${TEST_SECRET}@${parsed.host}/${owner}/${name}.git`,
  };
});

// ── measurement ─────────────────────────────────────────────────────────────

const results: Array<string> = [];

/** Times an effect, records a bench line, and returns the value. */
const measure = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  describe: (value: A, ms: number) => string,
) =>
  Effect.gen(function* () {
    const started = yield* Effect.sync(() => performance.now());
    const value = yield* effect;
    const ms = yield* Effect.sync(() => performance.now() - started);
    const line = `${label.padEnd(46)} ${describe(value, ms)}`;
    results.push(line);
    yield* Effect.logInfo(`[bench] ${line}`);
    return value;
  });

const perSecond = (count: number, ms: number) =>
  `${((count / ms) * 1000).toFixed(1)}/s`;

const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`git-service deployed at ${url}`);
        const admin = yield* makeClient(url, TEST_SECRET);
        yield* admin.repos.list({ query: {} }).pipe(
          edgeRetry,
          Effect.retry({
            schedule: Schedule.spaced("1500 millis"),
            times: 40,
          }),
        );
      }),
    ),
    logLevel,
  ),
);

afterAll(
  Effect.gen(function* () {
    if (results.length > 0) {
      yield* Effect.logInfo(
        ["", "═══ git-service throughput ═══", ...results, ""].join("\n"),
      );
    }
  }),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 1 — closure computation / clone bandwidth on deep history
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: deep history — push, cold clone, bundle clone, incremental fetch",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "deep");
    const tmp = yield* tempDir;
    const commits = 300 * SCALE;

    // Build the history locally first so the measurement is server-side.
    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      i=1
      while [ $i -le ${commits} ]; do
        printf 'line %s\\n' $i >> history.txt
        printf 'file %s\\n' $i > "f$i.txt"
        git add -A && git commit -q -m "c$i"
        i=$((i+1))
      done
      `,
    );

    yield* measure(
      `push ${commits} commits`,
      mustSh(tmp, `cd work && git push origin main`),
      (_, ms) =>
        `${(ms / 1000).toFixed(1)}s (${perSecond(commits, ms)} commits)`,
    );

    // Cold clone: no bundle yet (the post-push alarm needs a moment), so
    // this measures the dynamic closure walk + pack emission path.
    yield* measure(
      "clone (dynamic closure walk)",
      mustSh(tmp, `rm -rf cold && git clone -q '${repo.remote}' cold`),
      (_, ms) => `${(ms / 1000).toFixed(2)}s`,
    );

    // Give the bundle alarm time to cut, then clone again: same repo, same
    // client, but served as bytes from R2 (DESIGN §12.2).
    yield* Effect.sleep("6 seconds");
    yield* measure(
      "clone (R2 bundle fast path)",
      mustSh(tmp, `rm -rf warm && git clone -q '${repo.remote}' warm`),
      (_, ms) => `${(ms / 1000).toFixed(2)}s`,
    );

    // Incremental fetch of a single new commit — the negotiation path.
    yield* mustSh(
      tmp,
      `cd work && echo tip >> history.txt && git add -A && git commit -q -m tip && git push -q origin main`,
    );
    yield* measure(
      "incremental fetch (1 commit)",
      mustSh(tmp, `cd cold && git fetch -q origin main`),
      (_, ms) => `${ms.toFixed(0)}ms`,
    );

    yield* mustSh(tmp, `cd warm && git fsck --strict`);
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 1/2 — clone TPS and bandwidth under concurrency
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: concurrent clone storm (clone TPS on one repo)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "storm");
    const tmp = yield* tempDir;
    const blobKiB = 256 * SCALE;
    const clones = 8 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      head -c ${blobKiB * 1024} /dev/urandom > blob.bin
      i=1; while [ $i -le 20 ]; do printf 'f %s\\n' $i > "f$i.txt"; i=$((i+1)); done
      git add -A && git commit -q -m payload
      git push -q origin main
      `,
    );
    // Let the bundle land so the storm hits the fast path.
    yield* Effect.sleep("6 seconds");

    yield* measure(
      `${clones} concurrent clones (~${blobKiB} KiB each)`,
      Effect.all(
        Array.from({ length: clones }, (_, i) =>
          mustSh(tmp, `rm -rf c${i} && git clone -q '${repo.remote}' c${i}`),
        ),
        { concurrency: clones },
      ),
      (_, ms) =>
        `${(ms / 1000).toFixed(2)}s total, ${perSecond(clones, ms)} clones, ` +
        `~${((clones * blobKiB) / 1024 / (ms / 1000)).toFixed(1)} MiB/s`,
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 3 — push serialization (inherent: a ref is a serialization point)
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: push TPS, serial and concurrent-to-distinct-branches",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "push");
    const tmp = yield* tempDir;
    const pushes = 10 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work && echo base > base.txt && git add -A && git commit -q -m base
      git push -q origin main
      `,
    );

    yield* measure(
      `${pushes} serial pushes (same branch)`,
      mustSh(
        tmp,
        `
        cd work
        i=1
        while [ $i -le ${pushes} ]; do
          printf '%s\\n' $i >> base.txt
          git add -A && git commit -q -m "p$i"
          git push -q origin main
          i=$((i+1))
        done
        `,
      ),
      (_, ms) => `${(ms / 1000).toFixed(1)}s (${perSecond(pushes, ms)})`,
    );

    // Distinct branches: admission is by ingest MEMORY, not by count
    // (DESIGN.md §2.1), so ordinary kilobyte-sized pushes to different
    // branches should now overlap instead of queueing behind each other.
    const branches = 4 * SCALE;
    yield* mustSh(
      tmp,
      `
      cd work
      i=1
      while [ $i -le ${branches} ]; do
        git branch -f "side$i" HEAD
        printf 'side %s\\n' $i > "side$i.txt"
        i=$((i+1))
      done
      `,
    );
    yield* measure(
      `${branches} concurrent pushes (distinct branches)`,
      Effect.all(
        Array.from({ length: branches }, (_, i) =>
          mustSh(tmp, `cd work && git push -q origin side${i + 1}`),
        ),
        { concurrency: branches },
      ),
      (_, ms) => `${(ms / 1000).toFixed(2)}s (${perSecond(branches, ms)})`,
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 4 — Registry singleton (control-plane TPS)
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: control plane — repo create/list/delete through the Registry",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    const repos = 10 * SCALE;
    const names = Array.from({ length: repos }, (_, i) => `ctl-${i}`);

    yield* Effect.all(
      names.map((name) => purgeRepo(url, "bench", name)),
      { concurrency: 5 },
    );

    yield* measure(
      `${repos} concurrent repo creates`,
      Effect.all(
        names.map((name) =>
          admin.repos.create({ payload: { owner: "bench", name } }),
        ),
        { concurrency: repos },
      ),
      (created, ms) => {
        expect(created.length).toBe(repos);
        return `${(ms / 1000).toFixed(2)}s (${perSecond(repos, ms)})`;
      },
    );

    yield* measure(
      "repo list (single Registry read)",
      admin.repos.list({ query: { owner: "bench" } }),
      (page, ms) => `${page.items.length} rows in ${ms.toFixed(0)}ms`,
    );

    yield* measure(
      "resolve-cached repo reads (20 sequential GETs)",
      Effect.all(
        Array.from({ length: 20 }, () =>
          admin.repos.get({ params: { owner: "bench", repo: names[0]! } }),
        ),
        { concurrency: 1 },
      ),
      (_, ms) => `${(ms / 20).toFixed(0)}ms each (${perSecond(20, ms)})`,
    );

    yield* Effect.all(
      names.map((name) =>
        admin.repos
          .delete({ params: { owner: "bench", repo: name } })
          .pipe(Effect.catchTag("RepoNotFound", () => Effect.void)),
      ),
      { concurrency: 5 },
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 6 — compaction throughput (R2 write path)
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: compaction — loose rows into an R2 pack, then packed reads",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "compact");
    const tmp = yield* tempDir;
    const files = 200 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      i=1
      while [ $i -le ${files} ]; do
        head -c 4096 /dev/urandom | base64 > "b$i.txt"
        i=$((i+1))
      done
      git add -A && git commit -q -m payload
      git push -q origin main
      `,
    );

    const before = yield* repo.admin.repos.get({
      params: { owner: "bench", repo: "compact" },
    });

    yield* measure(
      `compact ${before.objects.loose} loose objects into R2`,
      Effect.gen(function* () {
        yield* repo.admin.repos.compact({
          params: { owner: "bench", repo: "compact" },
        });
        return yield* repo.admin.repos
          .get({ params: { owner: "bench", repo: "compact" } })
          .pipe(
            Effect.map((found) => found.objects),
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (objects: { loose: number; packed: number }) =>
                objects.packed > 0 && objects.loose === 0,
              times: 120,
            }),
          );
      }),
      (objects, ms) =>
        `${objects.packed} packed, ${(objects.bytes / 1024 / 1024).toFixed(1)} MiB in ${(ms / 1000).toFixed(1)}s`,
    );

    // Every object now reads through ranged R2 GETs.
    yield* measure(
      "clone from a fully packed repo (ranged R2 reads)",
      mustSh(tmp, `rm -rf packed && git clone -q '${repo.remote}' packed`),
      (_, ms) => `${(ms / 1000).toFixed(2)}s`,
    );
    yield* mustSh(tmp, `cd packed && git fsck --strict`);
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 1/2 — SERVER-side clone capacity (no git process in the way)
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: raw upload-pack throughput (server capacity, no git CLI)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "raw");
    const tmp = yield* tempDir;
    const blobKiB = 512 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      head -c ${blobKiB * 1024} /dev/urandom | base64 > payload.txt
      i=1; while [ $i -le 50 ]; do printf 'f %s\\n' $i > "f$i.txt"; i=$((i+1)); done
      git add -A && git commit -q -m payload
      git push -q origin main
      `,
    );
    const head = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    yield* Effect.sleep("6 seconds"); // let the bundle land

    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const body = `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`;

    /** One full clone over raw HTTP; resolves to bytes received. */
    const rawClone = client
      .execute(
        HttpClientRequest.post(`${url}/bench/raw.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${repo.token}`,
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );

    // Warm one request so the measurements exclude cold start.
    const packBytes = yield* rawClone;
    expect(packBytes).toBeGreaterThan(1024);

    // The same clone, but with a `have` the server does not know. That
    // disqualifies the bundle (bundleCovers refuses any request carrying
    // haves) while producing the SAME pack, so the two lines below are a
    // like-for-like v1-dynamic vs v2-bundle comparison.
    const unknownHave = "f".repeat(40);
    const dynamicClone = client
      .execute(
        HttpClientRequest.post(`${url}/bench/raw.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${repo.token}`,
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(
            `${pkt(`want ${head}\n`)}${pkt(`have ${unknownHave}\n`)}0000${pkt("done\n")}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );

    const throughput = (
      sizes: ReadonlyArray<number>,
      ms: number,
      n: number,
    ) => {
      const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
      return (
        `${perSecond(n, ms)} clones, ` +
        `${(total / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s`
      );
    };

    for (const concurrency of [1, 8, 32]) {
      yield* measure(
        `raw clone x${concurrency} — bundle (${(packBytes / 1024).toFixed(0)} KiB)`,
        Effect.all(
          Array.from({ length: concurrency }, () => rawClone),
          { concurrency },
        ),
        (sizes, ms) => throughput(sizes, ms, concurrency),
      );
      yield* measure(
        `raw clone x${concurrency} — dynamic closure walk`,
        Effect.all(
          Array.from({ length: concurrency }, () => dynamicClone),
          { concurrency },
        ),
        (sizes, ms) => throughput(sizes, ms, concurrency),
      );
    }
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 2 — subrequest limit vs. fragmented packs (DESIGN §15.2)
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: dynamic fetch over a compacted repo with >1000 objects",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "subreq");
    const tmp = yield* tempDir;
    // Comfortably past the Workers 1000-subrequest cap once compacted:
    // one ranged R2 GET per object would fail outright.
    const files = 1200;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      i=1
      while [ $i -le ${files} ]; do
        printf 'payload %s\\n' $i > "f$i.txt"
        i=$((i+1))
      done
      git add -A && git commit -q -m bulk
      git push -q origin main
      `,
    );

    // Force everything into an R2 pack.
    yield* repo.admin.repos.compact({
      params: { owner: "bench", repo: "subreq" },
    });
    const packed = yield* repo.admin.repos
      .get({ params: { owner: "bench", repo: "subreq" } })
      .pipe(
        Effect.map((found) => found.objects),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (objects: { loose: number; packed: number }) =>
            objects.packed > 1000 && objects.loose === 0,
          times: 120,
        }),
      );
    expect(packed.packed).toBeGreaterThan(1000);

    const head = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

    // A `have` the server does not know bypasses the bundle, so this is the
    // dynamic path reading every object out of the pack.
    yield* measure(
      `dynamic fetch, ${packed.packed} packed objects`,
      client
        .execute(
          HttpClientRequest.post(
            `${url}/bench/subreq.git/git-upload-pack`,
          ).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${repo.token}`,
              "content-type": "application/x-git-upload-pack-request",
            }),
            HttpClientRequest.bodyText(
              `${pkt(`want ${head}\n`)}${pkt(`have ${"f".repeat(40)}\n`)}0000${pkt("done\n")}`,
            ),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(
              Effect.map((buffer) => ({
                status: response.status,
                bytes: buffer.byteLength,
              })),
            ),
          ),
        ),
      (result, ms) =>
        `status ${result.status}, ${(result.bytes / 1024).toFixed(0)} KiB in ${(ms / 1000).toFixed(2)}s`,
    ).pipe(
      Effect.tap((result) => {
        // The whole point: this must NOT fail on the subrequest cap.
        expect(result.status).toBe(200);
        expect(result.bytes).toBeGreaterThan(10_000);
        return Effect.void;
      }),
    );

    // And the repo still clones cleanly through the same path.
    yield* mustSh(tmp, `rm -rf verify && git clone -q '${repo.remote}' verify`);
    yield* mustSh(tmp, `cd verify && git fsck --strict`);
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 1 — push admission. The Repo DO bounds ingest by MEMORY, not
// by push count, so a small push no longer waits out a large upload. Both
// arms run in ONE case so the comparison is same-repo, same-minute.
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: small-push latency alone vs. behind a large upload",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "admit");
    const tmp = yield* tempDir;
    const bigMiB = 12 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      printf 'seed\n' > seed.txt
      git add -A && git commit -q -m seed
      git push -q origin main
      `,
    );

    /** A one-file push to its own branch — kilobytes of actual work. */
    const smallPush = (n: number) =>
      mustSh(
        tmp,
        `
        cd work
        git checkout -q -B "tiny${n}" main
        printf 'tiny %s\n' ${n} > "tiny${n}.txt"
        git add -A && git commit -q -m "tiny${n}"
        git push -q origin "tiny${n}"
        git checkout -q main
        `,
      );

    // Uncontended baseline.
    yield* smallPush(1);
    yield* measure(
      "small push, uncontended",
      smallPush(2),
      (_, ms) => `${ms.toFixed(0)} ms`,
    );

    // Now the same push while a large body is still uploading. Under
    // count-based admission the small push waited for the whole upload;
    // under a byte budget it only needs its own MiB.
    yield* mustSh(
      tmp,
      `
      cd work
      git checkout -q -B heavy main
      head -c ${bigMiB * 1024 * 1024} /dev/urandom > heavy.bin
      git add -A && git commit -q -m heavy
      git checkout -q main
      `,
    );
    // Fork the heavy push so the measurement covers the SMALL push alone,
    // not the pair — timing both together just reports the heavy one.
    const heavy = yield* Effect.forkChild(
      mustSh(tmp, `cd work && git push -q origin heavy`),
    );
    yield* measure(
      `small push, while a ${bigMiB} MiB upload is in flight`,
      smallPush(3),
      (_, ms) => `${ms.toFixed(0)} ms`,
    );
    yield* Fiber.join(heavy);
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 2 — bundle staleness. A ref moving after the bundle was cut
// used to drop every clone onto the dynamic closure walk; the bundle is now
// spliced with a small delta pack instead. Fresh and stale are measured in
// the same run against the same repo.
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: clone TPS against a FRESH vs a STALE bundle",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "stale");
    const tmp = yield* tempDir;
    const blobKiB = 512 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      head -c ${blobKiB * 1024} /dev/urandom | base64 > payload.txt
      i=1; while [ $i -le 50 ]; do printf 'f %s\n' $i > "f$i.txt"; i=$((i+1)); done
      git add -A && git commit -q -m payload
      git push -q origin main
      `,
    );
    yield* Effect.sleep("8 seconds"); // let the bundle land

    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const request = (head: string) =>
      client.execute(
        HttpClientRequest.post(`${url}/bench/stale.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${repo.token}`,
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(
            `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`,
          ),
        ),
      );
    const cloneAt = (head: string) =>
      request(head).pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );
    /** Which plane answered — `do-bundle:bundle`, `…:spliced`, or none. */
    const planeAt = (head: string) =>
      request(head).pipe(
        Effect.map(
          (response) => response.headers["x-git-served-by"] ?? "dynamic",
        ),
      );

    const N = 32 * SCALE;
    const throughput = (sizes: ReadonlyArray<number>, ms: number) => {
      const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
      return (
        `${perSecond(sizes.length, ms)} clones, ` +
        `${(total / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s`
      );
    };

    const fresh = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    yield* cloneAt(fresh); // warm
    const freshPlane = yield* planeAt(fresh);
    results.push(`  fresh arm served by: ${freshPlane}`);
    yield* measure(
      `${N} clones, FRESH bundle, concurrency 32`,
      Effect.all(
        Array.from({ length: N }, () => cloneAt(fresh)),
        { concurrency: 32 },
      ),
      throughput,
    );

    // Move main past the bundle and clone immediately: the bundle on disk
    // no longer names this tip.
    yield* mustSh(
      tmp,
      `
      cd work
      printf 'more\n' > more.txt
      git add -A && git commit -q -m more
      git push -q origin main
      `,
    );
    const stale = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    const warmStale = yield* cloneAt(stale);
    expect(warmStale).toBeGreaterThan(1024);
    const stalePlane = yield* planeAt(stale);
    results.push(`  stale arm served by: ${stalePlane}`);
    yield* measure(
      `${N} clones, STALE bundle (dynamic fallback), concurrency 32`,
      Effect.all(
        Array.from({ length: N }, () => cloneAt(stale)),
        { concurrency: 32 },
      ),
      throughput,
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Single large clone — where does the time go? Splits time-to-first-byte
// (planning: Worker -> DO -> R2 HEAD -> marker) from transfer (bytes on
// the wire), per serving path, on a real ~36 MiB repository. This is the
// instrument for "clones feel slow": a large TTFB is planning latency, a
// low MiB/s with small TTFB is the streaming path itself.
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: single large clone — TTFB vs transfer, by serving path",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const tmp = yield* tempDir;

    // Same source as the real-world suite: this monorepo, depth-1, as one
    // root commit — ~13.6k objects, ~36 MiB.
    const root = (yield* mustSh(process.cwd(), `git rev-parse --show-toplevel`))
      .stdout;
    yield* mustSh(
      tmp,
      `
      rm -rf src
      git clone -q --depth 1 "file://${root}" src
      cd src && rm -rf .git && git init -q -b main && git add -A
      git commit -q -m "alchemy snapshot"
      `,
    );
    const repo = yield* freshRepo(url, "bench", "large", { public: true });
    yield* mustSh(
      tmp,
      `cd src && git remote add origin '${repo.remote}' && git push -q origin main`,
    );
    const head = (yield* mustSh(tmp, `cd src && git rev-parse HEAD`)).stdout;

    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const request = (body: string) =>
      client.execute(
        HttpClientRequest.post(`${url}/bench/large.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${repo.token}`,
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(body),
        ),
      );
    const bodies = {
      passthrough: `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`,
      sideband: `${pkt(`want ${head} side-band-64k\n`)}0000${pkt("done\n")}`,
      dynamic: `${pkt(`want ${head}\n`)}${pkt(`have ${"f".repeat(40)}\n`)}0000${pkt("done\n")}`,
    };

    /**
     * One clone, timed in two halves: headers (TTFB) and body drain — and
     * VERIFIED: the pack is de-framed and its SHA-1 trailer checked. A
     * stream that aborts mid-body can reach a lenient HTTP client as a
     * clean end (seen once: 0.5 MiB of a 40.6 MiB pack, test green), so
     * bytes alone prove nothing.
     */
    const timedClone = (body: string) =>
      Effect.gen(function* () {
        const t0 = performance.now();
        const response = yield* request(body);
        const ttfbMs = performance.now() - t0;
        const raw = new Uint8Array(yield* response.arrayBuffer);
        const totalMs = performance.now() - t0;
        const pack = yield* Effect.sync(() =>
          verifyPackResponse(raw, body.includes("side-band-64k")),
        );
        expect(pack.error, `pack response: ${pack.error}`).toBeUndefined();
        return {
          ttfbMs,
          totalMs,
          bytes: raw.byteLength,
          objects: pack.objects,
          via: response.headers["x-git-served-by"] ?? "dynamic",
        };
      });
    const describe = (r: {
      ttfbMs: number;
      totalMs: number;
      bytes: number;
      objects: number;
      via: string;
    }) =>
      `ttfb ${r.ttfbMs.toFixed(0)}ms, total ${(r.totalMs / 1000).toFixed(2)}s, ` +
      `${(r.bytes / 1048576).toFixed(1)} MiB (${r.objects} objects, trailer ok) @ ` +
      `${(r.bytes / 1048576 / ((r.totalMs - r.ttfbMs) / 1000)).toFixed(1)} MiB/s transfer ` +
      `[${r.via}]`;

    // Wait for the bundle to land (a 36 MiB cut takes a while), bounded.
    yield* timedClone(bodies.passthrough).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (r) => r.via.startsWith("do-bundle"),
        times: 36,
      }),
    );

    for (const [name, body] of Object.entries(bodies)) {
      yield* timedClone(body); // warm
      yield* measure(`large clone x1 — ${name}`, timedClone(body), (r) =>
        describe(r),
      );
    }

    // Does the streaming path scale with parallel streams, or is it a
    // per-stream ceiling? 4 passthrough clones at once.
    yield* measure(
      "large clone x4 — passthrough, concurrent",
      Effect.all(
        Array.from({ length: 4 }, () => timedClone(bodies.passthrough)),
        { concurrency: 4 },
      ),
      (rs, ms) => {
        const total = rs.reduce((n, r) => n + r.bytes, 0);
        return `${(total / 1048576 / (ms / 1000)).toFixed(1)} MiB/s aggregate over ${(ms / 1000).toFixed(2)}s`;
      },
    );
  }).pipe(logLevel),
  { timeout: 1_200_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 8 — the DO on the anonymous read path (Continuity learnings,
// DESIGN.md §21): every advertisement and bundle-planning hop wakes the
// repo DO today, so anonymous public reads share one single-threaded
// object. Baseline for the DO-less head-object fast path.
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: anonymous reads on a PUBLIC repo (advertisement + raw clone TPS)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "pubread", { public: true });
    const tmp = yield* tempDir;
    const blobKiB = 256 * SCALE;

    yield* mustSh(
      tmp,
      `
      rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      head -c ${blobKiB * 1024} /dev/urandom > blob.bin
      i=1; while [ $i -le 20 ]; do printf 'f %s\n' $i > "f$i.txt"; i=$((i+1)); done
      git add -A && git commit -q -m payload
      git push -q origin main
      `,
    );
    const head = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    yield* Effect.sleep("6 seconds"); // let the bundle land

    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

    // TOKENLESS advertisement — GET info/refs with no Authorization.
    const advertise = client
      .get(`${url}/bench/pubread.git/info/refs?service=git-upload-pack`)
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );
    // warm + correctness: the advertisement carries the tip AND proves
    // the DO-less path served it (not an accidental DO fall-through).
    const warmAdv = yield* client.get(
      `${url}/bench/pubread.git/info/refs?service=git-upload-pack`,
    );
    expect(warmAdv.headers["x-git-served-by"]).toBe("head-snapshot");
    const advBytes = (yield* warmAdv.arrayBuffer).byteLength;
    expect(advBytes).toBeGreaterThan(40);

    const SERIAL_N = 20;
    yield* measure(
      `${SERIAL_N} serial anonymous advertisements`,
      Effect.forEach(Array.from({ length: SERIAL_N }), () => advertise),
      (_, ms) => `${(ms / SERIAL_N).toFixed(0)} ms each`,
    );

    const ADV_N = 128 * SCALE;
    yield* measure(
      `${ADV_N} anonymous advertisements, concurrency 32`,
      Effect.all(
        Array.from({ length: ADV_N }, () => advertise),
        { concurrency: 32 },
      ),
      (sizes, ms) => `${perSecond(sizes.length, ms)} advertisements`,
    );

    // TOKENLESS full clone over raw HTTP (want tip, done — bundle-eligible).
    const rawClone = client
      .execute(
        HttpClientRequest.post(`${url}/bench/pubread.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(
            `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );
    // warm + prove the bundle was served DO-lessly from the snapshot
    const warmClone = yield* client.execute(
      HttpClientRequest.post(`${url}/bench/pubread.git/git-upload-pack`).pipe(
        HttpClientRequest.setHeaders({
          "content-type": "application/x-git-upload-pack-request",
        }),
        HttpClientRequest.bodyText(
          `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`,
        ),
      ),
    );
    expect(warmClone.headers["x-git-served-by"]).toBe("head-snapshot:bundle");
    const first = (yield* warmClone.arrayBuffer).byteLength;
    expect(first).toBeGreaterThan(blobKiB * 1024 * 0.5);

    const CLONE_N = 64 * SCALE;
    yield* measure(
      `${CLONE_N} anonymous raw clones, concurrency 32`,
      Effect.all(
        Array.from({ length: CLONE_N }, () => rawClone),
        { concurrency: 32 },
      ),
      (sizes, ms) => {
        const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
        return (
          `${perSecond(sizes.length, ms)} clones, ` +
          `${(total / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s`
        );
      },
    );

    // and a real git clone with NO credentials still works
    const parsed = new URL(url);
    yield* mustSh(
      tmp,
      `rm -rf anon && git clone -q '${parsed.protocol}//${parsed.host}/bench/pubread.git' anon && cd anon && git fsck --strict`,
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bottleneck 9 — pack-count growth (Continuity learnings, DESIGN.md §21):
// each compaction run writes a NEW pack and never merges, so reads over an
// old repo fan out across ever more packs. Baseline for geometric merging.
// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipBench)(
  "bench: dynamic fetch over a repo compacted in 6 increments (pack fan-out)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "bench", "npack");
    const tmp = yield* tempDir;
    const ROUNDS = 6;

    yield* mustSh(
      tmp,
      `rm -rf work && git -c init.defaultBranch=main clone '${repo.remote}' work`,
    );

    // ROUNDS x (push a batch, compact it) => ROUNDS separate packs today.
    for (let round = 1; round <= ROUNDS; round++) {
      yield* mustSh(
        tmp,
        `
        cd work
        i=1; while [ $i -le 12 ]; do head -c ${32 * 1024} /dev/urandom > "r${round}-f$i.bin"; i=$((i+1)); done
        git add -A && git commit -q -m "round ${round}"
        git push -q origin main
        `,
      );
      yield* repo.admin.repos
        .compact({ params: { owner: "bench", repo: "npack" } })
        .pipe(edgeRetry);
      // wait until the loose rows have drained into the pack
      yield* repo.admin.repos
        .get({ params: { owner: "bench", repo: "npack" } })
        .pipe(
          edgeRetry,
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (meta) => meta.objects.loose === 0,
            times: 45,
          }),
        );
    }

    const after = yield* repo.admin.repos
      .get({ params: { owner: "bench", repo: "npack" } })
      .pipe(edgeRetry);
    results.push(
      `npack repo: ${after.objects.packed} packed objects after ${ROUNDS} compactions`.padEnd(
        46,
      ),
    );

    const head = (yield* mustSh(tmp, `cd work && git rev-parse HEAD`)).stdout;
    const client = yield* HttpClient.HttpClient;
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

    // Unknown have forces the dynamic path (bundle refused): the closure
    // walk + object reads must range-read across every pack.
    const unknownHave = "f".repeat(40);
    const dynamicFetch = client
      .execute(
        HttpClientRequest.post(`${url}/bench/npack.git/git-upload-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${repo.token}`,
            "content-type": "application/x-git-upload-pack-request",
          }),
          HttpClientRequest.bodyText(
            `${pkt(`want ${head}\n`)}${pkt(`have ${unknownHave}\n`)}0000${pkt("done\n")}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => buffer.byteLength),
      );

    const warm = yield* dynamicFetch;
    expect(warm).toBeGreaterThan(100_000);

    const N = 8;
    yield* measure(
      `${N} serial dynamic fetches over ${ROUNDS}-increment repo`,
      Effect.forEach(Array.from({ length: N }), () => dynamicFetch),
      (sizes, ms) =>
        `${(ms / N).toFixed(0)} ms/fetch, ` +
        `${((sizes[0] ?? 0) / 1024 / 1024).toFixed(1)} MiB pack`,
    );

    // correctness: clone back clean through the same packs
    yield* mustSh(tmp, `rm -rf verify && git clone -q '${repo.remote}' verify`);
    yield* mustSh(tmp, `cd verify && git fsck --strict`);
  }).pipe(logLevel),
  { timeout: 900_000 },
);
