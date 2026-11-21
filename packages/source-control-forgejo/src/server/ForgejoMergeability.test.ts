import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const REMOTE_URL = "https://forgejo.test/maria/project.git";

it.effect(
  "tells a Forgejo conflict from a pending check by merging the pull request's commits locally",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { process } = yield* SourceControlHost.SourceControlHost;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fj-mergeability-" });
      const forge = path.join(root, "forge");
      const cwd = path.join(root, "checkout");
      const git = (dir: string, ...args: string[]) =>
        process
          .run({ operation: "test.setup", command: "git", cwd: dir, args })
          .pipe(Effect.map((output) => output.stdout.trim()));
      const commit = Effect.fn("commit")(function* (file: string, text: string) {
        yield* fs.writeFileString(path.join(forge, file), text);
        yield* git(forge, "add", file);
        yield* git(forge, "commit", "-m", `${file}: ${text.trim()}`);
        return yield* git(forge, "rev-parse", "HEAD");
      });

      yield* fs.makeDirectory(forge);
      yield* git(forge, "init", "-b", "main");
      yield* git(forge, "config", "user.name", "Test");
      yield* git(forge, "config", "user.email", "test@example.com");
      const start = yield* commit("shared.txt", "start\n");
      // The checkout is cloned before any pull request exists, so its commits must be fetched.
      yield* git(root, "clone", "--quiet", forge, cwd);
      yield* git(cwd, "remote", "set-url", "origin", REMOTE_URL);
      yield* git(cwd, "config", `url.${forge}.insteadOf`, REMOTE_URL);
      const base = yield* commit("shared.txt", "main changed this line\n");
      yield* git(forge, "checkout", "--quiet", "-b", "conflict", start);
      const conflicting = yield* commit("shared.txt", "the pull request changed it too\n");
      yield* git(forge, "update-ref", "refs/pull/7/head", conflicting);
      yield* git(forge, "checkout", "--quiet", "-b", "clean", start);
      const clean = yield* commit("other.txt", "unrelated\n");
      yield* git(forge, "update-ref", "refs/pull/8/head", clean);
      const refsBefore = yield* git(cwd, "for-each-ref");

      const pulls: Record<string, { readonly head: string; readonly draft: boolean }> = {
        "7": { head: conflicting, draft: false },
        "8": { head: clean, draft: true },
      };
      const provider = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.merge(
            TestSourceControlHost.layerWithRealGit({
              git: {
                remotes: () =>
                  Effect.succeed(
                    Effect.succeed({
                      remotes: [
                        {
                          name: "origin",
                          url: REMOTE_URL,
                          pushUrl: Option.none(),
                          isPrimary: true,
                        },
                      ],
                      freshness: {
                        source: "live-local" as const,
                        observedAt: DateTime.makeUnsafe("2026-11-16T00:00:00.000Z"),
                        expiresAt: Option.none(),
                      },
                    }),
                  ),
              },
            }),
            Layer.mock(ForgejoCli.ForgejoCli)({
              api: (input) => {
                const [route] = input.path.split("?");
                const pullBody = (number: string) => {
                  const pull = pulls[number];
                  return pull === undefined
                    ? undefined
                    : {
                        number: Number(number),
                        title: `Pull request ${number}`,
                        body: "",
                        html_url: `https://forgejo.test/maria/project/pulls/${number}`,
                        user: { login: "maria" },
                        state: "open",
                        draft: pull.draft,
                        // Forgejo says false for a conflict, a running check, and a draft alike.
                        mergeable: false,
                        merged: false,
                        head: { ref: `refs/pull/${number}/head`, sha: pull.head, repo: null },
                        base: { ref: "main", sha: base, repo: null },
                        merge_base: start,
                        created_at: "2026-11-16T00:00:00Z",
                        updated_at: "2026-11-16T00:00:00Z",
                        closed_at: null,
                        merged_at: null,
                        labels: [],
                      };
                };
                const number = /^repos\/maria\/project\/pulls\/(\d+)$/.exec(route ?? "")?.[1];
                const pull = number === undefined ? undefined : pullBody(number);
                const body =
                  pull !== undefined
                    ? pull
                    : route === "repos/maria/project/pulls"
                      ? input.path.includes("page=1")
                        ? [pullBody("7")]
                        : []
                      : route === "user"
                        ? { login: "maria" }
                        : route === "repos/maria/project"
                          ? {
                              full_name: "maria/project",
                              permissions: { push: true, admin: false },
                            }
                          : route === "repos/maria/project/branches/main"
                            ? {}
                            : [];
                return Effect.succeed(TestSourceControlHost.processOutput(encodeJson(body)));
              },
            }),
          ),
        ),
      );
      const reference = { cwd, repository: "maria/project", host: "forgejo.test" };
      const listed = () =>
        provider
          .listChangeRequests({
            ...reference,
            state: "open",
            involvement: "all",
            viewer: "maria",
            limit: 10,
          })
          .pipe(Effect.map((page) => page.items[0]?.mergeability));

      // A list never fetches, and its miss must not stop the detail read from fetching.
      assert.strictEqual(yield* listed(), "unknown");
      const detail = yield* provider.getChangeRequest({ ...reference, number: 7 });
      assert.strictEqual(detail.mergeability, "conflicting");
      const summary = yield* provider.getChangeRequestSummary!({ ...reference, number: 7 });
      assert.strictEqual(summary.mergeability, "conflicting");
      assert.strictEqual(yield* listed(), "conflicting");
      // A clean local merge cannot say whether Forgejo has finished its own check.
      const cleanDetail = yield* provider.getChangeRequest({ ...reference, number: 8 });
      assert.strictEqual(cleanDetail.mergeability, "unknown");

      assert.strictEqual(yield* git(cwd, "for-each-ref"), refsBefore);
      assert.isFalse(yield* fs.exists(path.join(cwd, ".git", "FETCH_HEAD")));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestSourceControlHost.layerWithRealGit(), NodeServices.layer)),
    ),
);

it.effect.each([
  ["another repository", "https://forgejo.test/maria/other.git", "forgejo.test", false],
  ["another port", "https://forgejo.test:3001/maria/project.git", "forgejo.test:3000", false],
  ["the same port", "https://forgejo.test:3000/maria/project.git", "forgejo.test:3000", true],
  ["SSH on the same host", "git@forgejo.test:maria/project.git", "forgejo.test:3000", true],
] as const)(
  "fetches missing commits only from a remote of the same repository: %s",
  ([, remoteUrl, host, fetches]) =>
    Effect.gen(function* () {
      const runs: Array<ReadonlyArray<string>> = [];
      const provider = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.merge(
            TestSourceControlHost.layer({
              process: {
                run: (input) => {
                  runs.push(input.args);
                  // The commits are missing and any fetch fails.
                  return Effect.succeed(
                    TestSourceControlHost.processOutput("", {
                      exitCode: ChildProcessSpawner.ExitCode(128),
                    }),
                  );
                },
              },
              git: {
                remotes: () =>
                  Effect.succeed(
                    Effect.succeed({
                      remotes: [
                        {
                          name: "origin",
                          url: remoteUrl,
                          pushUrl: Option.none(),
                          isPrimary: true,
                        },
                      ],
                      freshness: {
                        source: "live-local" as const,
                        observedAt: DateTime.makeUnsafe("2026-11-16T00:00:00.000Z"),
                        expiresAt: Option.none(),
                      },
                    }),
                  ),
              },
            }),
            Layer.mock(ForgejoCli.ForgejoCli)({
              api: () =>
                Effect.succeed(
                  TestSourceControlHost.processOutput(
                    encodeJson({
                      number: 7,
                      title: "Pull request 7",
                      body: "",
                      html_url: "https://forgejo.test/maria/project/pulls/7",
                      user: { login: "maria" },
                      state: "open",
                      draft: false,
                      mergeable: false,
                      merged: false,
                      head: { ref: "refs/pull/7/head", sha: "b".repeat(40), repo: null },
                      base: { ref: "main", sha: "a".repeat(40), repo: null },
                      created_at: "2026-11-16T00:00:00Z",
                      updated_at: "2026-11-16T00:00:00Z",
                      closed_at: null,
                      merged_at: null,
                      labels: [],
                    }),
                  ),
                ),
            }),
          ),
        ),
      );
      const summary = yield* provider.getChangeRequestSummary!({
        cwd: "/elsewhere",
        repository: "maria/project",
        host,
        number: 7,
      });
      assert.strictEqual(summary.mergeability, "unknown");
      assert.deepStrictEqual(
        runs.map((args) => args[0]),
        fetches ? ["cat-file", "fetch"] : ["cat-file"],
      );
    }),
);
