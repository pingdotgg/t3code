/**
 * Real-world load: push **this repository** to a deployed git-service.
 *
 * Every other suite pushes toy histories. This one takes the actual alchemy
 * monorepo — ~13.6k objects, ~36 MiB, 12k+ files in one tree — and drives
 * the whole pipeline with it: thin-pack ingest at scale, the object store,
 * compaction into R2 packs, clone bundles, and byte-for-byte clone
 * fidelity verified by `git fsck --strict` plus a tree comparison.
 *
 * The source is the repo the tests are running inside (`git rev-parse
 * --show-toplevel`), so it works on any checkout, and the suite skips
 * itself when that is not a git repo.
 *
 * Shape of the fixture: a **depth-1 clone re-committed as a single root
 * commit**. That keeps the object count and byte volume of the real repo
 * (which is the point) while staying a fully connected history — pushing
 * from a shallow clone would send commits whose parents are missing, which
 * receive-pack correctly refuses.
 *
 * Slow by construction; skipped under `--fast`.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { GitApi } from "@/Git/Api.ts";
import { makeTestStack, TEST_SECRET } from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = makeTestStack("GitRealWorldStack");

const skipHuge = !!process.env.FAST;

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
    return `shell exited ${this.exitCode}\n--- script ---\n${this.script}\n--- stderr ---\n${this.stderr}`;
  }
}

/** Bounded `sh -c` with hermetic git identity; 10 min covers a 36 MiB push. */
const sh = Effect.fn(function* (cwd: string, script: string) {
  const handle = yield* ChildProcess.make("sh", ["-ec", script], {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Real World Bot",
      GIT_AUTHOR_EMAIL: "realworld@example.com",
      GIT_COMMITTER_NAME: "Real World Bot",
      GIT_COMMITTER_EMAIL: "realworld@example.com",
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
}, Effect.timeout("600 seconds"));

const mustSh = Effect.fn(function* (cwd: string, script: string) {
  const result = yield* sh(cwd, script);
  if (result.exitCode !== 0) return yield* new ShellError(result);
  return result;
});

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-realworld-" });
});

const edgeRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("15 seconds"),
    Effect.retry({ schedule: Schedule.spaced("1500 millis"), times: 40 }),
  );

const freshRepo = Effect.fn(function* (
  url: string,
  owner: string,
  name: string,
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  const created = yield* Effect.gen(function* () {
    yield* admin.repos.delete({ params: { owner, repo: name } }).pipe(
      Effect.catchTag("RepoNotFound", () => Effect.void),
      edgeRetry,
    );
    yield* admin.repos.get({ params: { owner, repo: name } }).pipe(
      edgeRetry,
      Effect.as(false),
      Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (gone) => gone,
        times: 60,
      }),
    );
    return yield* admin.repos
      .create({ payload: { owner, name } })
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
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// ═══════════════════════════════════════════════════════════════════════════

test.skipIf(skipHuge)(
  "real world: push this entire repository, clone it back, compact it",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const tmp = yield* tempDir;

    // The repo under test is the one these tests live in.
    const root = (yield* mustSh(process.cwd(), `git rev-parse --show-toplevel`))
      .stdout;
    expect(root.length).toBeGreaterThan(0);

    // Depth-1 clone, re-committed as a single root commit: keeps the real
    // object count and byte volume, but fully connected (a shallow push
    // would reference parents the server does not have).
    yield* mustSh(
      tmp,
      `
      rm -rf src
      git clone -q --depth 1 "file://${root}" src
      cd src
      rm -rf .git
      git init -q -b main
      git add -A
      git commit -q -m "alchemy snapshot"
      `,
    );

    const stats = (yield* mustSh(
      tmp,
      `cd src && git count-objects -v | tr '\\n' ' '`,
    )).stdout;
    const files = Number.parseInt(
      (yield* mustSh(tmp, `cd src && git ls-files | wc -l`)).stdout,
      10,
    );
    const head = (yield* mustSh(tmp, `cd src && git rev-parse HEAD`)).stdout;
    const tree = (yield* mustSh(tmp, `cd src && git rev-parse HEAD^{tree}`))
      .stdout;
    yield* Effect.logInfo(
      `[real-world] source: ${files} files, ${stats.trim()}`,
    );
    expect(files).toBeGreaterThan(5_000);

    const repo = yield* freshRepo(url, "real", "alchemy");

    // ── the push ─────────────────────────────────────────────────────────
    const pushStarted = yield* Effect.sync(() => performance.now());
    yield* mustSh(
      tmp,
      `cd src && git remote add origin '${repo.remote}' && git push origin main`,
    );
    const pushMs = yield* Effect.sync(() => performance.now() - pushStarted);
    yield* Effect.logInfo(
      `[real-world] pushed ${files} files in ${(pushMs / 1000).toFixed(1)}s`,
    );

    // The server's view must match the client's exactly.
    const remoteRef = yield* repo.admin.refs.get({
      params: { owner: "real", repo: "alchemy" },
      query: { name: "refs/heads/main" },
    });
    expect(remoteRef.oid).toBe(head);

    const meta = yield* repo.admin.repos.get({
      params: { owner: "real", repo: "alchemy" },
    });
    yield* Effect.logInfo(
      `[real-world] stored ${meta.objects.loose + meta.objects.packed + meta.objects.r2} objects, ` +
        `${(meta.objects.bytes / 1024 / 1024).toFixed(1)} MiB`,
    );
    // Server-side timing (DESIGN.md §19 phase 0): the wall clock above also
    // covers client packing and the upload, so this is what is actually ours.
    if (meta.lastPush !== null) {
      const p = meta.lastPush;
      yield* Effect.logInfo(
        `[real-world] SERVER ingest ${p.ingestMs}ms (sql ${p.stageMs}ms / cpu ${p.ingestMs - p.stageMs}ms) + connectivity ${p.connectivityMs}ms + ` +
          `finalize ${p.finalizeMs}ms = ${p.totalMs}ms for ${p.objects} objects ` +
          `[phases: ${Object.entries(p.phases ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}ms`)
            .join(", ")}] ` +
          `(${(p.totalMs / Math.max(p.objects, 1)).toFixed(2)}ms/object); ` +
          `client+network = ${(pushMs - p.totalMs).toFixed(0)}ms of the ${(pushMs / 1000).toFixed(1)}s wall clock`,
      );
      expect(p.objects).toBeGreaterThan(5_000);
    }
    expect(
      meta.objects.loose + meta.objects.packed + meta.objects.r2,
    ).toBeGreaterThan(5_000);

    // ── clone it back and prove it is identical ──────────────────────────
    const cloneStarted = yield* Effect.sync(() => performance.now());
    yield* mustSh(tmp, `rm -rf back && git clone -q '${repo.remote}' back`);
    const cloneMs = yield* Effect.sync(() => performance.now() - cloneStarted);
    yield* Effect.logInfo(
      `[real-world] cloned back in ${(cloneMs / 1000).toFixed(1)}s`,
    );

    yield* mustSh(tmp, `cd back && git fsck --strict`);
    expect((yield* mustSh(tmp, `cd back && git rev-parse HEAD`)).stdout).toBe(
      head,
    );
    // The tree oid matching means every path, mode and blob matches.
    expect(
      (yield* mustSh(tmp, `cd back && git rev-parse HEAD^{tree}`)).stdout,
    ).toBe(tree);
    expect(
      Number.parseInt(
        (yield* mustSh(tmp, `cd back && git ls-files | wc -l`)).stdout,
        10,
      ),
    ).toBe(files);
    // NOTE: no `diff -r` here. The tree oid equality above is the stronger
    // and *correct* assertion — identical tree oids mean every path, mode
    // and blob content matches. A directory diff also compares things git
    // deliberately does not track (empty directories, e.g. the checked-out
    // submodule mount points), which differ legitimately between a working
    // tree and a fresh clone of it.

    // ── compact the real repo into R2 packs, then clone again ────────────
    yield* repo.admin.repos.compact({
      params: { owner: "real", repo: "alchemy" },
    });
    const packed = yield* repo.admin.repos
      .get({ params: { owner: "real", repo: "alchemy" } })
      .pipe(
        Effect.map((found) => found.objects),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (objects: { loose: number; packed: number }) =>
            objects.packed > 0 && objects.loose === 0,
          times: 150,
        }),
      );
    yield* Effect.logInfo(
      `[real-world] compacted: ${packed.packed} objects in R2 packs`,
    );
    expect(packed.packed).toBeGreaterThan(5_000);

    const packedCloneStarted = yield* Effect.sync(() => performance.now());
    yield* mustSh(tmp, `rm -rf packed && git clone -q '${repo.remote}' packed`);
    yield* Effect.logInfo(
      `[real-world] cloned from R2 packs in ${(
        (yield* Effect.sync(() => performance.now())) - packedCloneStarted
      ).toFixed(0)}ms`,
    );
    yield* mustSh(tmp, `cd packed && git fsck --strict`);
    expect(
      (yield* mustSh(tmp, `cd packed && git rev-parse HEAD^{tree}`)).stdout,
    ).toBe(tree);

    // ── an incremental push on top of the real repo still works ──────────
    yield* mustSh(
      tmp,
      `
      cd src
      echo "real world" > REALWORLD.md
      git add REALWORLD.md
      git commit -q -m "incremental on top of a real repo"
      git push origin main
      `,
    );
    yield* mustSh(tmp, `cd back && git pull -q origin main`);
    expect((yield* mustSh(tmp, `cd back && git rev-parse HEAD`)).stdout).toBe(
      (yield* mustSh(tmp, `cd src && git rev-parse HEAD`)).stdout,
    );
  }).pipe(logLevel),
  { timeout: 900_000 },
);
