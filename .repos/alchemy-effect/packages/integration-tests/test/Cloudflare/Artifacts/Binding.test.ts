import * as Cloudflare from "@alchemy.run/cloudflare";
import type {
  CommitMetadata,
  TreeEntry,
} from "@alchemy.run/cloudflare/Artifacts/ReadWriteNamespace";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "./fixtures/stack.ts";

/**
 * Artifacts ("Git for agents") is a beta product whose native Worker binding +
 * implicit-namespace REST surface require the account to be onboarded to the
 * beta. The standing test account IS entitled, so this suite runs live by
 * default (verified green: deploy → create/list/get/delete round-trip → destroy
 * for both the effect-native and async invocation styles).
 *
 * If an account is NOT onboarded, repo creation is rejected at runtime; set
 * `CLOUDFLARE_TEST_ARTIFACTS=0` to skip the entire suite skip-clean on such an
 * account.
 */
const ARTIFACTS_ENABLED = process.env.CLOUDFLARE_TEST_ARTIFACTS !== "0";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
// Must cover the ~150s `ready` readiness budget plus the round-trip itself.
const TEST_TIMEOUT = 240_000;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {
  override get message() {
    return `status=${this.status} body=${this.body.slice(0, 500)}`;
  }
}

// Bounded spaced schedule — caps total cold-start wait so a real failure
// surfaces fast instead of riding to the test timeout. ~150s: fresh
// workers.dev URLs 404 well past a minute under full-suite deploy load.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(75)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new WorkerNotReady({ status: res.status, body }))),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

const body = <T>(res: HttpClientResponse.HttpClientResponse) =>
  res.json.pipe(Effect.map((b) => b as T));

const createRepo = (base: string, name: string) =>
  untilOk(
    HttpClient.execute(HttpClientRequest.post(`${base}/create?name=${encodeURIComponent(name)}`)),
  ).pipe(
    Effect.flatMap(
      body<{
        name: string;
        remote: string;
        defaultBranch: string;
        hasToken: boolean;
      }>,
    ),
  );

const listRepos = (base: string) =>
  untilOk(HttpClient.get(`${base}/list`)).pipe(
    Effect.flatMap(body<{ names: string[]; total: number }>),
  );

const getRepo = (base: string, name: string) =>
  untilOk(HttpClient.get(`${base}/get?name=${encodeURIComponent(name)}`)).pipe(
    Effect.flatMap(body<{ found: boolean }>),
  );

const deleteRepo = (base: string, name: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(`${base}/delete?name=${encodeURIComponent(name)}`),
    ),
  ).pipe(Effect.flatMap(body<{ deleted: boolean }>));

/**
 * Drive the full client surface over one worker base URL: create a repo,
 * confirm it shows up in `list` and `get`, then `delete` it and confirm it is
 * gone. `label` namespaces the repo so the two style-runs stay independent
 * against the one shared namespace.
 */
const exercise = (label: string, base: string) =>
  Effect.gen(function* () {
    const repo = `${label}-repo`;

    // Pre-clean: an interrupted earlier run can leave the deterministic
    // repo behind (Artifacts repos live outside the account nuke's view),
    // and a leaked repo makes create fail "already exists" forever after.
    // getRepo also rides out worker cold-start via its readiness retry.
    if ((yield* getRepo(base, repo)).found) {
      yield* deleteRepo(base, repo);
    }

    const created = yield* createRepo(base, repo);
    expect(created.name).toBe(repo);
    expect(created.defaultBranch).toBe("main");
    expect(created.remote).toContain("https://");
    expect(created.hasToken).toBe(true);

    const listed = yield* listRepos(base);
    expect(listed.names).toContain(repo);

    expect((yield* getRepo(base, repo)).found).toBe(true);

    expect((yield* deleteRepo(base, repo)).deleted).toBe(true);
    expect((yield* getRepo(base, repo)).found).toBe(false);
  });

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** GET a read-worker route, riding out cold starts and in-progress imports. */
const read = <T>(base: string, path: string, params: Record<string, string>) =>
  untilOk(HttpClient.get(`${base}${path}?${query(params)}`)).pipe(Effect.flatMap(body<T>));

/** POST a write route on the Effect-native worker. */
const write = <T>(base: string, path: string, params: Record<string, string>) =>
  untilOk(HttpClient.execute(HttpClientRequest.post(`${base}${path}?${query(params)}`))).pipe(
    Effect.flatMap(body<T>),
  );

/** Delete `repo` if an interrupted earlier run left it behind. */
const preClean = (base: string, repo: string) =>
  Effect.gen(function* () {
    if ((yield* getRepo(base, repo)).found) {
      yield* deleteRepo(base, repo);
    }
  });

class GitFailed extends Data.TaggedError("GitFailed")<{
  command: string;
  stderr: string;
}> {
  override get message() {
    return `git ${this.command} failed: ${this.stderr}`;
  }
}

/**
 * Run `git` in `cwd`. The auth header travels through `GIT_CONFIG_*` env vars
 * rather than argv, so a failure message never carries the token.
 */
const git = (cwd: string, args: string[], token?: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const proc = yield* ChildProcess.make("git", args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      extendEnv: true,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Alchemy Test",
        GIT_AUTHOR_EMAIL: "test@alchemy.run",
        GIT_COMMITTER_NAME: "Alchemy Test",
        GIT_COMMITTER_EMAIL: "test@alchemy.run",
        ...(token
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraHeader",
              GIT_CONFIG_VALUE_0: Redacted.make(`Authorization: Bearer ${Redacted.value(token)}`),
            }
          : {}),
      },
    });
    const [stderr, code] = yield* Effect.all(
      [proc.stderr.pipe(Stream.decodeText(), Stream.mkString), proc.exitCode],
      { concurrency: "unbounded" },
    );
    if (code !== 0) {
      return yield* new GitFailed({ command: args[0]!, stderr });
    }
  }).pipe(Effect.scoped);

// `beforeAll` has no `.skipIf`, so the deploy is gated inside the effect: when
// the Artifacts beta flag is unset, skip the (entitlement-blocked) deploy and
// return empty URLs. The tests below are `skipIf`-gated on the same flag, so
// they never read these placeholder URLs.
const stack = beforeAll(
  ARTIFACTS_ENABLED
    ? deploy(Stack)
    : Effect.succeed({ effectWorkerUrl: "", asyncWorkerUrl: "", readWorkerUrl: "" }),
  { timeout: HOOK_TIMEOUT },
);
afterAll.skipIf(!ARTIFACTS_ENABLED || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// Effect-native worker: `Cloudflare.Artifacts.ReadWriteNamespace(Repos)` + `ReadWriteNamespaceBinding`.
test.skipIf(!ARTIFACTS_ENABLED)(
  "effect binding: create / list / get / delete round-trip",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("effect", out.effectWorkerUrl);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// Async worker: namespace declared on `env: { REPOS }`, used from plain async fetch.
test.skipIf(!ARTIFACTS_ENABLED)(
  "async binding: create / list / get / delete round-trip",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("async", out.asyncWorkerUrl);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// Read-only worker: `Cloudflare.Artifacts.ReadNamespace(Repos)` over a repo
// imported from a public GitHub remote.
test.skipIf(!ARTIFACTS_ENABLED)(
  "read binding: reads an imported repo's history and files",
  Effect.gen(function* () {
    const out = yield* stack;
    const repo = "hello-world-import";
    yield* preClean(out.effectWorkerUrl, repo);

    yield* write(out.effectWorkerUrl, "/import", {
      name: repo,
      url: "https://github.com/octocat/Hello-World",
      branch: "master",
    });

    // `get` fails with IMPORT_IN_PROGRESS until the import lands; `read`
    // retries the 500 that route returns.
    const info = yield* read<{ name: string; defaultBranch: string }>(out.readWorkerUrl, "/info", {
      name: repo,
    });
    expect(info.name).toBe(repo);

    // An imported repo keeps reporting `defaultBranch: "main"` even when the
    // imported branch is `master`, so walk the branch that was imported.
    const commits = yield* read<CommitMetadata[]>(out.readWorkerUrl, "/log", {
      name: repo,
      ref: "master",
      limit: "1",
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);

    const readme = yield* read<{ text: string } | null>(out.readWorkerUrl, "/read-file", {
      name: repo,
      ref: commits[0]!.hash,
      path: "README",
    });
    expect(readme?.text).toContain("Hello World");

    expect((yield* deleteRepo(out.effectWorkerUrl, repo)).deleted).toBe(true);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// Read-only worker over commits pushed with `git` and a write token minted
// through the read-write binding.
test.skipIf(!ARTIFACTS_ENABLED)(
  "read binding: walks commits, trees and blobs pushed over git",
  Effect.gen(function* () {
    const out = yield* stack;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = "pushed-repo";
    yield* preClean(out.effectWorkerUrl, repo);
    yield* createRepo(out.effectWorkerUrl, repo);

    const token = yield* write<{ id: string; plaintext: string; remote: string }>(
      out.effectWorkerUrl,
      "/token",
      { name: repo, scope: "write" },
    );

    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-artifacts-" });
    const dataPath = path.join(dir, "data.json");
    yield* git(dir, ["init", "-b", "main"]);
    yield* fs.writeFileString(path.join(dir, "README.md"), "# pushed\n");
    yield* fs.writeFileString(dataPath, `{"v":1}`);
    yield* git(dir, ["add", "-A"]);
    yield* git(dir, ["commit", "-m", "first"]);
    yield* fs.writeFileString(dataPath, `{"v":2}`);
    yield* git(dir, ["commit", "-am", "second"]);
    yield* git(dir, ["push", token.remote, "HEAD:main"], Redacted.make(token.plaintext));

    const commits = yield* read<CommitMetadata[]>(out.readWorkerUrl, "/log", {
      name: repo,
      ref: "main",
      limit: "10",
    });
    expect(commits.map((c) => c.message)).toEqual(["second", "first"]);
    const [head, previous] = commits as [CommitMetadata, CommitMetadata];
    expect(head.parents).toEqual([previous.hash]);
    expect(head.author.email).toBe("test@alchemy.run");

    const commit = yield* read<CommitMetadata | null>(out.readWorkerUrl, "/read-commit", {
      name: repo,
      hash: head.hash,
    });
    expect(commit?.treeHash).toBe(head.treeHash);

    const tree = yield* read<TreeEntry[] | null>(out.readWorkerUrl, "/read-tree", {
      name: repo,
      hash: head.treeHash,
    });
    expect(tree?.map((e) => e.name).sort()).toEqual(["README.md", "data.json"]);
    const data = tree!.find((e) => e.name === "data.json")!;
    expect(data.type).toBe("blob");

    const blob = yield* read<{ text: string } | null>(out.readWorkerUrl, "/read-blob", {
      name: repo,
      hash: data.hash,
    });
    expect(blob?.text).toBe(`{"v":2}`);

    const older = yield* read<{ text: string } | null>(out.readWorkerUrl, "/read-file", {
      name: repo,
      ref: previous.hash,
      path: "data.json",
    });
    expect(older?.text).toBe(`{"v":1}`);

    const missing = yield* read<{ text: string } | null>(out.readWorkerUrl, "/read-file", {
      name: repo,
      ref: "main",
      path: "missing.txt",
    });
    expect(missing).toBeNull();

    const revoked = yield* write<{ revoked: boolean }>(out.effectWorkerUrl, "/revoke", {
      name: repo,
      id: token.id,
    });
    expect(revoked.revoked).toBe(true);

    expect((yield* deleteRepo(out.effectWorkerUrl, repo)).deleted).toBe(true);
    const gone = yield* read<{ found: boolean; code?: string }>(out.readWorkerUrl, "/get", {
      name: repo,
    });
    expect(gone).toEqual({ found: false, code: "NOT_FOUND" });
  }).pipe(Effect.scoped, logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);
