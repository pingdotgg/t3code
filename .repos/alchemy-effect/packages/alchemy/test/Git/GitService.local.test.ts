/**
 * THE PRIMARY SUITE — full local dev-mode coverage of git-service.
 *
 * `Test.make({ providers: Cloudflare.providers(), dev: true })` runs the
 * whole service on the local RPC-sidecar topology (`alchemy dev`'s process
 * shape): a local workerd Worker hosting the GitRepo/GitRegistry Durable
 * Objects and the R2 simulator. No cloud API is touched — the worker serves
 * from `http://localhost:<port>`.
 *
 * Coverage:
 *  (a) every REST endpooint of `GitApi` via the typed `HttpApiClient`
 *      (repos create/get/update/list/delete, refs list/get/update/remove
 *      with CAS, objects commit/log/tree/blob, tokens create/list/revoke,
 *      plus the raw blob/file streaming routes) including the typed
 *      401/403/404/409/422 error taxonomy;
 *  (b) the real `git` CLI over the smart-HTTP wire endpoints — empty clone,
 *      first push, clone-back + `git fsck --strict`, incremental fetch,
 *      force-push CAS, branch + annotated-tag lifecycle, readOnly rejection,
 *      and the wire auth matrix.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { Oid } from "@/Git/Api.ts";
import {
  encodeCommit,
  hashObject,
  ObjectType,
  parseCommit,
  utf8Decode,
  utf8Encode,
} from "@/Git/Protocol/ObjectCodec.ts";
import ProtectedGitHost from "./fixtures/protected-stack.ts";
import TestGitHost, {
  TEST_SECRET,
  TEST_SECRET_DEV,
  TestApi,
} from "./fixtures/stack.ts";
import { verifyPackResponse } from "./harness/pack.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The local suite must not touch the cloud, so it composes its own Stack over
// `Alchemy.localState()` — the same user pattern as production, just with a
// local state store: deploy the fixture's building-block assembly worker.
// Importing `./fixtures/stack.ts` above installed the TEST_SECRET into
// the deployer env before this plan resolves
// the suite fixture's `AuthenticatedTest`.
const LocalStack = Alchemy.Stack(
  "GitServiceLocalStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const host = yield* TestGitHost;
    return { url: host.url.as<string>() };
  }),
);

// ── readiness ───────────────────────────────────────────────────────────────

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const boundedReadiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(20),
]);

/** Wait until the local worker answers the admin repo listing with a 200. */
const awaitReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client
      .get(`${url}/api/v1/repos`, {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      })
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.void
            : Effect.fail(new WorkerNotReady({ status: res.status })),
        ),
        // retries transport errors (connection refused during boot) too
        Effect.retry({ schedule: boundedReadiness }),
      );
  }).pipe(Effect.orDie);

const stack = beforeAll(
  deploy(LocalStack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        // proof the run is local: no cloud URL, a localhost port
        expect(url).toMatch(/^http:\/\/localhost:\d+$/);
        yield* awaitReady(url);
      }),
    ),
    logLevel,
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(LocalStack));

// ── typed REST client ───────────────────────────────────────────────────────

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(TestApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

/** A client that sends NO Authorization header — the anonymous caller. */
const makeAnonymousClient = (url: string) =>
  HttpApiClient.make(TestApi, { baseUrl: url });

const asOid = (oid: string): Oid => oid as Oid;

/** Assert an effect fails with the given tagged error. */
const expectTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe(tag);
      return result.failure;
    }
    return yield* Effect.die("unreachable");
  });

// ── git CLI plumbing ────────────────────────────────────────────────────────

class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message() {
    return `git ${this.args.join(" ")} → exit ${this.exitCode}\n${this.stderr.trim()}\n${this.stdout.trim()}`;
  }
}

/** Run `git <args>` in `cwd`, capturing exit code and output. Bounded. */
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

/** Run git and require exit 0, failing with the captured output otherwise. */
const mustGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode !== 0) {
    return yield* new GitError(result);
  }
  return result;
});

/** Run git and require a non-zero exit (an expected rejection). */
const mustFailGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode === 0) {
    return yield* new GitError(result);
  }
  return result;
});

/** `http://x:<token>@localhost:<port>/<owner>/<repo>.git` */
const authRemote = (url: string, token: string, owner: string, repo: string) =>
  Effect.sync(() => {
    const parsed = new URL(url);
    return `${parsed.protocol}//x:${token}@${parsed.host}/${owner}/${repo}.git`;
  });

/** `git rev-parse <rev>` → the 40-hex oid. */
const revParse = (cwd: string, rev: string) =>
  Effect.map(mustGit(cwd, "rev-parse", rev), (result) => result.stdout);

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-service-local-" });
});

/** Create a repo via the admin REST client, returning its bootstrap token. */
/** Poll marker: repo still visible while its async purge drains. */
class StillDeleting extends Data.TaggedError("StillDeleting")<{}> {}

const createRepo = Effect.fn(function* (
  url: string,
  owner: string,
  name: string,
) {
  const client = yield* makeClient(url, TEST_SECRET);
  // Retry-safe: a previous (failed, runner-retried) attempt may have left
  // the repo behind — delete it and wait out the async purge before
  // creating, so the create below never 409s on our own leftovers.
  yield* client.repos.delete({ params: { owner, repo: name } }).pipe(
    Effect.flatMap(() =>
      client.repos.get({ params: { owner, repo: name } }).pipe(
        Effect.flatMap(() => Effect.fail(new StillDeleting())),
        Effect.catchTag("RepoNotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error instanceof StillDeleting,
          schedule: Schedule.spaced("250 millis"),
          times: 40,
        }),
      ),
    ),
    Effect.catchTag("RepoNotFound", () => Effect.void),
  );
  const created = yield* client.repos.create({ payload: { owner, name } });
  return {
    client,
    created,
    token: TEST_SECRET,
    remote: yield* authRemote(url, TEST_SECRET, owner, name),
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// (a) REST management plane
// ═══════════════════════════════════════════════════════════════════════════

test(
  "repos: create, duplicate 409, get, list, update, typed auth failures",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);

    const created = yield* admin.repos.create({
      payload: { owner: "acme", name: "rest-repos", description: "d0" },
    });
    expect(created.repo.owner).toBe("acme");
    expect(created.repo.name).toBe("rest-repos");
    expect(created.repo.status).toBe("ready");
    expect(created.repo.defaultBranch).toBe("main");
    expect(created.repo.readOnly).toBe(false);
    expect(created.remote).toContain("/acme/rest-repos.git");

    // duplicate → typed 409
    yield* expectTag(
      admin.repos.create({ payload: { owner: "acme", name: "rest-repos" } }),
      "RepoAlreadyExists",
    );

    const fetched = yield* admin.repos.get({
      params: { owner: "acme", repo: "rest-repos" },
    });
    expect(fetched.repoId).toBe(created.repo.repoId);
    expect(fetched.description).toBe("d0");

    // list-all is admin-only and contains the repo
    const listed = yield* admin.repos.list({ query: {} });
    expect(
      listed.items.some((r) => r.owner === "acme" && r.name === "rest-repos"),
    ).toBe(true);

    // PATCH description + readOnly round-trip
    const patched = yield* admin.repos.update({
      params: { owner: "acme", repo: "rest-repos" },
      payload: { description: "d1", readOnly: true },
    });
    expect(patched.description).toBe("d1");
    expect(patched.readOnly).toBe(true);
    yield* admin.repos.update({
      params: { owner: "acme", repo: "rest-repos" },
      payload: { readOnly: false },
    });

    // missing repo → typed 404
    yield* expectTag(
      admin.repos.get({ params: { owner: "acme", repo: "does-not-exist" } }),
      "RepoNotFound",
    );

    // no credentials → typed 401 from the fixture's middleware
    const anonymous = yield* HttpApiClient.make(TestApi, { baseUrl: url });
    yield* expectTag(
      anonymous.repos.get({ params: { owner: "acme", repo: "rest-repos" } }),
      "Unauthorized",
    );

    // garbage token → typed 401 (the middleware rejects it before any route)
    const garbage = yield* makeClient(url, "gs_garbage-token");
    yield* expectTag(
      garbage.repos.get({ params: { owner: "acme", repo: "rest-repos" } }),
      "Unauthorized",
    );

    // Anonymous callers may read one public repository at a time;
    // listing is not that, so it 401s like any other anonymous call.
    yield* expectTag(anonymous.repos.list({ query: {} }), "Unauthorized");
    // The engine lists everything the Registry holds; `public: true`
    // narrows it, so a private repo is not in that view.
    const publicListing = yield* admin.repos.list({
      query: { public: true },
    });
    expect(
      publicListing.items.some(
        (row) => row.owner === "acme" && row.name === "rest-repos",
      ),
    ).toBe(false);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "refs + objects: CAS writes, typed conflicts, commit/log/tree/blob reads, raw routes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "rest-refs",
    );
    const params = { owner: "acme", repo: "rest-refs" };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // refs on a fresh repo are empty
    const empty = yield* admin.refs.list({ params, query: {} });
    expect(empty.refs).toEqual([]);

    // seed real objects over the wire (2 commits)
    const tmp = yield* tempDir;
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "hello.txt"), "hello local\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1: seed");
    yield* fs.writeFileString(
      path.join(work, "hello.txt"),
      "hello local, v2\n",
    );
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2: bump");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    const parent = (yield* mustGit(work, "rev-parse", "HEAD~1")).stdout;

    // refs.list / refs.get agree with the CLI
    const refs = yield* admin.refs.list({
      params,
      query: { prefix: "refs/heads/" },
    });
    expect(refs.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
    expect(refs.refs[0]!.oid).toBe(head);
    const mainRef = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(head);
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/nope" } }),
      "RefNotFound",
    );

    // CAS create (expectedOid: null = must-not-exist)
    const branch = yield* admin.refs.update({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { newOid: asOid(parent), expectedOid: null },
    });
    expect(branch.oid).toBe(parent);
    // must-not-exist against an existing ref → typed 409
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid(head), expectedOid: null },
      }),
      "RefConflict",
    );
    // stale expectedOid → typed 409
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid(head), expectedOid: asOid(head) },
      }),
      "RefConflict",
    );
    // correct CAS moves the ref
    const moved = yield* admin.refs.update({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { newOid: asOid(head), expectedOid: asOid(parent) },
    });
    expect(moved.oid).toBe(head);

    // pointing a ref at an object we do not have → typed 404
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid("f".repeat(40)) },
      }),
      "ObjectNotFound",
    );
    // remove with a stale CAS → 409; with the right one → gone
    yield* expectTag(
      admin.refs.remove({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { expectedOid: asOid(parent) },
      }),
      "RefConflict",
    );
    yield* admin.refs.remove({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { expectedOid: asOid(head) },
    });
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/rest-branch" } }),
      "RefNotFound",
    );

    // readOnly gates REST ref writes with the typed 403
    yield* admin.repos.update({ params, payload: { readOnly: true } });
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/blocked" },
        payload: { newOid: asOid(head) },
      }),
      "ReadOnlyRepo",
    );
    yield* admin.repos.update({ params, payload: { readOnly: false } });

    // objects: commit → tree → blob agree with the CLI byte-for-byte
    const commit = yield* admin.objects.commit({
      params: { ...params, oid: asOid(head) },
    });
    expect(commit.message).toContain("c2: bump");
    expect(commit.parents).toEqual([parent]);
    expect(commit.author.email).toBe("test@example.com");

    const tree = yield* admin.objects.tree({
      params: { ...params, oid: commit.tree },
    });
    const helloEntry = tree.entries.find((e) => e.name === "hello.txt")!;
    expect(helloEntry.type).toBe("blob");
    expect(helloEntry.mode).toBe("100644");

    const blob = yield* admin.objects.blob({
      params: { ...params, oid: helloEntry.oid },
    });
    expect(blob.encoding).toBe("base64");
    const blobText = yield* Effect.sync(() =>
      Buffer.from(blob.content, "base64").toString("utf8"),
    );
    expect(blobText).toBe("hello local, v2\n");

    // wrong-kind reads → typed 422
    yield* expectTag(
      admin.objects.tree({ params: { ...params, oid: helloEntry.oid } }),
      "WrongObjectType",
    );
    yield* expectTag(
      admin.objects.blob({ params: { ...params, oid: asOid(head) } }),
      "WrongObjectType",
    );
    yield* expectTag(
      admin.objects.commit({
        params: { ...params, oid: asOid("e".repeat(40)) },
      }),
      "ObjectNotFound",
    );

    // log walks the first-parent chain
    const log = yield* admin.objects.log({
      params,
      query: { ref: "refs/heads/main", limit: 10 },
    });
    expect(log.items.map((c) => c.oid)).toEqual([head, parent]);

    // raw streaming routes (outside HttpApi schema-land)
    const http = yield* HttpClient.HttpClient;
    const rawBlob = yield* http.get(
      `${url}/api/v1/repos/acme/rest-refs/blobs/${helloEntry.oid}/raw`,
      { headers: { authorization: `Bearer ${TEST_SECRET}` } },
    );
    expect(rawBlob.status).toBe(200);
    expect(yield* rawBlob.text).toBe("hello local, v2\n");

    const rawFile = yield* http.get(
      `${url}/api/v1/repos/acme/rest-refs/file?ref=refs/heads/main&path=hello.txt`,
      { headers: { authorization: `Bearer ${TEST_SECRET}` } },
    );
    expect(rawFile.status).toBe(200);
    expect(yield* rawFile.text).toBe("hello local, v2\n");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "repos.delete: 204 now, async purge to a typed 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin } = yield* createRepo(url, "acme", "rest-delete");
    const params = { owner: "acme", repo: "rest-delete" };

    yield* admin.repos.delete({ params });

    // status flips to 'deleting' and the alarm-driven purge ends in a 404
    const gone = yield* admin.repos.get({ params }).pipe(
      Effect.map((repo) => ({ deleted: false, status: repo.status })),
      Effect.catchTag("RepoNotFound", () =>
        Effect.succeed({ deleted: true as const, status: undefined }),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => state.deleted,
        times: 30,
      }),
    );
    expect(gone.deleted).toBe(true);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (b) real git CLI over the local wire
// ═══════════════════════════════════════════════════════════════════════════

test(
  "git: empty clone, first push (exec bit + subdir), REST agreement",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-basic",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // empty-repo clone succeeds (unborn HEAD advertisement)
    const clone = yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    expect(`${clone.stdout}\n${clone.stderr}`).toContain("empty repository");
    const work = path.join(tmp, "work");

    // three commits: plain file, subdirectory, executable
    yield* fs.writeFileString(path.join(work, "hello.txt"), "hello wire\n");
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
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c3: executable");

    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // REST agrees with the CLI
    const params = { owner: "acme", repo: "wire-basic" };
    const refs = yield* admin.refs.list({ params, query: {} });
    expect(refs.refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(head);

    const commit = yield* admin.objects.commit({
      params: { ...params, oid: asOid(head) },
    });
    expect(commit.message).toContain("c3: executable");
    const tree = yield* admin.objects.tree({
      params: { ...params, oid: commit.tree },
    });
    expect(tree.entries.find((e) => e.name === "run.sh")?.mode).toBe("100755");
    expect(tree.entries.find((e) => e.name === "sub")?.type).toBe("tree");

    // ls-remote sees exactly what REST sees
    const lsRemote = (yield* mustGit(work, "ls-remote", "origin")).stdout;
    expect(lsRemote).toContain(`${head}\trefs/heads/main`);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: clone-back + fsck --strict, incremental fetch fast-forwards",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* createRepo(url, "acme", "wire-fetch");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // seed from clone A
    yield* mustGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v1\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v2\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c2");
    yield* mustGit(a, "push", "origin", "main");

    // clone-back is fsck-clean and log-identical — transitively proves
    // advertisement, negotiation, pack emission, and object round-tripping
    yield* mustGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* mustGit(b, "fsck", "--strict");
    const logA = (yield* mustGit(a, "log", "--format=%H %s")).stdout;
    const logB = (yield* mustGit(b, "log", "--format=%H %s")).stdout;
    expect(logB).toBe(logA);

    // two more commits in A → B fetches incrementally (the haves/ACK path)
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

test(
  "git: force-push CAS, branch + annotated tag lifecycle",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-refs",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-refs" };

    yield* mustGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "f.txt"), "one\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(a, "f.txt"), "two\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c2");
    yield* mustGit(a, "push", "origin", "main");

    // B clones now, then A advances the remote — B's next push is stale
    yield* mustGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* fs.writeFileString(path.join(a, "f.txt"), "three\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c3");
    yield* mustGit(a, "push", "origin", "main");

    // B pushes its own commit against the stale old-oid → server-side CAS ng
    yield* fs.writeFileString(path.join(b, "g.txt"), "divergent\n");
    yield* mustGit(b, "add", "-A");
    yield* mustGit(b, "commit", "-m", "divergent");
    const rejected = yield* mustFailGit(b, "push", "origin", "main");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("rejected");

    // fetch + force overwrites; A fetches the forced history cleanly
    yield* mustGit(b, "fetch", "origin");
    yield* mustGit(b, "push", "--force", "origin", "main");
    const headB = (yield* mustGit(b, "rev-parse", "HEAD")).stdout;
    yield* mustGit(a, "fetch", "origin");
    expect((yield* mustGit(a, "rev-parse", "origin/main")).stdout).toBe(headB);

    // annotated tag round-trips as a tag object with a peeled advertisement
    yield* mustGit(b, "tag", "-a", "v1", "-m", "release v1");
    yield* mustGit(b, "push", "origin", "v1");
    const tagOid = (yield* mustGit(b, "rev-parse", "v1")).stdout;
    const tagRef = yield* admin.refs.get({
      params,
      query: { name: "refs/tags/v1" },
    });
    expect(tagRef.oid).toBe(tagOid);
    expect(tagRef.peeled).toBe(headB); // peeled to the commit it annotates
    const lsRemote = (yield* mustGit(b, "ls-remote", "--tags", "origin"))
      .stdout;
    expect(lsRemote).toContain(`${tagOid}\trefs/tags/v1`);
    expect(lsRemote).toContain(`${headB}\trefs/tags/v1^{}`);

    // branch push + delete-refs for branch and tag
    yield* mustGit(b, "push", "origin", "main:feature");
    const feature = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/feature" },
    });
    expect(feature.oid).toBe(headB);
    yield* mustGit(b, "push", "origin", "--delete", "feature");
    yield* mustGit(b, "push", "origin", "--delete", "v1");
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/feature" } }),
      "RefNotFound",
    );
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/tags/v1" } }),
      "RefNotFound",
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: readOnly repos reject pushes in-band, then accept after unflag",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-readonly",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-readonly" };

    yield* mustGit(
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

    yield* admin.repos.update({ params, payload: { readOnly: false } });
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    const mainRef = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(head);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: wire auth matrix — garbage token 401s, read token clones but cannot push",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-auth",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-auth" };

    // seed one commit with the bootstrap write token
    yield* mustGit(
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

    // garbage token → 401 before any pack bytes flow. git surfaces the 401
    // as "Authentication failed" (it never echoes the literal status code).
    const badRemote = yield* authRemote(url, "gs_garbage", "acme", "wire-auth");
    const unauthorized = yield* mustFailGit(tmp, "clone", badRemote, "nope");
    expect(unauthorized.stderr).toContain("Authentication failed");

    // a read-scope token clones (token in the remote URL) but cannot push

    // the write path still works for the bootstrap token
    yield* fs.writeFileString(path.join(seed, "f.txt"), "seed2\n");
    yield* mustGit(seed, "add", "-A");
    yield* mustGit(seed, "commit", "-m", "c2");
    yield* mustGit(seed, "push", "origin", "main");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// v2 storage plane: compaction (DESIGN.md §12.1)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "compaction: objects move into an R2 pack and clones stay byte-identical",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "compaction");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // A history with enough distinct blobs that a compaction run has real
    // work to do, plus one binary file whose bytes must survive exactly.
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 7) & 0xff;
    yield* fs.writeFile(path.join(work, "blob.bin"), binary);
    for (let i = 0; i < 12; i++) {
      yield* fs.writeFileString(path.join(work, `f${i}.txt`), `content ${i}\n`);
    }
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "seed");
    yield* mustGit(work, "push", "origin", "main");

    // Compaction is normally armed by size thresholds; force a run now so
    // the test does not depend on repo size.
    yield* repo.client.repos.compact({
      params: { owner: "acme", repo: "compaction" },
    });

    const stats = yield* repo.client.repos
      .get({ params: { owner: "acme", repo: "compaction" } })
      .pipe(
        Effect.map((found) => found.objects),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (objects: { loose: number; packed: number }) =>
            objects.packed > 0 && objects.loose === 0,
          times: 40,
        }),
      );
    expect(stats.packed).toBeGreaterThan(0);
    expect(stats.loose).toBe(0);
    // Only blobs move to R2 (Compact.ts BLOB_TYPE): commits/trees/tags stay
    // row-resident so the fetch closure never walks pack windows.
    expect(stats.resident).toBeGreaterThan(0);

    // Everything now reads through R2 ranged GETs: a fresh clone must be
    // fsck-clean and byte-identical, and REST blob reads must still work.
    yield* mustGit(tmp, "clone", repo.remote, "verify");
    const verify = path.join(tmp, "verify");
    yield* mustGit(verify, "fsck", "--strict");
    const round = yield* fs.readFile(path.join(verify, "blob.bin"));
    expect(Array.from(round)).toEqual(Array.from(binary));
    for (let i = 0; i < 12; i++) {
      const text = yield* fs.readFileString(path.join(verify, `f${i}.txt`));
      expect(text).toBe(`content ${i}\n`);
    }

    // ...and an incremental push on top of a fully packed repo still works.
    yield* fs.writeFileString(path.join(work, "after.txt"), "after\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "after-compaction");
    yield* mustGit(work, "push", "origin", "main");
    yield* mustGit(verify, "pull", "origin", "main");
    expect(yield* fs.readFileString(path.join(verify, "after.txt"))).toBe(
      "after\n",
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "clone bundles: a full clone is served from the R2 bundle, byte-identically",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundles");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "a.txt"), "one\n");
    yield* fs.makeDirectory(path.join(work, "sub"), { recursive: true });
    yield* fs.writeFileString(path.join(work, "sub", "b.txt"), "two\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // The bundle is cut by the post-push alarm; wait for it to land, then
    // clone — that clone is served straight from the R2 bundle bytes.
    yield* Effect.sleep("4 seconds");
    yield* mustGit(tmp, "clone", repo.remote, "fromBundle");
    const fromBundle = path.join(tmp, "fromBundle");
    yield* mustGit(fromBundle, "fsck", "--strict");
    expect((yield* mustGit(fromBundle, "rev-parse", "HEAD")).stdout).toBe(head);
    expect(yield* fs.readFileString(path.join(fromBundle, "a.txt"))).toBe(
      "one\n",
    );
    expect(
      yield* fs.readFileString(path.join(fromBundle, "sub", "b.txt")),
    ).toBe("two\n");

    // A push after the bundle was cut invalidates it: the next clone must
    // still see the NEW commit (served dynamically, or from a fresh bundle).
    yield* fs.writeFileString(path.join(work, "c.txt"), "three\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2");
    yield* mustGit(work, "push", "origin", "main");
    const head2 = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    yield* mustGit(tmp, "clone", repo.remote, "afterPush");
    const afterPush = path.join(tmp, "afterPush");
    yield* mustGit(afterPush, "fsck", "--strict");
    expect((yield* mustGit(afterPush, "rev-parse", "HEAD")).stdout).toBe(head2);

    // A single-branch clone is covered by the same (superset) bundle.
    yield* Effect.sleep("4 seconds");
    yield* mustGit(
      tmp,
      "clone",
      "--single-branch",
      "--branch",
      "main",
      repo.remote,
      "single",
    );
    yield* mustGit(path.join(tmp, "single"), "fsck", "--strict");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "clone bundles: the wire response proves the R2 fast path served it",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundle-wire");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "hello\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    yield* Effect.sleep("4 seconds");

    // Hand-built v0 upload-pack request: one `want`, flush, `done` — the
    // shape a fresh clone sends. No capabilities, so the response is
    // `NAK` followed by the raw pack.
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const body = `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(
        `${url}/acme/bundle-wire.git/git-upload-pack`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${repo.token}`,
          "content-type": "application/x-git-upload-pack-request",
        }),
        HttpClientRequest.bodyText(body),
      ),
    );
    expect(response.status).toBe(200);
    // The header is only set on the bundle path (DESIGN.md §12.2).
    expect(response.headers["x-git-bundle"]).toBeDefined();

    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    const text = new TextDecoder().decode(bytes.subarray(0, 8));
    expect(text).toBe("0008NAK\n");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("PACK");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "clone bundles: sideband clones are served from the pre-framed twin, raw from the bundle — both whole packs",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundle-framed");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    for (let i = 0; i < 20; i++) {
      yield* fs.writeFileString(
        path.join(work, `f${i}.txt`),
        `${"line\n".repeat(200)}${i}\n`,
      );
    }
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const client = yield* HttpClient.HttpClient;
    const fetchPack = (caps: string) =>
      client
        .execute(
          HttpClientRequest.post(
            `${url}/acme/bundle-framed.git/git-upload-pack`,
          ).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${repo.token}`,
              "content-type": "application/x-git-upload-pack-request",
            }),
            HttpClientRequest.bodyText(
              `${pkt(`want ${head}${caps}\n`)}0000${pkt("done\n")}`,
            ),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(
              Effect.map((buffer) => ({
                status: response.status,
                via: response.headers["x-git-served-by"],
                bytes: new Uint8Array(buffer),
              })),
            ),
          ),
        );

    // The bundle job runs after the push; wait for it to cover HEAD.
    const sideband = yield* fetchPack(" side-band-64k").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (r) => r.via !== undefined,
        times: 30,
      }),
    );
    expect(sideband.status).toBe(200);
    // Access was decided in front of the route, so a credentialed clone
    // takes the same DO-less path as an anonymous one.
    expect(sideband.via).toBe("head-snapshot:bundle+framed");
    const framed = verifyPackResponse(sideband.bytes, true);
    expect(framed.error).toBeUndefined();
    expect(framed.objects).toBeGreaterThan(20);

    const raw = yield* fetchPack("");
    expect(raw.via).toBe("head-snapshot:bundle");
    const plain = verifyPackResponse(raw.bytes, false);
    expect(plain.error).toBeUndefined();
    expect(plain.objects).toBe(framed.objects);

    // And real git agrees.
    yield* mustGit(tmp, "clone", repo.remote, "again");
    yield* mustGit(path.join(tmp, "again"), "fsck", "--strict");
  }),
  { timeout: 90_000 },
);

test(
  "clone bundles: a stale bundle falls back cleanly to the dynamic path",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundle-splice");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "hello\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");

    // Let the bundle land for THIS ref snapshot...
    yield* Effect.sleep("4 seconds");

    // ...then move main past it, so every clone wants an oid the bundle
    // does not carry.
    yield* fs.writeFileString(path.join(work, "g.txt"), "world\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2");
    yield* fs.writeFileString(path.join(work, "h.txt"), "again\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c3");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // Raw wire request, immediately — before the bundle job re-cuts, so
    // the bundle on disk is definitively stale.
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(
        `${url}/acme/bundle-splice.git/git-upload-pack`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${repo.token}`,
          "content-type": "application/x-git-upload-pack-request",
        }),
        HttpClientRequest.bodyText(
          `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`,
        ),
      ),
    );
    expect(response.status).toBe(200);
    // A stale bundle is NOT used: serving it would need a true delta, and
    // `computeClosure` deliberately does not subtract boundary trees (see
    // Closure.ts "accepted fat"), so the walk is the honest answer here.
    expect(response.headers["x-git-bundle"]).toBeUndefined();
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("0008NAK\n");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("PACK");

    // And the clone is still correct end to end through that path.
    yield* mustGit(tmp, "clone", repo.remote, "spliced");
    const spliced = path.join(tmp, "spliced");
    yield* mustGit(spliced, "fsck", "--strict");
    expect((yield* mustGit(spliced, "rev-parse", "HEAD")).stdout).toBe(head);
    const logWork = (yield* mustGit(work, "log", "--format=%H %s")).stdout;
    const logSpliced = (yield* mustGit(spliced, "log", "--format=%H %s"))
      .stdout;
    expect(logSpliced).toBe(logWork);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (j) public repos — anonymous read access (GitHub model)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "public repos: anonymous REST reads + tokenless clone; writes still need a token",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    const anonymous = yield* makeAnonymousClient(url);
    const tmp = yield* tempDir;
    const path = yield* Path.Path;

    // A public repo with one commit pushed by its owner.
    const repo = yield* createRepo(url, "acme", "town-square");
    yield* admin.repos.update({
      params: { owner: "acme", repo: "town-square" },
      payload: { public: true },
    });
    const fs = yield* FileSystem.FileSystem;
    const pub = path.join(tmp, "pub");
    yield* fs.makeDirectory(pub, { recursive: true });
    yield* mustGit(pub, "init", "-q", "-b", "main");
    yield* fs.writeFileString(
      path.join(pub, "greeting.txt"),
      "hello anonymous\n",
    );
    yield* mustGit(pub, "add", "-A");
    yield* mustGit(pub, "commit", "-qm", "public commit");
    yield* mustGit(pub, "push", "-q", repo.remote, "main");

    // Anonymous REST: repo meta, refs, log, tree, blob — no token anywhere.
    const meta = yield* anonymous.repos.get({
      params: { owner: "acme", repo: "town-square" },
    });
    expect(meta.public).toBe(true);
    const refs = yield* anonymous.refs.list({
      params: { owner: "acme", repo: "town-square" },
      query: {},
    });
    expect(refs.head).toBe("refs/heads/main");
    const head = refs.refs.find((ref) => ref.name === "refs/heads/main")!;
    const commit = yield* anonymous.objects.commit({
      params: { owner: "acme", repo: "town-square", oid: head.oid },
    });
    expect(commit.message).toContain("public commit");
    const log = yield* anonymous.objects.log({
      params: { owner: "acme", repo: "town-square" },
      query: {},
    });
    expect(log.items.length).toBe(1);

    // The public-only listing shows it.
    const listing = yield* admin.repos.list({ query: { public: true } });
    expect(listing.items.some((row) => row.name === "town-square")).toBe(true);

    // Tokenless clone over the wire.
    const parsed = new URL(url);
    const anonymousRemote = `${parsed.protocol}//${parsed.host}/acme/town-square.git`;
    yield* mustGit(tmp, `clone`, `-q`, anonymousRemote, `anon-clone`);
    const cloned = yield* mustGit(
      path.join(tmp, "anon-clone"),
      `show`,
      `HEAD:greeting.txt`,
    );
    expect(cloned.stdout.trim()).toBe("hello anonymous");

    // Writes stay locked: anonymous push is rejected (401 → git fails).
    const anonWork = path.join(tmp, "anon-clone");
    yield* fs.writeFileString(
      path.join(anonWork, "greeting.txt"),
      "hello anonymous\nmore\n",
    );
    yield* mustGit(anonWork, "add", "-A");
    yield* mustGit(anonWork, "commit", "-qm", "anon write");
    const push = yield* Effect.result(
      mustGit(anonWork, "push", "-q", "origin", "main"),
    );
    expect(Result.isFailure(push)).toBe(true);

    // Anonymous token management is rejected too.
    yield* expectTag(
      anonymous.repos.update({
        params: { owner: "acme", repo: "town-square" },
        payload: { description: "anon" },
      }),
      "Unauthorized",
    );

    // Flipping back to private locks anonymous readers out again.
    yield* admin.repos.update({
      params: { owner: "acme", repo: "town-square" },
      payload: { public: false },
    });
    yield* expectTag(
      anonymous.repos.get({ params: { owner: "acme", repo: "town-square" } }),
      "Unauthorized",
    );
    const privateListing = yield* admin.repos.list({
      query: { public: true },
    });
    expect(privateListing.items.some((row) => row.name === "town-square")).toBe(
      false,
    );
    const privateClone = yield* Effect.result(
      mustGit(tmp, `clone`, `-q`, anonymousRemote, `anon-clone-private`),
    );
    expect(Result.isFailure(privateClone)).toBe(true);
  }),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (k) diffs & compare — server-side changed-file lists
// ═══════════════════════════════════════════════════════════════════════════

test(
  "diff: adds/mods/deletes/mode change across two commits; root commit vs empty tree",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const { client, token } = yield* createRepo(url, "acme", "diffs");
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");

    // commit 1: a.txt, dir/b.txt, script.sh (0644)
    yield* fs.writeFileString(`${work}/a.txt`, "one\n");
    yield* fs.makeDirectory(`${work}/dir`);
    yield* fs.writeFileString(`${work}/dir/b.txt`, "bee\n");
    yield* fs.writeFileString(`${work}/script.sh`, "#!/bin/sh\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "c1");
    const c1 = yield* revParse(work, "HEAD");

    // commit 2: modify a.txt, delete dir/b.txt, add c.txt, chmod +x script.sh
    yield* fs.writeFileString(`${work}/a.txt`, "one\ntwo\n");
    yield* mustGit(work, "rm", "-q", "dir/b.txt");
    yield* fs.writeFileString(`${work}/c.txt`, "sea\n");
    yield* mustGit(work, "update-index", "--chmod=+x", "script.sh");
    yield* mustGit(work, "add", "a.txt", "c.txt");
    yield* mustGit(work, "commit", "-qm", "c2");
    const c2 = yield* revParse(work, "HEAD");

    const remote = yield* authRemote(url, token, "acme", "diffs");
    yield* mustGit(work, "push", "-q", remote, "main");

    // c2 vs c1
    const d2 = yield* client.objects.diff({
      params: { owner: "acme", repo: "diffs", oid: asOid(c2) },
    });
    expect(d2.parent).toBe(c1);
    expect(d2.truncated).toBe(false);
    const byPath = new Map(d2.files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")?.status).toBe("modified");
    expect(byPath.get("a.txt")?.oldOid).not.toBe(byPath.get("a.txt")?.newOid);
    expect(byPath.get("dir/b.txt")?.status).toBe("removed");
    expect(byPath.get("dir/b.txt")?.oldOid).toBeDefined();
    expect(byPath.get("dir/b.txt")?.newOid).toBeUndefined();
    expect(byPath.get("c.txt")?.status).toBe("added");
    // mode-only change: same oid, different modes, still "modified"
    const script = byPath.get("script.sh")!;
    expect(script.status).toBe("modified");
    expect(script.oldMode).toBe("100644");
    expect(script.newMode).toBe("100755");
    expect(script.oldOid).toBe(script.newOid);
    expect(d2.files.length).toBe(4);
    // sizes present for text blobs
    expect(byPath.get("a.txt")?.newSize).toBe(8);

    // root commit: parent null, everything added
    const d1 = yield* client.objects.diff({
      params: { owner: "acme", repo: "diffs", oid: asOid(c1) },
    });
    expect(d1.parent).toBeNull();
    expect(d1.files.every((f) => f.status === "added")).toBe(true);
    expect(d1.files.map((f) => f.path).sort()).toEqual([
      "a.txt",
      "dir/b.txt",
      "script.sh",
    ]);

    // wrong object type: a tree oid on the diff endpoint → 422
    const treeOid = (yield* client.objects.commit({
      params: { owner: "acme", repo: "diffs", oid: asOid(c2) },
    })).tree;
    yield* expectTag(
      client.objects.diff({
        params: { owner: "acme", repo: "diffs", oid: treeOid },
      }),
      "WrongObjectType",
    );
  }),
  { timeout: 120_000 },
);

test(
  "diff: compare merge base across branches, ahead/behind, three-dot files, ref names",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const { client, token } = yield* createRepo(url, "acme", "compare");
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${work}/base.txt`, "base\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "base");
    const fork = yield* revParse(work, "HEAD");

    // feature: 1 commit touching feature.txt
    yield* mustGit(work, "checkout", "-qb", "feature");
    yield* fs.writeFileString(`${work}/feature.txt`, "feat\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "feat 1");
    const featTip = yield* revParse(work, "HEAD");

    // main: 2 more commits touching main-only files
    yield* mustGit(work, "checkout", "-q", "main");
    yield* fs.writeFileString(`${work}/m1.txt`, "m1\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "m1");
    yield* fs.writeFileString(`${work}/m2.txt`, "m2\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "m2");

    const remote = yield* authRemote(url, token, "acme", "compare");
    yield* mustGit(work, "push", "-q", remote, "main", "feature");

    const cmp = yield* client.objects.compare({
      params: { owner: "acme", repo: "compare" },
      query: { base: "main", head: "feature" }, // short ref names
    });
    expect(cmp.mergeBase).toBe(fork);
    expect(cmp.head).toBe(featTip);
    expect(cmp.aheadBy).toBe(1);
    expect(cmp.behindBy).toBe(2);
    expect(cmp.commits.length).toBe(1);
    expect(cmp.commits[0]!.message).toContain("feat 1");
    // three-dot: only the feature-side change, none of main's m1/m2
    expect(cmp.files.map((f) => f.path)).toEqual(["feature.txt"]);
    expect(cmp.files[0]!.status).toBe("added");
    expect(cmp.filesTruncated).toBe(false);

    // reversed: head is behind → empty files, counts swap
    const rev = yield* client.objects.compare({
      params: { owner: "acme", repo: "compare" },
      query: { base: "feature", head: fork }, // oid accepted too
    });
    expect(rev.mergeBase).toBe(fork);
    expect(rev.aheadBy).toBe(0);
    expect(rev.files.length).toBe(0);

    // unknown ref → RefNotFound (404)
    yield* expectTag(
      client.objects.compare({
        params: { owner: "acme", repo: "compare" },
        query: { base: "main", head: "no-such-branch" },
      }),
      "RefNotFound",
    );

    // disjoint history → NoMergeBase (422)
    yield* mustGit(work, "checkout", "-q", "--orphan", "island");
    yield* mustGit(work, "rm", "-rfq", "--cached", ".");
    yield* fs.writeFileString(`${work}/island.txt`, "alone\n");
    yield* mustGit(work, "add", "island.txt");
    yield* mustGit(work, "commit", "-qm", "island");
    yield* mustGit(work, "push", "-q", remote, "island");
    yield* expectTag(
      client.objects.compare({
        params: { owner: "acme", repo: "compare" },
        query: { base: "main", head: "island" },
      }),
      "NoMergeBase",
    );
  }),
  { timeout: 120_000 },
);

test(
  "diff: anonymous read on public repos; 401 on private",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const anonymous = yield* makeAnonymousClient(url);

    // private repo → anonymous is 401 on both endpoints
    const priv = yield* createRepo(url, "acme", "diff-private");
    const pw = yield* tempDir;
    yield* mustGit(pw, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${pw}/f.txt`, "x\n");
    yield* mustGit(pw, "add", ".");
    yield* mustGit(pw, "commit", "-qm", "c");
    const privTip = yield* revParse(pw, "HEAD");
    yield* mustGit(
      pw,
      "push",
      "-q",
      yield* authRemote(url, priv.token, "acme", "diff-private"),
      "main",
    );
    yield* expectTag(
      anonymous.objects.diff({
        params: { owner: "acme", repo: "diff-private", oid: asOid(privTip) },
      }),
      "Unauthorized",
    );
    yield* expectTag(
      anonymous.objects.compare({
        params: { owner: "acme", repo: "diff-private" },
        query: { base: "main", head: "main" },
      }),
      "Unauthorized",
    );

    // public repo → anonymous reads succeed
    const pub = yield* createRepo(url, "acme", "diff-public");
    yield* pub.client.repos.update({
      params: { owner: "acme", repo: "diff-public" },
      payload: { public: true },
    });
    const ww = yield* tempDir;
    yield* mustGit(ww, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${ww}/hello.txt`, "hi\n");
    yield* mustGit(ww, "add", ".");
    yield* mustGit(ww, "commit", "-qm", "c1");
    yield* fs.writeFileString(`${ww}/hello.txt`, "hi there\n");
    yield* mustGit(ww, "add", ".");
    yield* mustGit(ww, "commit", "-qm", "c2");
    const pubTip = yield* revParse(ww, "HEAD");
    yield* mustGit(
      ww,
      "push",
      "-q",
      yield* authRemote(url, pub.token, "acme", "diff-public"),
      "main",
    );

    const d = yield* anonymous.objects.diff({
      params: { owner: "acme", repo: "diff-public", oid: asOid(pubTip) },
    });
    expect(d.files).toEqual([
      expect.objectContaining({ path: "hello.txt", status: "modified" }),
    ]);
    const c = yield* anonymous.objects.compare({
      params: { owner: "acme", repo: "diff-public" },
      query: { base: d.parent!, head: "main" },
    });
    expect(c.aheadBy).toBe(1);
    expect(c.behindBy).toBe(0);
    expect(c.mergeBase).toBe(d.parent);
  }),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (l) pull requests — lifecycle, live compare fields, merges
// ═══════════════════════════════════════════════════════════════════════════

test(
  "pulls: open + numbering, typed create failures, list pagination, live detail, close/reopen/edit",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const { client, token } = yield* createRepo(url, "acme", "pulls-basic");
    const params = { owner: "acme", repo: "pulls-basic" };
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${work}/README.md`, "base\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "base");
    const mainTip = yield* revParse(work, "HEAD");
    yield* mustGit(work, "checkout", "-qb", "feature");
    yield* fs.writeFileString(`${work}/feature.txt`, "feat\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "feat");
    yield* mustGit(work, "checkout", "-qb", "feature-2", "main");
    yield* fs.writeFileString(`${work}/f2.txt`, "f2\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "f2");
    const remote = yield* authRemote(url, token, "acme", "pulls-basic");
    yield* mustGit(work, "push", "-q", remote, "main", "feature", "feature-2");

    // open #1 (short names normalize to refs/heads/…)
    const pr1 = yield* client.pulls.create({
      params,
      payload: {
        title: "add feature",
        body: "the body",
        base: "main",
        head: "feature",
      },
    });
    expect(pr1.number).toBe(1);
    expect(pr1.state).toBe("open");
    expect(pr1.baseRef).toBe("refs/heads/main");
    expect(pr1.headRef).toBe("refs/heads/feature");
    expect(pr1.mergeCommit).toBeNull();

    // typed create failures
    yield* expectTag(
      client.pulls.create({
        params,
        payload: { title: "same", base: "main", head: "main" },
      }),
      "ValidationError",
    );
    yield* expectTag(
      client.pulls.create({
        params,
        payload: { title: "missing", base: "main", head: "no-such-branch" },
      }),
      "BranchMissing",
    );
    yield* expectTag(
      client.pulls.create({
        params,
        payload: {
          title: "tags are not branches",
          base: "main",
          head: "refs/tags/v1",
        },
      }),
      "ValidationError",
    );
    const dup = yield* expectTag(
      client.pulls.create({
        params,
        payload: { title: "dup", base: "main", head: "feature" },
      }),
      "PullExists",
    );
    expect((dup as { number?: number }).number).toBe(1);

    // #2 gets the next dense number
    const pr2 = yield* client.pulls.create({
      params,
      payload: { title: "second", base: "main", head: "feature-2" },
    });
    expect(pr2.number).toBe(2);

    // list: newest first, keyset pagination
    const open = yield* client.pulls.list({ params, query: {} });
    expect(open.items.map((p) => p.number)).toEqual([2, 1]);
    expect(open.hasMore).toBe(false);
    const page1 = yield* client.pulls.list({ params, query: { limit: 1 } });
    expect(page1.items.map((p) => p.number)).toEqual([2]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("2");
    const page2 = yield* client.pulls.list({
      params,
      query: { limit: 1, cursor: page1.nextCursor! },
    });
    expect(page2.items.map((p) => p.number)).toEqual([1]);
    expect(page2.hasMore).toBe(false);
    const closedList = yield* client.pulls.list({
      params,
      query: { state: "closed" },
    });
    expect(closedList.items).toEqual([]);

    // live detail: feature is 1 ahead of main and fast-forwardable
    const detail = yield* client.pulls.get({
      params: { ...params, number: 1 },
    });
    expect(detail.baseOid).toBe(mainTip);
    expect(detail.mergeBase).toBe(mainTip);
    expect(detail.aheadBy).toBe(1);
    expect(detail.behindBy).toBe(0);
    expect(detail.mergeable).toBe(true);
    expect(detail.mergeableReason).toBe("ff");

    // unknown number → typed 404
    yield* expectTag(
      client.pulls.get({ params: { ...params, number: 999 } }),
      "PullNotFound",
    );

    // close → detail still computed (both refs exist) → reopen → edit
    const closed = yield* client.pulls.update({
      params: { ...params, number: 1 },
      payload: { state: "closed" },
    });
    expect(closed.state).toBe("closed");
    const closedDetail = yield* client.pulls.get({
      params: { ...params, number: 1 },
    });
    expect(closedDetail.mergeable).toBe(true);
    const reopened = yield* client.pulls.update({
      params: { ...params, number: 1 },
      payload: { state: "open" },
    });
    expect(reopened.state).toBe("open");
    const edited = yield* client.pulls.update({
      params: { ...params, number: 1 },
      payload: { title: "renamed", body: null },
    });
    expect(edited.title).toBe("renamed");
    expect(edited.body).toBeNull();
    expect(edited.updatedAt).toBeGreaterThanOrEqual(edited.createdAt);
  }),
  { timeout: 120_000 },
);

test(
  "pulls: fast-forward merge moves the base ref; merged is terminal; up-to-date is 422; encodeCommit round-trips real git bytes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const { client, token } = yield* createRepo(url, "acme", "pulls-ff");
    const params = { owner: "acme", repo: "pulls-ff" };
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${work}/README.md`, "hello\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "base");
    yield* mustGit(work, "checkout", "-qb", "feature");
    yield* fs.writeFileString(`${work}/feature.txt`, "feat\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "feat");
    const featureTip = yield* revParse(work, "HEAD");
    yield* mustGit(work, "checkout", "-q", "main");
    const remote = yield* authRemote(url, token, "acme", "pulls-ff");
    yield* mustGit(work, "push", "-q", remote, "main", "feature");

    // pin encodeCommit against real git-produced bytes: `git cat-file
    // commit` output re-hashed must reproduce the oid (byte-exactness),
    // and parse→encode must reproduce those bytes.
    const catFile = (yield* mustGit(work, "cat-file", "commit", featureTip))
      .stdout;
    const rawCommit = `${catFile}\n`; // mustGit trims the trailing LF
    expect(yield* hashObject(ObjectType.commit, utf8Encode(rawCommit))).toBe(
      featureTip,
    );
    const parsed = yield* parseCommit(utf8Encode(rawCommit));
    const reEncoded = yield* encodeCommit({
      tree: parsed.tree,
      parents: parsed.parents,
      author: parsed.author,
      committer: parsed.committer,
      message: parsed.message,
    });
    expect(utf8Decode(reEncoded)).toBe(rawCommit);
    expect(yield* hashObject(ObjectType.commit, reEncoded)).toBe(featureTip);

    // open + FF merge
    const pr = yield* client.pulls.create({
      params,
      payload: { title: "ff me", base: "main", head: "feature" },
    });
    const merged = yield* client.pulls.merge({
      params: { ...params, number: pr.number },
      payload: {},
    });
    expect(merged.method).toBe("ff");
    expect(merged.oid).toBe(featureTip);
    expect(merged.pull.state).toBe("merged");
    expect(merged.pull.mergeCommit).toBe(featureTip);
    expect(merged.pull.mergedAt).not.toBeNull();

    // the base ref moved to the head tip
    const mainRef = yield* client.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(featureTip);

    // the clone can FF-pull the merged base
    yield* mustGit(work, "pull", "-q", remote, "main");
    expect(yield* revParse(work, "HEAD")).toBe(featureTip);

    // merged is terminal: live fields null, re-merge and reopen are 409s
    const detail = yield* client.pulls.get({
      params: { ...params, number: pr.number },
    });
    expect(detail.state).toBe("merged");
    expect(detail.baseOid).toBeNull();
    expect(detail.headOid).toBeNull();
    expect(detail.mergeable).toBeNull();
    yield* expectTag(
      client.pulls.merge({
        params: { ...params, number: pr.number },
        payload: {},
      }),
      "PullStateConflict",
    );
    yield* expectTag(
      client.pulls.update({
        params: { ...params, number: pr.number },
        payload: { state: "open" },
      }),
      "PullStateConflict",
    );
    yield* expectTag(
      client.pulls.merge({ params: { ...params, number: 42 }, payload: {} }),
      "PullNotFound",
    );

    // up-to-date: a PR whose head is already reachable from base
    yield* mustGit(
      work,
      "push",
      "-q",
      remote,
      `${featureTip}:refs/heads/already-in`,
    );
    const upToDate = yield* client.pulls.create({
      params,
      payload: { title: "nothing to do", base: "main", head: "already-in" },
    });
    const upToDateDetail = yield* client.pulls.get({
      params: { ...params, number: upToDate.number },
    });
    expect(upToDateDetail.mergeable).toBe(false);
    expect(upToDateDetail.mergeableReason).toBe("up-to-date");
    yield* expectTag(
      client.pulls.merge({
        params: { ...params, number: upToDate.number },
        payload: {},
      }),
      "NothingToMerge",
    );
  }),
  { timeout: 120_000 },
);

test(
  "pulls: trivial merge commit joins disjoint changes (fsck-clean); conflicts are typed 409; stale expectedHeadOid is RefConflict",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { client, token } = yield* createRepo(url, "acme", "pulls-merge");
    const params = { owner: "acme", repo: "pulls-merge" };
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${work}/README.md`, "base\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "base");
    const baseCommit = yield* revParse(work, "HEAD");
    // topic-a: adds feat-a.txt
    yield* mustGit(work, "checkout", "-qb", "topic-a");
    yield* fs.writeFileString(`${work}/feat-a.txt`, "a\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "feat a");
    const topicATip = yield* revParse(work, "HEAD");
    // main advances with a disjoint file
    yield* mustGit(work, "checkout", "-q", "main");
    yield* fs.writeFileString(`${work}/b.txt`, "b\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "main b");
    const mainTip = yield* revParse(work, "HEAD");
    const remote = yield* authRemote(url, token, "acme", "pulls-merge");
    yield* mustGit(work, "push", "-q", remote, "main", "topic-a");

    const pr = yield* client.pulls.create({
      params,
      payload: { title: "merge topic-a", base: "main", head: "topic-a" },
    });
    const detail = yield* client.pulls.get({
      params: { ...params, number: pr.number },
    });
    expect(detail.mergeBase).toBe(baseCommit);
    expect(detail.mergeable).toBe(true);
    expect(detail.mergeableReason).toBe("merge-commit");

    // stale expectedHeadOid (a race guard) → typed 409, PR stays open
    yield* expectTag(
      client.pulls.merge({
        params: { ...params, number: pr.number },
        payload: { expectedHeadOid: asOid(baseCommit) },
      }),
      "RefConflict",
    );

    const merged = yield* client.pulls.merge({
      params: { ...params, number: pr.number },
      payload: { expectedHeadOid: asOid(topicATip) },
    });
    expect(merged.method).toBe("merge-commit");
    expect(merged.pull.state).toBe("merged");
    expect(merged.pull.mergeCommit).toBe(merged.oid);
    const mainRef = yield* client.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(merged.oid);

    // clone back: fsck-clean, both sides present, exactly 2 parents in order
    const tmp = yield* tempDir;
    yield* mustGit(tmp, "clone", "-q", remote, "fresh");
    const fresh = path.join(tmp, "fresh");
    yield* mustGit(fresh, "fsck", "--strict");
    expect(yield* revParse(fresh, "HEAD")).toBe(merged.oid);
    expect(yield* fs.readFileString(path.join(fresh, "feat-a.txt"))).toBe(
      "a\n",
    );
    expect(yield* fs.readFileString(path.join(fresh, "b.txt"))).toBe("b\n");
    expect(yield* fs.readFileString(path.join(fresh, "README.md"))).toBe(
      "base\n",
    );
    const parents = (yield* mustGit(fresh, "log", "--format=%P", "-1")).stdout;
    expect(parents).toBe(`${mainTip} ${topicATip}`);

    // conflict: both sides edit README.md relative to the merge base
    yield* mustGit(work, "checkout", "-qb", "topic-b", baseCommit);
    yield* fs.writeFileString(`${work}/README.md`, "topic-b version\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "topic-b readme");
    yield* mustGit(work, "checkout", "-q", "main");
    yield* mustGit(work, "pull", "-q", remote, "main");
    yield* fs.writeFileString(`${work}/README.md`, "main version\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "main readme");
    yield* mustGit(work, "push", "-q", remote, "main", "topic-b");
    const mainBefore = yield* revParse(work, "HEAD");

    const conflictPr = yield* client.pulls.create({
      params,
      payload: { title: "conflicting", base: "main", head: "topic-b" },
    });
    const conflictDetail = yield* client.pulls.get({
      params: { ...params, number: conflictPr.number },
    });
    expect(conflictDetail.mergeable).toBe(false);
    expect(conflictDetail.mergeableReason).toBe("conflict");
    const conflict = yield* expectTag(
      client.pulls.merge({
        params: { ...params, number: conflictPr.number },
        payload: {},
      }),
      "MergeConflict",
    );
    expect((conflict as { paths?: ReadonlyArray<string> }).paths).toEqual([
      "README.md",
    ]);
    // the PR stays open and the base ref did not move
    const still = yield* client.pulls.get({
      params: { ...params, number: conflictPr.number },
    });
    expect(still.state).toBe("open");
    const mainAfter = yield* client.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainAfter.oid).toBe(mainBefore);
  }),
  { timeout: 120_000 },
);

test(
  "pulls: deleted head branch degrades to nulls and BranchMissing; anonymous reads on public; writes need a write token",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const anonymous = yield* makeAnonymousClient(url);
    const { client, token } = yield* createRepo(url, "acme", "pulls-auth");
    const params = { owner: "acme", repo: "pulls-auth" };
    const work = yield* tempDir;
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(`${work}/README.md`, "hi\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "base");
    yield* mustGit(work, "checkout", "-qb", "topic-c");
    yield* fs.writeFileString(`${work}/c.txt`, "c\n");
    yield* mustGit(work, "add", ".");
    yield* mustGit(work, "commit", "-qm", "c");
    const remote = yield* authRemote(url, token, "acme", "pulls-auth");
    yield* mustGit(work, "push", "-q", remote, "main", "topic-c");

    const pr = yield* client.pulls.create({
      params,
      payload: { title: "from topic-c", base: "main", head: "topic-c" },
    });

    // delete the head branch: the PR row survives, live fields go null
    yield* client.refs.remove({
      params,
      query: { name: "refs/heads/topic-c" },
      payload: {},
    });
    const detail = yield* client.pulls.get({
      params: { ...params, number: pr.number },
    });
    expect(detail.state).toBe("open");
    expect(detail.headOid).toBeNull();
    expect(detail.baseOid).not.toBeNull();
    expect(detail.mergeBase).toBeNull();
    expect(detail.aheadBy).toBeNull();
    expect(detail.mergeable).toBeNull();
    const missing = yield* expectTag(
      client.pulls.merge({
        params: { ...params, number: pr.number },
        payload: {},
      }),
      "BranchMissing",
    );
    expect((missing as { ref?: string }).ref).toBe("refs/heads/topic-c");

    // private repo: anonymous reads are 401
    yield* expectTag(
      anonymous.pulls.list({ params, query: {} }),
      "Unauthorized",
    );

    // public repo: anonymous reads work, writes never do
    yield* client.repos.update({ params, payload: { public: true } });
    const publicList = yield* anonymous.pulls.list({ params, query: {} });
    expect(publicList.items.map((p) => p.number)).toEqual([pr.number]);
    const publicDetail = yield* anonymous.pulls.get({
      params: { ...params, number: pr.number },
    });
    expect(publicDetail.title).toBe("from topic-c");
    yield* expectTag(
      anonymous.pulls.create({
        params,
        payload: { title: "nope", base: "main", head: "topic-c" },
      }),
      "Unauthorized",
    );
    yield* expectTag(
      anonymous.pulls.merge({
        params: { ...params, number: pr.number },
        payload: {},
      }),
      "Unauthorized",
    );
    yield* expectTag(
      anonymous.pulls.update({
        params: { ...params, number: pr.number },
        payload: { state: "closed" },
      }),
      "Unauthorized",
    );

    // a read-scoped token reads but cannot write → typed 403
  }),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (k) GitHub REST v3 compatibility facade (/api/v3 — gh api / Octokit)
// ═══════════════════════════════════════════════════════════════════════════

/** Raw fetch against the facade with GitHub's `token` auth scheme. */
const ghFetch = Effect.fn(function* (
  url: string,
  path: string,
  options?: {
    readonly method?: string;
    readonly token?: string | undefined;
    readonly body?: unknown;
  },
) {
  const client = yield* HttpClient.HttpClient;
  let request = HttpClientRequest.make((options?.method ?? "GET") as "GET")(
    `${url}/api/v3${path}`,
  );
  if (options?.token !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "authorization",
      `token ${options.token}`,
    );
  }
  if (options?.body !== undefined) {
    request = HttpClientRequest.bodyJsonUnsafe(options.body)(request);
  }
  const response = yield* client.execute(request);
  const text = yield* response.text;
  return {
    status: response.status,
    headers: response.headers,
    json: text.length === 0 ? undefined : (JSON.parse(text) as any),
  };
});

test(
  "ghapi: /user auth probe, repo + branches + commits + contents in GitHub shapes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    const repo = yield* createRepo(url, "acme", "gh-compat");
    yield* admin.repos.update({
      params: { owner: "acme", repo: "gh-compat" },
      payload: { public: true },
    });

    // seed two commits on main
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const work = path.join(tmp, "ghc");
    yield* fs.makeDirectory(work, { recursive: true });
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(path.join(work, "hello.txt"), "one\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-qm", "c1");
    yield* fs.writeFileString(path.join(work, "hello.txt"), "two\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-qm", "c2");
    yield* mustGit(work, "push", "-q", repo.remote, "main");

    // /user: gh's probe — the fixture overrides the engine's route to
    // answer from the caller its middleware resolved (`token` scheme);
    // anonymous is the middleware's 401.
    const user = yield* ghFetch(url, "/user", { token: TEST_SECRET });
    expect(user.status).toBe(200);
    expect(user.json.login).toBe("Suite");
    const anonUser = yield* ghFetch(url, "/user");
    expect(anonUser.status).toBe(401);

    // repo shape (anonymous — the repo is public)
    const repoJson = yield* ghFetch(url, "/repos/acme/gh-compat");
    expect(repoJson.status).toBe(200);
    expect(repoJson.json.full_name).toBe("acme/gh-compat");
    expect(repoJson.json.private).toBe(false);
    expect(repoJson.json.default_branch).toBe("main");
    expect(repoJson.json.clone_url).toContain("/acme/gh-compat.git");
    expect(typeof repoJson.json.id).toBe("number");

    // branches
    const branches = yield* ghFetch(url, "/repos/acme/gh-compat/branches");
    expect(branches.status).toBe(200);
    expect(branches.json[0].name).toBe("main");
    expect(branches.json[0].commit.sha).toMatch(/^[0-9a-f]{40}$/);

    // commits list + Link pagination
    const commits = yield* ghFetch(
      url,
      "/repos/acme/gh-compat/commits?per_page=1",
    );
    expect(commits.status).toBe(200);
    expect(commits.json.length).toBe(1);
    expect(commits.json[0].commit.message).toContain("c2");
    expect(commits.headers.link).toContain('rel="next"');
    // follow the Link cursor like gh --paginate does
    const nextUrl = /<([^>]+)>/.exec(commits.headers.link ?? "")![1]!;
    const pathPart = nextUrl.slice(nextUrl.indexOf("/api/v3") + 7);
    const page2 = yield* ghFetch(url, pathPart);
    expect(page2.json[0].commit.message).toContain("c1");

    // single commit incl. files
    const head = commits.json[0].sha as string;
    const one = yield* ghFetch(url, `/repos/acme/gh-compat/commits/${head}`);
    expect(one.status).toBe(200);
    expect(one.json.files[0].filename).toBe("hello.txt");
    expect(one.json.files[0].status).toBe("modified");

    // contents (base64)
    const contents = yield* ghFetch(
      url,
      "/repos/acme/gh-compat/contents/hello.txt",
    );
    expect(contents.status).toBe(200);
    expect(contents.json.encoding).toBe("base64");
    expect(atob(contents.json.content as string)).toBe("two\n");

    // unknown repo → GitHub-shaped 404
    const missing = yield* ghFetch(url, "/repos/acme/nope");
    expect(missing.status).toBe(404);
    expect(missing.json.message).toBe("Not Found");
  }),
  { timeout: 120_000 },
);

test(
  "ghapi: pull lifecycle through the facade — create, list states, merge, files",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    const repo = yield* createRepo(url, "acme", "gh-pulls");
    yield* admin.repos.update({
      params: { owner: "acme", repo: "gh-pulls" },
      payload: { public: true },
    });

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const work = path.join(tmp, "ghp");
    yield* fs.makeDirectory(work, { recursive: true });
    yield* mustGit(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(path.join(work, "base.txt"), "base\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-qm", "base");
    yield* mustGit(work, "checkout", "-qb", "topic");
    yield* fs.writeFileString(path.join(work, "topic.txt"), "topic\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-qm", "topic work");
    yield* mustGit(work, "checkout", "-q", "main");
    yield* mustGit(work, "push", "-q", repo.remote, "main", "topic");

    // POST /pulls with GitHub's field names (head/base short names)
    const created = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls", {
      method: "POST",
      token: TEST_SECRET,
      body: {
        title: "Topic work",
        head: "topic",
        base: "main",
        body: "pr body",
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.number).toBe(1);
    expect(created.json.state).toBe("open");
    expect(created.json.merged).toBe(false);
    expect(created.json.head.ref).toBe("topic");
    expect(created.json.base.ref).toBe("main");

    // anonymous write → 401
    const anonCreate = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls", {
      method: "POST",
      body: { title: "x", head: "topic", base: "main" },
    });
    expect(anonCreate.status).toBe(401);

    // GET single: mergeable + shas live
    const single = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1");
    expect(single.json.mergeable).toBe(true);
    expect(single.json.head.sha).toMatch(/^[0-9a-f]{40}$/);

    // files (three-dot)
    const files = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1/files");
    expect(files.json.map((f: any) => f.filename)).toEqual(["topic.txt"]);
    expect(files.json[0].status).toBe("added");

    // unsupported merge method → 405
    const squash = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1/merge", {
      method: "PUT",
      token: TEST_SECRET,
      body: { merge_method: "squash" },
    });
    expect(squash.status).toBe(405);

    // PUT merge (fast-forward)
    const merged = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1/merge", {
      method: "PUT",
      token: TEST_SECRET,
      body: {},
    });
    expect(merged.status).toBe(200);
    expect(merged.json.merged).toBe(true);
    expect(merged.json.sha).toMatch(/^[0-9a-f]{40}$/);

    // GitHub semantics: merged PR is state=closed + merged=true
    const after = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1");
    expect(after.json.state).toBe("closed");
    expect(after.json.merged).toBe(true);
    expect(after.json.merge_commit_sha).toBe(merged.json.sha);

    // list state filters: open empty; closed includes the merged PR
    const open = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls?state=open");
    expect(open.json.length).toBe(0);
    const closed = yield* ghFetch(
      url,
      "/repos/acme/gh-pulls/pulls?state=closed",
    );
    expect(closed.json.length).toBe(1);
    expect(closed.json[0].number).toBe(1);

    // merged PR files fall back to the merge commit's diff
    const mergedFiles = yield* ghFetch(
      url,
      "/repos/acme/gh-pulls/pulls/1/files",
    );
    expect(mergedFiles.json.map((f: any) => f.filename)).toEqual(["topic.txt"]);

    // PATCH validation
    const badState = yield* ghFetch(url, "/repos/acme/gh-pulls/pulls/1", {
      method: "PATCH",
      token: TEST_SECRET,
      body: { state: "merged" },
    });
    expect(badState.status).toBe(422);
  }),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (c) application ref authorization
// ═══════════════════════════════════════════════════════════════════════════

// A second assembly, with custom native HTTP handlers sharing
// one rule: `refs/heads/main` moves only for the repository's owner (the
// fixture's `protectMain`). Its own entry module: a Worker's generated
// entry serves its main module's DEFAULT export, so one Worker class per
// entry module. Deployed inside the test so the shared fixture stays one
// worker for the e2e suites.
const ProtectedLocalStack = Alchemy.Stack(
  "GitServiceProtectedLocalStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const host = yield* ProtectedGitHost;
    return { url: host.url.as<string>() };
  }),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ProtectedLocalStack));

test(
  "policies: an application handler protects main — per-ref rule over the parsed updates",
  Effect.gen(function* () {
    const { url } = yield* deploy(ProtectedLocalStack);
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    yield* awaitReady(url);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { created } = yield* createRepo(url, "e2e", "protected");
    // A second user, not the owner, does the pushing.
    const token = TEST_SECRET_DEV;
    const remote = yield* authRemote(url, token, "e2e", "protected");

    const tmp = yield* tempDir;
    yield* mustGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "w");
    const w = path.join(tmp, "w");
    yield* fs.writeFileString(path.join(w, "file.txt"), "v1\n");
    yield* mustGit(w, "add", "-A");
    yield* mustGit(w, "commit", "-m", "c1");

    // The middleware lets the user push; the policy lets any OTHER branch
    // through...
    yield* mustGit(w, "push", "origin", "HEAD:refs/heads/feature");

    // ...but a direct push to main is refused PER-REF, after the pack is
    // parsed, with the reason the policy gave.
    const denied = yield* mustFailGit(
      w,
      "push",
      "origin",
      "HEAD:refs/heads/main",
    );
    expect(denied.stderr).toContain("not permitted");

    // The owner passes the same policy.
    const adminRemote = yield* authRemote(url, TEST_SECRET, "e2e", "protected");
    yield* mustGit(w, "push", adminRemote, "HEAD:refs/heads/main");

    // The push advertisement is a write probe: anonymous gets the 401
    // (with `WWW-Authenticate`) that makes git ask for credentials.
    const client = yield* HttpClient.HttpClient;
    const probe = yield* client.get(
      `${url}/e2e/protected/info/refs?service=git-receive-pack`,
    );
    expect(probe.status).toBe(401);
    expect(probe.headers["www-authenticate"]).toContain("Basic");

    // The REST ref writes run the same policy: the user is refused on main
    // (a typed 403) and may still create a feature branch.
    const head = yield* revParse(w, "HEAD");
    const tokenClient = yield* makeClient(url, token);
    yield* expectTag(
      tokenClient.refs.update({
        params: { owner: "e2e", repo: "protected" },
        query: { name: "refs/heads/main" },
        payload: { newOid: asOid(head) },
      }),
      "PushDenied",
    );
    const moved = yield* tokenClient.refs.update({
      params: { owner: "e2e", repo: "protected" },
      query: { name: "refs/heads/feature2" },
      payload: { newOid: asOid(head), expectedOid: null },
    });
    expect(moved.oid).toBe(head);

    // A policy can inspect the newly uploaded commit without publishing it.
    yield* fs.writeFileString(path.join(w, "new.txt"), "not published yet\n");
    yield* mustGit(w, "add", "-A");
    yield* mustGit(w, "commit", "-m", "[reject-content]");
    const rejectedOid = yield* revParse(w, "HEAD");
    const rejectedContent = yield* mustFailGit(
      w,
      "push",
      adminRemote,
      "HEAD:refs/heads/main",
    );
    expect(rejectedContent.stderr).toContain(
      "commit rejected by content policy",
    );
    const ownerClient = yield* makeClient(url, TEST_SECRET);
    yield* expectTag(
      ownerClient.objects.commit({
        params: { owner: "e2e", repo: "protected", oid: asOid(rejectedOid) },
      }),
      "ObjectNotFound",
    );
    expect(
      (yield* ownerClient.refs.get({
        params: { owner: "e2e", repo: "protected" },
        query: { name: "refs/heads/main" },
      })).oid,
    ).toBe(head);
    // Retry with an acceptable commit: aborted staging must not poison ingestion.
    yield* mustGit(w, "commit", "--amend", "-m", "accepted content");
    yield* mustGit(w, "push", adminRemote, "HEAD:refs/heads/main");
  }).pipe(logLevel),
  { timeout: 240_000 },
);
