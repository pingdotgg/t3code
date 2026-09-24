/**
 * Push-ingest profile against the LOCAL workerd (no cloud deploy): pushes
 * the repository at `GIT_PROFILE_REPO` and prints the server's per-phase
 * split. Skipped unless the env var is set — it is a measurement tool, not
 * a regression test (DESIGN §22.4).
 *
 *   GIT_PROFILE_REPO=/path/to/checkout pnpm test test/Git/GitIngestProfile.local.test.ts
 *
 * Do NOT export CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN for this: the
 * profile loader treats env credentials as "configure this profile as env"
 * and rewrites ~/.alchemy/profiles.json.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { GitApi } from "@/Git/Api.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import TestGitHost, { TEST_SECRET } from "./fixtures/stack.ts";

const PROFILE_REPO = process.env.GIT_PROFILE_REPO;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const LocalStack = Alchemy.Stack(
  "GitIngestProfileStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const host = yield* TestGitHost;
    return { url: host.url.as<string>() };
  }),
);

const git = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const handle = yield* ChildProcess.make("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0" },
    extendEnv: true,
  });
  const [exitCode, stderr] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))],
    { concurrency: 2 },
  );
  return { exitCode, stderr };
}, Effect.timeout("10 minutes"));

if (PROFILE_REPO === undefined) {
  test.skip(
    "profile: set GIT_PROFILE_REPO=/path/to/checkout to run",
    Effect.void,
  );
} else {
  const stack = beforeAll(deploy(LocalStack));
  afterAll(destroy(LocalStack));
  test(
    "profile: push GIT_PROFILE_REPO into local workerd and print the ingest split",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpApiClient.make(GitApi, {
        baseUrl: url,
        transformClient: HttpClient.mapRequest((r) =>
          r.pipe(HttpClientRequest.bearerToken(TEST_SECRET)),
        ),
      });
      yield* client.repos
        .get({ params: { owner: "profile", repo: "repo" } })
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
          Effect.catchTag("RepoNotFound", () => Effect.void),
        );
      const created = yield* client.repos.create({
        payload: { owner: "profile", name: "repo" },
      });
      const parsed = new URL(url);
      const remote = `${parsed.protocol}//x:${TEST_SECRET}@${parsed.host}/profile/repo.git`;
      const t0 = performance.now();
      const push = yield* git(
        PROFILE_REPO!,
        "push",
        "-q",
        remote,
        "HEAD:refs/heads/main",
      );
      const wall = performance.now() - t0;
      if (push.exitCode !== 0)
        console.log(
          "[ingest-profile] PUSH FAILED:",
          push.stderr.slice(0, 2000),
        );
      expect(push.exitCode, push.stderr).toBe(0);
      const meta = yield* client.repos.get({
        params: { owner: "profile", repo: "repo" },
      });
      // Clone it back and let real git verify — a promoted push must read
      // back byte-for-byte through the wire pack.
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectory({
        prefix: "git-ingest-profile-",
      });
      const clone = yield* git(tmp, "clone", "-q", remote, "back");
      if (clone.exitCode !== 0)
        console.log(
          "[ingest-profile] CLONE FAILED:",
          clone.stderr.slice(0, 2000),
        );
      expect(clone.exitCode, clone.stderr).toBe(0);
      const fsck = yield* git(`${tmp}/back`, "fsck", "--connectivity-only");
      if (fsck.exitCode !== 0)
        console.log(
          "[ingest-profile] FSCK FAILED:",
          fsck.stderr.slice(0, 2000),
        );
      expect(fsck.exitCode, fsck.stderr).toBe(0);
      console.log(
        `[ingest-profile] objects: ${JSON.stringify(meta.objects)}; clone back + fsck ok`,
      );
      const p = meta.lastPush!;
      // Counts (chunks, regions, unresolved) are reported alongside the
      // wall-clock phases; label them as such.
      const counts = new Set(["chunks", "regions", "unresolved"]);
      const phases = Object.entries(p.phases ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => (counts.has(k) ? `${k}=${v}` : `${k} ${v}ms`))
        .join(", ");
      console.log(
        `[ingest-profile] ${p.objects} objects, ${(p.bytes / 1048576).toFixed(1)} MiB: ` +
          `ingest ${p.ingestMs}ms (sql ${p.stageMs}ms, cpu ${p.ingestMs - p.stageMs}ms → ${((p.ingestMs - p.stageMs) / p.objects).toFixed(2)} ms/object) ` +
          `connectivity ${p.connectivityMs}ms finalize ${p.finalizeMs}ms total ${p.totalMs}ms; wall ${wall.toFixed(0)}ms\n` +
          `[ingest-profile] phases: ${phases}`,
      );
    }),
    { timeout: 600_000 },
  );
}
