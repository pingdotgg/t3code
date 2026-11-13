import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { encodeJsonEffect, processOutput } from "./ForgejoSourceControlProvider.part2.testkit.ts";

it.effect("reads Forgejo jobs that did not run as finished checks", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const read = provider.getChangeRequestChecks;
    if (read === undefined) return yield* Effect.die("checks read missing");
    const result = yield* read({
      cwd: "/repo",
      repository: "acme/web",
      host: "forgejo.test",
      number: 1,
    });
    assert.deepStrictEqual(
      result.checks.map((check) => [check.name, check.status]),
      [
        ["deploy", "skipped"],
        ["audit", "neutral"],
        ["docs", "pending"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          if (input.path.endsWith("branches/main")) {
            return encodeJsonEffect({}).pipe(Effect.orDie, Effect.map(processOutput));
          }
          const status = (context: string, state: string) => ({
            context,
            status: state,
            description: null,
            target_url: null,
            updated_at: "2026-10-11T00:00:00Z",
          });
          const body = input.path.endsWith("branches/main")
            ? {}
            : input.path.endsWith("pulls/1")
              ? {
                  number: 1,
                  title: "Checks",
                  body: "",
                  html_url: "https://forgejo.test/acme/web/pulls/1",
                  user: null,
                  state: "open",
                  merged: false,
                  head: { ref: "feature", sha: "head", repo: null },
                  base: { ref: "main", sha: "base", repo: null },
                  created_at: "2026-10-11T00:00:00Z",
                  updated_at: "2026-10-11T00:00:00Z",
                  closed_at: null,
                  merged_at: null,
                  labels: [],
                }
              : input.path.endsWith("page=1")
                ? [
                    status("deploy", "skipped"),
                    status("audit", "warning"),
                    status("docs", "future-state"),
                  ]
                : [];
          return encodeJsonEffect(body).pipe(Effect.orDie, Effect.map(processOutput));
        },
      }),
    ),
  ),
);

it.effect("opens Forgejo Actions check links on the pull request's server", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const read = provider.getChangeRequestChecks;
    if (read === undefined) return yield* Effect.die("checks read missing");
    const result = yield* read({
      cwd: "/repo",
      repository: "acme/web",
      host: "forgejo.test",
      number: 1,
    });
    assert.deepStrictEqual(
      result.checks.map((check) => [check.name, check.url]),
      [
        ["actions", "https://forgejo.test/git/acme/web/actions/runs/7/jobs/2"],
        ["external", "https://ci.example/build/9"],
        ["none", null],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const status = (context: string, target_url: string | null) => ({
            context,
            status: "success",
            description: null,
            target_url,
            updated_at: "2026-10-11T00:00:00Z",
          });
          const body = input.path.endsWith("branches/main")
            ? {}
            : input.path.endsWith("pulls/1")
              ? {
                  number: 1,
                  title: "Checks",
                  body: "",
                  html_url: "https://forgejo.test/git/acme/web/pulls/1",
                  user: null,
                  state: "open",
                  merged: false,
                  head: { ref: "feature", sha: "head", repo: null },
                  base: { ref: "main", sha: "base", repo: null },
                  created_at: "2026-10-11T00:00:00Z",
                  updated_at: "2026-10-11T00:00:00Z",
                  closed_at: null,
                  merged_at: null,
                  labels: [],
                }
              : input.path.endsWith("page=1")
                ? [
                    // Forgejo includes any sub-path mount in the relative links it reports.
                    status("actions", "/git/acme/web/actions/runs/7/jobs/2"),
                    status("external", "https://ci.example/build/9"),
                    status("none", null),
                  ]
                : [];
          return encodeJsonEffect(body).pipe(Effect.orDie, Effect.map(processOutput));
        },
      }),
    ),
  ),
);

it.effect.each([
  ["Ready", false, true, false, "mergeable"],
  ["Draft", true, false, true, "unknown"],
  ["WIP: Legacy draft", undefined, false, true, "unknown"],
  ["WIP: Explicitly ready", false, false, false, "unknown"],
] as const)(
  "reads Forgejo mergeability for %s (draft=%s, mergeable=%s) across list, summary and detail",
  ([title, draft, mergeable, isDraft, mergeability]) => {
    const pr = {
      number: 42,
      title,
      body: "",
      html_url: "https://forgejo.test/maria/project/pulls/42",
      user: { login: "maria" },
      state: "open",
      merged: false,
      ...(draft === undefined ? {} : { draft }),
      ...(mergeable === undefined ? {} : { mergeable }),
      head: { ref: "feature", sha: "head", repo: null },
      base: { ref: "main", sha: "base", repo: null },
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
      closed_at: null,
      merged_at: null,
      labels: [],
    };
    const requests: string[] = [];
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const readSummary = provider.getChangeRequestSummary;
      if (readSummary === undefined) return yield* Effect.die("summary read missing");
      const readPreview = provider.getChangeRequestPreview;
      if (readPreview === undefined) return yield* Effect.die("preview read missing");
      const input = { cwd: "/repo", repository: "maria/project", host: "forgejo.test", number: 42 };
      const preview = yield* readPreview(input);
      assert.deepStrictEqual(requests, ["repos/maria/project/pulls/42"]);
      assert.strictEqual(preview.isDraft, isDraft);
      assert.strictEqual(preview.title, title);
      assert.strictEqual(preview.state, "open");
      assert.strictEqual(preview.number, 42);
      assert.strictEqual(preview.url, pr.html_url);
      assert.deepStrictEqual(preview.author, { login: "maria", name: null, avatarUrl: null });
      assert.strictEqual(preview.createdAt, "2026-09-16T00:00:00.000Z");
      const list = yield* provider.listChangeRequests({
        ...input,
        state: "open",
        involvement: "all",
        viewer: "maria",
        limit: 10,
      });
      const summary = yield* readSummary(input);
      const detail = yield* provider.getChangeRequest(input);
      assert.strictEqual(list.items.length, 1);
      assert.strictEqual(detail.headSha, "head");
      for (const result of [list.items[0]!, summary, detail]) {
        assert.strictEqual(result.mergeability, mergeability);
        assert.strictEqual(result.isDraft, isDraft);
      }
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            requests.push(input.path);
            const [path, query] = input.path.split("?");
            let response: unknown;
            switch (path) {
              case "repos/maria/project/pulls":
                response = new URLSearchParams(query).get("page") === "1" ? [pr] : [];
                break;
              case "repos/maria/project/pulls/42":
                response = pr;
                break;
              case "repos/maria/project":
                response = { full_name: "maria/project", permissions: { push: true, admin: true } };
                break;
              case "user":
                response = pr.user;
                break;
              case "repos/maria/project/statuses/head":
                response = [];
                break;
              case "repos/maria/project/branches/main":
                response = { name: "main", protected: false };
                break;
              default:
                return Effect.die(`Unexpected Forgejo request: ${input.path}`);
            }
            return encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    );
  },
);

it.effect("asks Forgejo for one required label by id and the author by login", () => {
  const paths: Array<string> = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    yield* provider.listChangeRequests({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      state: "open",
      involvement: "all",
      viewer: "maria",
      limit: 10,
      filters: { labels: [["size:S", "size:M"], ["Bug"]], author: "@me" },
    });
    const listing = paths.find((path) => path.startsWith("repos/maria/project/pulls?"));
    const params = new URLSearchParams(listing?.split("?")[1]);
    assert.deepStrictEqual(params.getAll("labels"), ["7"]);
    assert.strictEqual(params.get("poster"), "maria");
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          paths.push(input.path);
          const response = input.path.startsWith("repos/maria/project/labels")
            ? [{ id: 7, name: "bug" }]
            : [];
          return encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
        },
      }),
    ),
  );
});

it.effect("lists nothing for an author Forgejo has no account for", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      state: "open",
      involvement: "all",
      viewer: "maria",
      limit: 10,
      filters: { author: "nobody" },
    });
    assert.deepStrictEqual(page, { items: [], truncated: false, continues: false });
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) =>
          Effect.fail(
            new ForgejoCli.ForgejoCliError({
              command: "fj",
              cwd: input.cwd,
              httpStatus: 400,
              detail: "Forgejo API request failed (HTTP 400): Poster not found",
            }),
          ),
      }),
    ),
  ),
);

it.effect("says an author search was cut short by a server that pages below its limit", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const search = provider.searchRepositoryAuthors;
    if (search === undefined) return yield* Effect.die("author search missing");
    const found = yield* search({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      query: "dev",
    });
    assert.strictEqual(found.items.length, 30);
    assert.isTrue(found.truncated);
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: () =>
          encodeJsonEffect({
            ok: true,
            data: Array.from({ length: 30 }, (_, index) => ({ login: `dev-${index}` })),
          }).pipe(
            Effect.orDie,
            Effect.map((stdout) =>
              processOutput(stdout, {
                stderr:
                  'HTTP/1.1 200\nlink: <https://forgejo.test/api/v1/users/search?page=2>; rel="next"\n',
              }),
            ),
          ),
      }),
    ),
  ),
);

it.effect("gives Forgejo identities the browser URL of the login that serves them", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const refine = provider.refineRepositoryIdentity;
    assert.isDefined(refine);
    const identity = (remoteUrl: string, provider?: string) => ({
      canonicalKey: "forge.test/team/repo",
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
      rootPath: "/repo",
      ...(provider === undefined ? {} : { provider: SourceControlProviderKind.make(provider) }),
    });
    const served = (baseUrl: string) => () =>
      Effect.succeed({
        provider: {
          kind: SourceControlProviderKind.make("forgejo"),
          name: "Forgejo / Gitea",
          baseUrl,
        },
        remoteName: "origin",
        remoteUrl: "",
      });

    assert.deepStrictEqual(
      yield* refine!({
        identity: identity("http://forge.test:3000/git/team/repo.git"),
        resolveContext: served("http://forge.test:3000/git/"),
      }),
      {
        ...identity("http://forge.test:3000/git/team/repo.git"),
        provider: SourceControlProviderKind.make("forgejo"),
        webUrl: "http://forge.test:3000/git/team/repo",
      },
    );
    assert.strictEqual(
      (yield* refine!({
        identity: identity("ssh://git@ssh.forge.test/team/repo.git"),
        resolveContext: served("http://forge.test:3000/git"),
      })).webUrl,
      "http://forge.test:3000/git/team/repo",
    );
    const github = identity("https://github.com/team/repo.git", "github");
    assert.strictEqual(
      yield* refine!({ identity: github, resolveContext: () => Effect.die("not asked") }),
      github,
    );
    const unserved = identity("http://forge.test:3000/team/repo.git");
    assert.strictEqual(
      yield* refine!({ identity: unserved, resolveContext: () => Effect.succeed(null) }),
      unserved,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer(),
        Layer.mock(ForgejoCli.ForgejoCli)({}),
      ),
    ),
  ),
);

it.effect("names the web server behind an SSH alias from the login that serves it", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const resolveWebHost = provider.resolveRemoteWebHost!;
    const asked: Array<string | undefined> = [];
    const context = (remoteUrl: string) => ({
      provider: {
        kind: SourceControlProviderKind.make("forgejo"),
        name: "Forgejo",
        baseUrl: "https://ssh.forge.test",
      },
      remoteName: "origin",
      remoteUrl,
      requestedHost: "forge.test:3000",
    });
    const served = (input: {
      readonly context: { readonly requestedHost?: string; readonly provider: { kind: string } };
    }) =>
      Effect.sync(() => {
        asked.push(input.context.requestedHost);
        assert.strictEqual(input.context.provider.kind, "unknown");
        return {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo / Gitea",
            baseUrl: "http://forge.test:3000/git",
          },
          remoteName: "origin",
          remoteUrl: "",
        };
      });

    assert.strictEqual(
      yield* resolveWebHost({
        cwd: "/repo",
        context: context("git@ssh.forge.test:team/repo.git"),
        resolveContext: served,
      }),
      "forge.test:3000",
    );
    assert.deepStrictEqual(asked, ["forge.test:3000"]);
    assert.strictEqual(
      yield* resolveWebHost({
        cwd: "/repo",
        context: context("https://forge.test:3000/team/repo.git"),
        resolveContext: () => Effect.die("an HTTP remote names its own web host"),
      }),
      null,
    );
    assert.strictEqual(
      yield* resolveWebHost({
        cwd: "/repo",
        context: context("git@ssh.forge.test:team/repo.git"),
        resolveContext: () => Effect.succeed(null),
      }),
      null,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer(),
        Layer.mock(ForgejoCli.ForgejoCli)({}),
      ),
    ),
  ),
);
