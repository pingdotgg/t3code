/**
 * Tier-3 — the money suite (DESIGN.md §9 steps 1–14): the real `git` binary
 * driven via the Effect `ChildProcess` service against a deployed
 * git-service stack, work-trees under `FileSystem.makeTempDirectory`.
 *
 * Every git invocation is bounded (60s command timeout inside ≤120s tests);
 * slow cases are `skipIf(process.env.FAST)`. `NO_DESTROY=1` keeps the
 * deployment between local iterations.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { GitApi, type Oid } from "@/Git/Api.ts";
import { makeTestStack, TEST_SECRET } from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = makeTestStack("GitServiceE2EStack");

// ── REST plumbing ───────────────────────────────────────────────────────────

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

const asOid = (oid: string): Oid => oid as Oid;

const edgeRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("10 seconds"),
    Effect.retry({
      while: (error: unknown) =>
        (error as { _tag?: string })._tag === "TimeoutError" ||
        ((error as { _tag?: string })._tag === "HttpClientError" &&
          (!(error as { response?: { status: number } }).response ||
            (error as { response: { status: number } }).response.status ===
              404 ||
            (error as { response: { status: number } }).response.status >=
              500)),
      schedule: Schedule.spaced("1500 millis"),
      times: 40,
    }),
  );

/** Delete-if-exists + wait until the deterministic name is free again. */
const purgeRepo = Effect.fn(function* (
  url: string,
  owner: string,
  repo: string,
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  // edgeRetry on every step: a freshly deployed workers.dev route serves
  // transient 5xx/1042s for a few seconds (typed 404s decode fine and are
  // NOT retried — they end the poll).
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

// ── git CLI plumbing ────────────────────────────────────────────────────────

class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return `git ${this.args.join(" ")} exited ${this.exitCode}\n--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`;
  }
}

const git = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const handle = yield* ChildProcess.make("git", args, {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
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
  return { args, exitCode, stdout: stdout.trim(), stderr };
}, Effect.timeout("60 seconds"));

const mustGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode !== 0) {
    return yield* new GitError(result);
  }
  return result;
});

const mustFailGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode === 0) {
    return yield* new GitError(result);
  }
  return result;
});

/** Bounded retry of a git command through transient edge/contention windows. */
const retryGit = (cwd: string, ...args: Array<string>) =>
  mustGit(cwd, ...args).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GitError" || error._tag === "TimeoutError",
      schedule: Schedule.spaced("3 seconds"),
      times: 5,
    }),
  );

const authRemote = (url: string, token: string, owner: string, repo: string) =>
  Effect.sync(() => {
    const parsed = new URL(url);
    return `${parsed.protocol}//x:${token}@${parsed.host}/${owner}/${repo}.git`;
  });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-service-e2e-" });
});

/** Purge + create a repo, returning the admin client and an authed remote. */
const freshRepo = Effect.fn(function* (
  url: string,
  owner: string,
  name: string,
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  // Retry the whole purge -> create CYCLE, never the bare POST: a create
  // that commits server-side but loses its response (edge 5xx mid-rollout)
  // leaves the name taken, so retrying just the POST would 409 forever.
  const created = yield* Effect.gen(function* () {
    yield* purgeRepo(url, owner, name);
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
  return {
    admin,
    created,
    token: TEST_SECRET,
    remote: yield* authRemote(url, TEST_SECRET, owner, name),
  };
});

/** Deterministic pseudo-random bytes (xorshift32) — stable across runs. */
const deterministicBytes = (length: number, seed: number) =>
  Effect.sync(() => {
    const bytes = new Uint8Array(length);
    let state = seed >>> 0 || 1;
    for (let i = 0; i < length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 0xff;
    }
    return bytes;
  });

const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        // Printed so a failing live run can be probed by hand (curl/git).
        yield* Effect.logInfo(`git-service deployed at ${url}`);
        const admin = yield* makeClient(url, TEST_SECRET);
        // Readiness probe: retry on ANY failure, not just transport errors.
        // Right after a rollout the edge briefly serves the PREVIOUS worker
        // version, whose responses decode against the old schema — that
        // surfaces as a SchemaError on a 200, which `edgeRetry` ignores by
        // design. Waiting here means "the deployed version answers the
        // schema this test binary was built against".
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

// ── steps 1 + 2: empty clone, first push, REST agreement ────────────────────

test(
  "empty-repo clone, first push (exec bit, symlink, subdir), REST agreement",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-basic");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "e2e", repo: "proto-basic" };

    // step 1: empty clone succeeds with the empty-repo warning
    const clone = yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    expect(`${clone.stdout}\n${clone.stderr}`).toContain("empty repository");
    const work = path.join(tmp, "work");

    // step 2: three commits — plain file, subdir, executable + symlink
    yield* fs.writeFileString(path.join(work, "hello.txt"), "hello e2e\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1: hello");
    yield* fs.makeDirectory(path.join(work, "sub"), { recursive: true });
    yield* fs.writeFileString(path.join(work, "sub", "nested.txt"), "nested\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2: subdir");
    yield* fs.writeFileString(
      path.join(work, "run.sh"),
      "#!/bin/sh\necho ok\n",
    );
    yield* fs.chmod(path.join(work, "run.sh"), 0o755);
    yield* fs.symlink("hello.txt", path.join(work, "link.txt"));
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c3: modes");
    // A fresh workers.dev rollout can still return its HTML 404 on
    // receive-pack discovery after upload-pack (the empty clone) succeeds.
    yield* retryGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // REST agrees byte-for-byte with the CLI's view
    const refs = yield* admin.refs.list({ params, query: {} });
    expect(refs.refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(head);
    const commit = yield* admin.objects.commit({
      params: { ...params, oid: asOid(head) },
    });
    expect(commit.message).toContain("c3: modes");
    const tree = yield* admin.objects.tree({
      params: { ...params, oid: commit.tree },
    });
    expect(tree.entries.find((e) => e.name === "run.sh")?.mode).toBe("100755");
    expect(tree.entries.find((e) => e.name === "link.txt")?.mode).toBe(
      "120000",
    );
    expect(tree.entries.find((e) => e.name === "sub")?.type).toBe("tree");

    // the /file raw route serves the working-tree bytes
    const http = yield* HttpClient.HttpClient;
    const file = yield* http.get(
      `${url}/api/v1/repos/e2e/proto-basic/file?ref=refs/heads/main&path=sub/nested.txt`,
      { headers: { authorization: `Bearer ${TEST_SECRET}` } },
    );
    expect(file.status).toBe(200);
    expect(yield* file.text).toBe("nested\n");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── steps 3 + 4: clone-back + fsck, incremental fetch ───────────────────────

test(
  "clone-back is fsck-clean; incremental fetch rides the haves/ACK path",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* freshRepo(url, "e2e", "proto-fetch");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v1\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v2\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c2");
    yield* retryGit(a, "push", "origin", "main");

    // step 3: fresh clone, strict fsck, identical log
    yield* retryGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* mustGit(b, "fsck", "--strict");
    const logA = (yield* mustGit(a, "log", "--format=%H %s")).stdout;
    const logB = (yield* mustGit(b, "log", "--format=%H %s")).stdout;
    expect(logB).toBe(logA);

    // step 4: two more commits from A; B fetches incrementally + ff-merges
    yield* fs.writeFileString(path.join(a, "file.txt"), "v3\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c3");
    yield* fs.writeFileString(path.join(a, "extra.txt"), "extra\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c4");
    yield* mustGit(a, "push", "origin", "main");
    const headA = (yield* mustGit(a, "rev-parse", "HEAD")).stdout;

    yield* mustGit(b, "fetch", "origin");
    yield* mustGit(b, "merge", "--ff-only", "origin/main");
    expect((yield* mustGit(b, "rev-parse", "HEAD")).stdout).toBe(headA);
    expect(yield* fs.readFileString(path.join(b, "file.txt"))).toBe("v3\n");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 5: CAS, force push, concurrent CAS race, --atomic ──────────────────

test(
  "non-FF push rejected, force push wins, concurrent CAS race has one winner",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* freshRepo(url, "e2e", "proto-cas");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "f.txt"), "base\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "base");
    yield* mustGit(a, "push", "origin", "main");

    // B clones at base; A advances; B's stale push gets the server-side ng
    yield* retryGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* fs.writeFileString(path.join(a, "f.txt"), "a2\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "a2");
    yield* mustGit(a, "push", "origin", "main");

    yield* fs.writeFileString(path.join(b, "g.txt"), "b2\n");
    yield* mustGit(b, "add", "-A");
    yield* mustGit(b, "commit", "-m", "b2");
    const rejected = yield* mustFailGit(b, "push", "origin", "main");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("rejected");

    // force push after fetch overwrites; the other clone fetches it cleanly
    yield* mustGit(b, "fetch", "origin");
    yield* mustGit(b, "push", "--force", "origin", "main");
    const headB = (yield* mustGit(b, "rev-parse", "HEAD")).stdout;
    yield* mustGit(a, "fetch", "origin");
    expect((yield* mustGit(a, "rev-parse", "origin/main")).stdout).toBe(headB);

    // CAS race: both clones at the same base push divergent tips concurrently;
    // the Repo DO serializes — exactly one wins, the other reports ng/rejected
    yield* mustGit(a, "reset", "--hard", "origin/main");
    yield* fs.writeFileString(path.join(a, "race.txt"), "from-a\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "race-a");
    yield* fs.writeFileString(path.join(b, "race.txt"), "from-b\n");
    yield* mustGit(b, "add", "-A");
    yield* mustGit(b, "commit", "-m", "race-b");
    const [pushA, pushB] = yield* Effect.all(
      [git(a, "push", "origin", "main"), git(b, "push", "origin", "main")],
      { concurrency: 2 },
    );
    const succeeded = [pushA, pushB].filter((r) => r.exitCode === 0);
    expect(succeeded.length).toBe(1);

    // --atomic: a batch with one stale CAS is all-or-nothing
    const loser = pushA.exitCode === 0 ? b : a;
    yield* mustFailGit(
      loser,
      "push",
      "--atomic",
      "origin",
      "main",
      "HEAD:refs/heads/atomic-side",
    );
    const admin = yield* makeClient(url, TEST_SECRET);
    const refs = yield* admin.refs.list({
      params: { owner: "e2e", repo: "proto-cas" },
      query: {},
    });
    // the side branch must NOT exist — the failed main CAS aborted the batch
    expect(refs.refs.some((r) => r.name === "refs/heads/atomic-side")).toBe(
      false,
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 6: concurrent push serialization ───────────────────────────────────

test(
  "two concurrent pushes to different branches both land (semaphore, no corruption)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-concurrent");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "f.txt"), "base\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "base");
    yield* mustGit(a, "push", "origin", "main");

    yield* retryGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* fs.writeFileString(path.join(a, "a.txt"), "a\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "branch-a");
    yield* fs.writeFileString(path.join(b, "b.txt"), "b\n");
    yield* mustGit(b, "add", "-A");
    yield* mustGit(b, "commit", "-m", "branch-b");

    // different target refs: no CAS conflict — both must eventually succeed
    // (second may wait on the push semaphore or see a 503 + clean retry)
    yield* Effect.all(
      [
        retryGit(a, "push", "origin", "HEAD:refs/heads/side-a"),
        retryGit(b, "push", "origin", "HEAD:refs/heads/side-b"),
      ],
      { concurrency: 2 },
    );
    const refs = yield* admin.refs.list({
      params: { owner: "e2e", repo: "proto-concurrent" },
      query: { prefix: "refs/heads/" },
    });
    const names = refs.refs.map((r) => r.name);
    expect(names).toContain("refs/heads/side-a");
    expect(names).toContain("refs/heads/side-b");

    // and the repo is not corrupted
    yield* retryGit(tmp, "clone", remote, "check");
    yield* mustGit(path.join(tmp, "check"), "fsck", "--strict");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 7: branch + annotated tag lifecycle ────────────────────────────────

test(
  "branch and annotated tag round-trip (peeled ^{} advertisement) and delete",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-tags");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "e2e", repo: "proto-tags" };

    yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "one\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // annotated tag is stored and served as a real tag object (the ripgit
    // silent-drop bug is this named regression)
    yield* mustGit(work, "tag", "-a", "v1", "-m", "release v1");
    yield* mustGit(work, "push", "origin", "v1");
    const tagOid = (yield* mustGit(work, "rev-parse", "v1")).stdout;
    expect(tagOid).not.toBe(head);
    const tagRef = yield* admin.refs.get({
      params,
      query: { name: "refs/tags/v1" },
    });
    expect(tagRef.oid).toBe(tagOid);
    expect(tagRef.peeled).toBe(head);
    const lsRemote = (yield* mustGit(work, "ls-remote", "--tags", "origin"))
      .stdout;
    expect(lsRemote).toContain(`${tagOid}\trefs/tags/v1`);
    expect(lsRemote).toContain(`${head}\trefs/tags/v1^{}`);

    // a fresh clone materializes the annotated tag object intact
    yield* retryGit(tmp, "clone", remote, "verify");
    const verify = path.join(tmp, "verify");
    expect((yield* mustGit(verify, "cat-file", "-t", tagOid)).stdout).toBe(
      "tag",
    );
    expect((yield* mustGit(verify, "tag", "-l", "v1")).stdout).toBe("v1");

    // branch push + delete-refs on both kinds
    yield* mustGit(work, "push", "origin", "main:feature");
    yield* mustGit(work, "push", "origin", "--delete", "feature");
    yield* mustGit(work, "push", "origin", "--delete", "v1");
    const refs = yield* admin.refs.list({ params, query: {} });
    expect(refs.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 8: shallow clone + deepen ──────────────────────────────────────────

test(
  "shallow clone --depth 1 truncates history; fetch --depth 2 extends it",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* freshRepo(url, "e2e", "proto-shallow");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "full",
    );
    const full = path.join(tmp, "full");
    for (const n of ["c1", "c2", "c3"]) {
      yield* fs.writeFileString(path.join(full, "f.txt"), `${n}\n`);
      yield* mustGit(full, "add", "-A");
      yield* mustGit(full, "commit", "-m", n);
    }
    yield* mustGit(full, "push", "origin", "main");

    // depth-1 clone sees exactly one commit and is marked shallow
    yield* retryGit(tmp, "clone", "--depth", "1", remote, "shallow");
    const shallow = path.join(tmp, "shallow");
    const countShallow = (yield* mustGit(
      shallow,
      "rev-list",
      "--count",
      "HEAD",
    )).stdout;
    expect(countShallow).toBe("1");
    expect(yield* fs.exists(path.join(shallow, ".git", "shallow"))).toBe(true);
    expect(yield* fs.readFileString(path.join(shallow, "f.txt"))).toBe("c3\n");

    // deepen by one commit — absolute --depth (v1 supports `deepen <n>`
    // only; `--deepen` needs the deepen-relative capability, cut in v1)
    yield* mustGit(shallow, "fetch", "--depth", "2", "origin");
    const deepened = (yield* mustGit(shallow, "rev-list", "--count", "HEAD"))
      .stdout;
    expect(deepened).toBe("2");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 9: large blob through R2 ───────────────────────────────────────────

test.skipIf(!!process.env.FAST)(
  "a 3 MiB deterministic binary round-trips byte-identically (location='r2')",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* freshRepo(url, "e2e", "proto-bigblob");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    // deterministic (seeded) noise: > 1 MiB compressed, forcing the R2 path
    const noise = yield* deterministicBytes(3 * 1024 * 1024, 0xa1c4e57);
    yield* fs.writeFile(path.join(a, "big.bin"), noise);
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "big blob");
    yield* mustGit(a, "push", "origin", "main");
    const blobOid = (yield* mustGit(a, "rev-parse", "HEAD:big.bin")).stdout;

    yield* retryGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* mustGit(b, "fsck", "--strict");
    expect((yield* mustGit(b, "rev-parse", "HEAD:big.bin")).stdout).toBe(
      blobOid,
    );
    const roundTripped = yield* fs.readFile(path.join(b, "big.bin"));
    expect(roundTripped.length).toBe(noise.length);
    expect(Buffer.compare(Buffer.from(roundTripped), Buffer.from(noise))).toBe(
      0,
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 10: big-ish push (deep delta chains) ───────────────────────────────

test.skipIf(!!process.env.FAST)(
  "a ~500-commit history pushes and clones back within budget",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* freshRepo(url, "e2e", "proto-many");
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* retryGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    // one sh child builds the history (500 spawns of `git commit` inside a
    // single shell — deterministic content, growing file → deep delta chains)
    const script = [
      "set -e",
      "for i in $(seq 1 500); do",
      '  echo "line $i of the growing fixture payload" >> grow.txt',
      "  git add grow.txt",
      '  git commit -q -m "c$i"',
      "done",
    ].join("\n");
    const handle = yield* ChildProcess.make("sh", ["-c", script], {
      cwd: a,
      env: {
        GIT_AUTHOR_NAME: "Test User",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test User",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      extendEnv: true,
    });
    expect(yield* handle.exitCode.pipe(Effect.timeout("60 seconds"))).toBe(0);

    yield* mustGit(a, "push", "origin", "main");
    const head = (yield* mustGit(a, "rev-parse", "HEAD")).stdout;

    yield* retryGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* mustGit(b, "fsck", "--strict");
    expect((yield* mustGit(b, "rev-parse", "HEAD")).stdout).toBe(head);
    expect((yield* mustGit(b, "rev-list", "--count", "HEAD")).stdout).toBe(
      "500",
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 11: readOnly ───────────────────────────────────────────────────────

test(
  "readOnly repos reject pushes per-ref; unflag restores writes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-readonly");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "e2e", repo: "proto-readonly" };

    yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "one\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");

    yield* admin.repos.update({ params, payload: { readOnly: true } });
    yield* fs.writeFileString(path.join(work, "f.txt"), "two\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2");
    const rejected = yield* mustFailGit(work, "push", "origin", "main");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("rejected");
    // reads still work while readOnly
    yield* mustGit(work, "fetch", "origin");

    yield* admin.repos.update({ params, payload: { readOnly: false } });
    yield* mustGit(work, "push", "origin", "main");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 12: auth matrix ────────────────────────────────────────────────────

test(
  "auth matrix: an unknown credential is anonymous and 401s on a private repo",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-auth");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "e2e", repo: "proto-auth" };

    yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "seed",
    );
    const seed = path.join(tmp, "seed");
    yield* fs.writeFileString(path.join(seed, "f.txt"), "seed\n");
    yield* mustGit(seed, "add", "-A");
    yield* mustGit(seed, "commit", "-m", "c1");
    yield* mustGit(seed, "push", "origin", "main");

    // garbage token → 401 (git surfaces the auth failure on stderr)
    const badRemote = yield* authRemote(url, "gs_garbage", "e2e", "proto-auth");
    const unauthorized = yield* mustFailGit(tmp, "clone", badRemote, "nope");
    expect(unauthorized.stderr.toLowerCase()).toMatch(/401|authentication/);

    // token embedded in the remote URL: read scope clones, cannot push
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ── step 13: fork + import ──────────────────────────────────────────────────

test.skipIf(!!process.env.FAST)(
  "fork: identical history, divergent push isolation, parent delete keeps the fork alive",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { admin, remote } = yield* freshRepo(url, "e2e", "proto-fork-src");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    yield* purgeRepo(url, "e2e", "proto-fork-dst");

    // seed the parent
    yield* retryGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "src",
    );
    const src = path.join(tmp, "src");
    yield* fs.writeFileString(path.join(src, "f.txt"), "one\n");
    yield* mustGit(src, "add", "-A");
    yield* mustGit(src, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(src, "f.txt"), "two\n");
    yield* mustGit(src, "add", "-A");
    yield* mustGit(src, "commit", "-m", "c2");
    yield* mustGit(src, "push", "origin", "main");
    const parentHead = (yield* mustGit(src, "rev-parse", "HEAD")).stdout;

    // fork via REST, poll until the alarm job flips it ready
    const forked = yield* admin.repos.fork({
      params: { owner: "e2e", repo: "proto-fork-src" },
      payload: { targetOwner: "e2e", targetName: "proto-fork-dst" },
    });
    expect(forked.repo.status).toBe("forking");
    expect(forked.repo.forkOf).toBeTruthy();
    const ready = yield* admin.repos
      .get({ params: { owner: "e2e", repo: "proto-fork-dst" } })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (repo) => repo.status === "ready",
          times: 45,
        }),
      );
    expect(ready.status).toBe("ready");

    // the fork clones with its own bootstrap token and matches the parent
    const forkRemote = yield* authRemote(
      url,
      TEST_SECRET,
      "e2e",
      "proto-fork-dst",
    );
    yield* retryGit(tmp, "clone", forkRemote, "dst");
    const dst = path.join(tmp, "dst");
    yield* mustGit(dst, "fsck", "--strict");
    expect((yield* mustGit(dst, "rev-parse", "HEAD")).stdout).toBe(parentHead);

    // divergent push to the fork leaves the parent untouched
    yield* fs.writeFileString(path.join(dst, "fork-only.txt"), "fork\n");
    yield* mustGit(dst, "add", "-A");
    yield* mustGit(dst, "commit", "-m", "fork-only");
    yield* mustGit(dst, "push", "origin", "main");
    const parentRefs = yield* admin.refs.list({
      params: { owner: "e2e", repo: "proto-fork-src" },
      query: {},
    });
    expect(parentRefs.refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(
      parentHead,
    );

    // delete the parent → the fork still clones (R2 fork-retention pin)
    yield* admin.repos.delete({
      params: { owner: "e2e", repo: "proto-fork-src" },
    });
    yield* admin.repos
      .get({ params: { owner: "e2e", repo: "proto-fork-src" } })
      .pipe(
        Effect.as(false),
        Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (gone) => gone,
          times: 45,
        }),
      );
    yield* retryGit(tmp, "clone", forkRemote, "dst2");
    yield* mustGit(path.join(tmp, "dst2"), "fsck", "--strict");

    yield* purgeRepo(url, "e2e", "proto-fork-dst");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test.skipIf(!!process.env.FAST)(
  "import: depth-limited import from a public smart-HTTP source reaches ready",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    yield* purgeRepo(url, "e2e", "proto-import");

    // a tiny, stable public repo; depth-limited to stay under the 50 MiB cap.
    // (Importing a sibling repo of the SAME deployment would make the worker
    // fetch its own hostname, which Cloudflare blocks as worker recursion.)
    const imported = yield* admin.repos.import({
      payload: {
        owner: "e2e",
        name: "proto-import",
        source: { url: "https://github.com/octocat/Hello-World.git", depth: 1 },
      },
    });
    expect(imported.repo.status).toBe("importing");

    const ready = yield* admin.repos
      .get({ params: { owner: "e2e", repo: "proto-import" } })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (repo) => repo.status === "ready",
          times: 45,
        }),
      );
    expect(ready.status).toBe("ready");

    const refs = yield* admin.refs.list({
      params: { owner: "e2e", repo: "proto-import" },
      query: {},
    });
    expect(refs.refs.length).toBeGreaterThan(0);

    // and the imported history clones with a fresh token
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const importRemote = yield* authRemote(
      url,
      TEST_SECRET,
      "e2e",
      "proto-import",
    );
    // the import was depth-limited, so the repo's history is shallow —
    // v0 can only serve that to a shallow-aware client (see handleUploadPack)
    yield* retryGit(tmp, "clone", "--depth", "1", importRemote, "imported");
    yield* mustGit(path.join(tmp, "imported"), "fsck", "--strict");

    yield* purgeRepo(url, "e2e", "proto-import");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// step 14 (cleanup pin) is the afterAll destroy above; out-of-band distilled
// verification of the R2 prefix + Registry rows is a coordinator-level check
// (this package does not depend on distilled).
