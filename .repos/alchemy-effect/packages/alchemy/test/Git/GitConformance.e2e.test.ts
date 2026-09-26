/**
 * Conformance workout — the real `git` CLI driven through the SHELL against
 * a deployed git-service stack.
 *
 * There is no official conformance suite for git servers; the de-facto
 * oracle is the git client itself plus its strict integrity checkers. This
 * suite therefore treats conformance as: every everyday workflow a
 * developer throws at a remote — clone, push, rebase, amend, merge,
 * cherry-pick, revert, tags (both kinds), branch churn, prune, atomic
 * multi-ref pushes, client-side gc — round-trips against the deployed
 * service with `git fsck --strict` clean at every checkpoint, and the REST
 * plane (token flow, refs) agrees with what the wire reports.
 *
 * Each phase is a literal `sh -c` script (bounded by a hard timeout), so a
 * failure prints the exact shell block + stderr that broke.
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

const Stack = makeTestStack("GitConformanceStack");

// ── REST plumbing ───────────────────────────────────────────────────────────

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

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
  const parsed = new URL(url);
  return {
    admin,
    created,
    token: TEST_SECRET,
    host: parsed.host,
    remoteFor: (token: string) =>
      `${parsed.protocol}//x:${token}@${parsed.host}/${owner}/${name}.git`,
    remote: `${parsed.protocol}//x:${TEST_SECRET}@${parsed.host}/${owner}/${name}.git`,
  };
});

// ── shell plumbing ──────────────────────────────────────────────────────────

class ShellError extends Data.TaggedError("ShellError")<{
  readonly script: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return `shell script exited ${this.exitCode}\n--- script ---\n${this.script}\n--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`;
  }
}

/**
 * Runs one bounded `sh -c` script with hermetic git identity/config. The
 * script's cwd is the given work dir; `set -eu` makes any failing command
 * fail the whole block.
 */
const sh = Effect.fn(function* (cwd: string, script: string) {
  const handle = yield* ChildProcess.make("sh", ["-ec", script], {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Conformance Bot",
      GIT_AUTHOR_EMAIL: "conformance@example.com",
      GIT_COMMITTER_NAME: "Conformance Bot",
      GIT_COMMITTER_EMAIL: "conformance@example.com",
      // deterministic commit timestamps make re-runs reproducible
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
}, Effect.timeout("90 seconds"));

/** Runs the script; non-zero exit is a typed failure carrying all output. */
const mustSh = Effect.fn(function* (cwd: string, script: string) {
  const result = yield* sh(cwd, script);
  if (result.exitCode !== 0) {
    return yield* new ShellError(result);
  }
  return result;
});

/** Runs the script; a ZERO exit is the failure (expected-to-fail blocks). */
const mustFailSh = Effect.fn(function* (cwd: string, script: string) {
  const result = yield* sh(cwd, script);
  if (result.exitCode === 0) {
    return yield* new ShellError(result);
  }
  return result;
});

/** First-contact clone with bounded retries through edge propagation. */
const retrySh = (cwd: string, script: string) =>
  mustSh(cwd, script).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "ShellError" || error._tag === "TimeoutError",
      schedule: Schedule.spaced("3 seconds"),
      times: 5,
    }),
  );

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-conformance-" });
});

// ── stack ───────────────────────────────────────────────────────────────────

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
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack).pipe(logLevel));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Token flow: bootstrap → scoped tokens → revocation, end to end
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 2. History surgery: rebase, amend, merge, cherry-pick, revert, force-push
// ═══════════════════════════════════════════════════════════════════════════

test(
  "history surgery: rebase + amend + merge --no-ff + cherry-pick + revert round-trip",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "conf", "surgery");
    const tmp = yield* tempDir;

    yield* retrySh(
      tmp,
      `
      rm -rf work
      git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      echo base > base.txt
      git add -A && git commit -m base
      git push origin main
      `,
    );

    // build a feature branch, advance main underneath it, rebase, force-push
    yield* mustSh(
      tmp,
      `
      cd work
      git checkout -b feature
      echo f1 > f1.txt && git add -A && git commit -m feat-1
      echo f2 > f2.txt && git add -A && git commit -m feat-2
      git push origin feature

      git checkout main
      echo m1 > m1.txt && git add -A && git commit -m main-1
      git push origin main

      git checkout feature
      git rebase main
      git push --force origin feature
      `,
    );

    // amend the feature tip and force-push again
    yield* mustSh(
      tmp,
      `
      cd work
      git checkout feature
      echo f2-amended > f2.txt
      git add -A && git commit --amend -m feat-2-amended
      git push --force origin feature
      `,
    );

    // merge --no-ff (a real merge commit), then cherry-pick + revert on main
    yield* mustSh(
      tmp,
      `
      cd work
      git checkout main
      git merge --no-ff feature -m merge-feature
      echo hot > hotfix.txt && git add -A && git commit -m hotfix
      git revert --no-edit HEAD
      git push origin main

      git checkout -b picks main~2
      git cherry-pick $(git rev-parse main~1)
      git push origin picks
      `,
    );

    // conformance oracle: a fresh clone is fsck-clean and histories agree
    const check = yield* mustSh(
      tmp,
      `
      git clone '${repo.remote}' verify
      cd verify
      git fsck --strict
      git fetch origin '+refs/heads/*:refs/remotes/origin/*'
      git rev-parse origin/main origin/feature origin/picks >/dev/null
      git log --format=%s origin/main | tr '\\n' ' '
      `,
    );
    expect(check.stdout).toContain("merge-feature");
    expect(check.stdout).toContain("Revert");

    // REST agrees with the wire: refs list carries all three branches
    const refs = yield* repo.admin.refs.list({
      params: { owner: "conf", repo: "surgery" },
      query: { prefix: "refs/heads/" },
    });
    expect(refs.refs.map((ref) => ref.name).sort()).toEqual([
      "refs/heads/feature",
      "refs/heads/main",
      "refs/heads/picks",
    ]);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Branch/tag churn: both tag kinds, deletes, prune, atomic multi-ref
// ═══════════════════════════════════════════════════════════════════════════

test(
  "branch/tag churn: annotated + lightweight tags, deletes, fetch --prune, --atomic",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "conf", "churn");
    const tmp = yield* tempDir;

    yield* retrySh(
      tmp,
      `
      rm -rf a
      git -c init.defaultBranch=main clone '${repo.remote}' a
      cd a
      echo one > f.txt && git add -A && git commit -m c1
      git push origin main
      `,
    );

    // one annotated + one lightweight tag; both round-trip with types intact
    yield* mustSh(
      tmp,
      `
      cd a
      git tag -a v1.0.0 -m 'release v1'
      git tag lightweight
      git push origin v1.0.0 lightweight
      `,
    );
    const tagTypes = yield* mustSh(
      tmp,
      `
      git clone '${repo.remote}' b
      cd b
      git fetch --tags origin
      printf '%s %s' $(git cat-file -t v1.0.0^{}) $(git cat-file -t $(git rev-parse v1.0.0))
      `,
    );
    // peeled target is a commit; the annotated ref itself is a tag object
    expect(tagTypes.stdout).toBe("commit tag");

    // atomic multi-ref push: two branches land together
    yield* mustSh(
      tmp,
      `
      cd a
      git branch side1 && git branch side2
      git push --atomic origin side1 side2
      `,
    );

    // remote deletes; a pruning fetch in clone b drops them
    yield* mustSh(
      tmp,
      `
      cd a
      git push --delete origin side1 side2 lightweight v1.0.0
      `,
    );
    const pruned = yield* mustSh(
      tmp,
      `
      cd b
      git fetch --prune origin
      git fetch --prune --prune-tags origin '+refs/tags/*:refs/tags/*'
      git for-each-ref refs/remotes/origin refs/tags | wc -l
      `,
    );
    // only origin/main (HEAD alias may or may not be present; count real refs)
    expect(Number(pruned.stdout.trim())).toBeLessThanOrEqual(2);

    // REST agrees: only main remains
    const refs = yield* repo.admin.refs.list({
      params: { owner: "conf", repo: "churn" },
      query: {},
    });
    expect(refs.refs.map((ref) => ref.name)).toEqual(["refs/heads/main"]);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Client gc / repack interop + odd paths (unicode, exec bit, binary)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "client gc interop: aggressive repack then push; unicode/exec/binary survive byte-identically",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* freshRepo(url, "conf", "gc-interop");
    const tmp = yield* tempDir;

    // odd content: unicode filename, executable, raw bytes incl. NUL
    yield* retrySh(
      tmp,
      `
      rm -rf work
      git -c init.defaultBranch=main clone '${repo.remote}' work
      cd work
      printf 'こんにちは' > 'naïve-файл.txt'
      printf '#!/bin/sh\\necho ok\\n' > run.sh && chmod +x run.sh
      head -c 4096 /dev/zero | tr '\\0' '\\377' > solid.bin
      printf 'a\\0b\\0c' > nul.bin
      git add -A && git commit -m odd-paths
      git push origin main
      `,
    );

    // grow some history, aggressively gc the client (max delta chains),
    // then keep pushing — thin packs now delta against gc'd bases
    yield* mustSh(
      tmp,
      `
      cd work
      i=1
      while [ $i -le 30 ]; do
        printf 'line %s\\n' $i >> grow.txt
        git add grow.txt && git commit -q -m grow-$i
        i=$((i+1))
      done
      git gc --aggressive --prune=now
      git push origin main

      echo after-gc >> grow.txt
      git add grow.txt && git commit -q -m after-gc
      git push origin main
      `,
    );

    // oracle: fresh clone, strict fsck, and every odd file byte-identical
    const verify = yield* mustSh(
      tmp,
      `
      git clone '${repo.remote}' verify
      cd verify
      git fsck --strict
      cmp 'naïve-файл.txt' '../work/naïve-файл.txt'
      cmp run.sh ../work/run.sh
      cmp solid.bin ../work/solid.bin
      cmp nul.bin ../work/nul.bin
      test -x run.sh
      git log --oneline | wc -l
      `,
    );
    expect(Number(verify.stdout.trim())).toBe(32);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
