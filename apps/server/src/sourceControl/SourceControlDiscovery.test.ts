import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import * as ForgejoPullRequestProvider from "../pullRequest/ForgejoPullRequestProvider.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import { firstNonEmptyLine } from "./SourceControlProviderDiscovery.ts";

const sourceControlProviderRegistryTestLayer = (input: {
  readonly bitbucket: Partial<BitbucketApi.BitbucketApi["Service"]>;
  readonly process: Partial<VcsProcess.VcsProcess["Service"]>;
}) =>
  SourceControlProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)(input.bitbucket),
        Layer.mock(GitHubCli.GitHubCli)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(VcsProcess.VcsProcess)(input.process),
      ),
    ),
  );

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("submits a Forgejo review without sending its summary in the preliminary GET", () => {
  const methods: string[] = [];
  const fetchReview = async (
    ...[input, init]: Parameters<Context.Service.Shape<typeof FetchHttpClient.Fetch>>
  ) => {
    const request = new Request(input instanceof Request ? input.url : String(input), {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    methods.push(request.method);
    if (request.method === "GET") {
      assert.strictEqual(request.url, "https://forgejo.test/api/v1/repos/maria/project/pulls/42");
      return new Response(
        encodeJson({
          number: 42,
          title: "Review target",
          body: "",
          html_url: "https://forgejo.test/maria/project/pulls/42",
          user: { login: "maria" },
          state: "open",
          merged: false,
          head: { ref: "feature", sha: "head", repo: null },
          base: { ref: "main", sha: "base", repo: null },
          created_at: "2026-09-13T00:00:00Z",
          updated_at: "2026-09-13T00:00:00Z",
          closed_at: null,
          merged_at: null,
          labels: [],
        }),
      );
    }
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(
      request.url,
      "https://forgejo.test/api/v1/repos/maria/project/pulls/42/reviews",
    );
    assert.deepStrictEqual(JSON.parse(await request.text()), {
      event: "COMMENT",
      body: "Review summary",
      commit_id: "head",
      comments: [],
    });
    return new Response('{"id":1}', { status: 200 });
  };
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    yield* provider.submitReview({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
      verdict: "comment",
      body: "Review summary",
      comments: [],
    });
    assert.deepStrictEqual(methods, ["GET", "POST"]);
  }).pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(fetchReview, { preconnect: () => undefined }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({ hosts: { "forgejo.test": { type: "Application", token: "test-token" } } }),
          ),
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git") {
            assert.deepStrictEqual(input.args, ["remote", "-v"]);
            return Effect.succeed(
              processOutput("origin\thttps://forgejo.test/maria/project.git (fetch)"),
            );
          }
          assert.strictEqual(input.command, "fj");
          assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
          return Effect.succeed(processOutput(""));
        },
      }),
    ),
  );
});

it.effect("loads Forgejo pull request references from files and commits views", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    for (const reference of [
      "42",
      "#42",
      "https://forgejo.test/maria/project/pulls/42",
      "https://forgejo.test/maria/project/pulls/42/",
      "https://forgejo.test/maria/project/pulls/42/files?w=1#diff-1",
      "http://forgejo.test:3000/git/maria/project/pulls/42/commits",
    ]) {
      const result = yield* provider.getChangeRequest({ cwd: "/repo", reference });
      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Forgejo view reference");
    }
    const invalid = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://forgejo.test/maria/project/pulls/42invalid/files",
      })
      .pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        Layer.mock(VcsProcess.VcsProcess)({}),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "work",
              repository: "maria/project",
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            assert.strictEqual(input.path, "repos/maria/project/pulls/42");
            return encodeJsonEffect({
              number: 42,
              title: "Forgejo view reference",
              html_url: "https://forgejo.test/maria/project/pulls/42",
              state: "open",
              merged: false,
              base: { ref: "main", sha: "base", repo: null },
              head: { ref: "feature", sha: "head", repo: null },
            }).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    ),
  ),
);

it.effect(
  "loads Forgejo reactions on comments, reviews and inline threads and resolves review mutations",
  () => {
    const user = { login: "maria" };
    const review = {
      id: 8,
      body: "review body",
      user,
      state: "COMMENT",
      submitted_at: "2026-09-12T00:00:00Z",
      html_url: "https://forgejo.test/maria/project/pulls/2#issuecomment-37",
      comments_count: 1,
    };
    const comment = { id: 12, body: "ordinary", user, created_at: review.submitted_at };
    const responses: Record<string, unknown> = {
      user,
      "repos/maria/project/issues/2/comments": [comment],
      "repos/maria/project/pulls/2/reviews": [review],
      "repos/maria/project/pulls/2/reviews/8": review,
      "repos/maria/project/pulls/2/reviews/9": { ...review, id: 9, html_url: "" },
      "repos/maria/project/pulls/2/commits": [],
      "repos/maria/project/issues/2/reactions": [],
      "repos/maria/project/pulls/2/reviews/8/comments": [
        {
          ...comment,
          id: 38,
          body: "inline",
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        },
      ],
      "repos/maria/project/issues/comments/12/reactions": [{ content: "+1", user }],
      "repos/maria/project/issues/comments/37/reactions": [{ content: "heart", user }],
      "repos/maria/project/issues/comments/38/reactions": [
        { content: "rocket", user: { login: "reviewer" } },
      ],
    };
    const writes: ForgejoCli.ForgejoApiInput[] = [];
    let reactionReads = 0;
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const input = { cwd: "/repo", repository: "maria/project", host: "forgejo.test", number: 2 };
      const activity = yield* provider.getChangeRequestActivity(input);
      assert.deepStrictEqual(
        activity.comments.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          reactions: entry.reactions,
        })),
        [
          {
            id: "12",
            kind: "issue-comment",
            reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "review:8",
            kind: "review",
            reactions: [{ content: "heart", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "38",
            kind: "review-comment",
            reactions: [
              { content: "rocket", count: 1, actors: ["reviewer"], viewerHasReacted: false },
            ],
          },
        ],
      );
      const inlineComment = activity.comments[2];
      assert.ok(inlineComment);
      assert.deepStrictEqual(activity.reviewThreads[0]?.comments, [inlineComment]);
      for (const reacted of [true, false]) {
        yield* provider.setReaction({ ...input, subjectId: "review:8", content: "heart", reacted });
        yield* provider.setReaction({ ...input, subjectId: "38", content: "rocket", reacted });
      }
      assert.deepStrictEqual(
        writes.map(({ path, method, body }) => ({ path, method, body })),
        [
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "POST",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "POST",
            body: { content: "rocket" },
          },
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "DELETE",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "DELETE",
            body: { content: "rocket" },
          },
        ],
      );
      const missing = yield* provider
        .setReaction({ ...input, subjectId: "review:9", content: "heart", reacted: true })
        .pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      if (missing._tag === "Failure") assert.include(missing.failure.detail, "comment ID");
      assert.strictEqual(writes.length, 4);
      responses["repos/maria/project/pulls/2/reviews/8/comments"] = Array.from(
        { length: 501 },
        (_, index) => ({
          ...comment,
          id: 1000 + index,
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        }),
      );
      for (let index = 0; index < 500; index++) {
        responses[`repos/maria/project/issues/comments/${1000 + index}/reactions`] = [];
      }
      reactionReads = 0;
      const bounded = yield* provider.getChangeRequestActivity(input);
      assert.strictEqual(bounded.reviewThreads.length, 500);
      assert.strictEqual(
        bounded.comments.filter((entry) => entry.kind === "review-comment").length,
        500,
      );
      assert.strictEqual(bounded.commentsTruncated, true);
      assert.strictEqual(reactionReads, 502);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            if (input.method) {
              writes.push(input);
              return Effect.succeed(processOutput("{}"));
            }
            const path = input.path.split("?")[0]!;
            if (/\/issues\/comments\/\d+\/reactions$/.test(path)) reactionReads++;
            assert.ok(Object.hasOwn(responses, path), `Unexpected Forgejo request: ${path}`);
            const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
            return encodeJsonEffect(page > 1 ? [] : responses[path]).pipe(
              Effect.orDie,
              Effect.map(processOutput),
            );
          },
        }),
      ),
    );
  },
);

it.effect("reports implemented tools separately from locally available executables", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.command === "git") {
        return Effect.succeed(processOutput("git version 2.51.0\n"));
      }
      if (input.command === "gh" && input.args[0] === "--version") {
        return Effect.succeed(processOutput("gh version 2.83.0\n"));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "juliusmarminge",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const testLayer = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      sourceControlProviderRegistryTestLayer({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("bitbucket.org"),
            detail: Option.some(
              "Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN, or T3CODE_BITBUCKET_ACCESS_TOKEN.",
            ),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: "github",
          status: "available",
          auth: "authenticated",
          account: Option.some("juliusmarminge"),
        },
        {
          kind: "gitlab",
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "azure-devops",
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "bitbucket",
          status: "available",
          auth: "unauthenticated",
          account: Option.none(),
        },
        {
          kind: "forgejo",
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
      ],
    );
    const bitbucket = result.sourceControlProviders.find((item) => item.kind === "bitbucket");
    assert.ok(bitbucket);
    assert.strictEqual(bitbucket.executable, undefined);
  }).pipe(Effect.provide(testLayer));
});

it.effect("probes provider authentication without exposing token details", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.args[0] === "--version") {
        return Effect.succeed(processOutput(`${input.command} version test\n`));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "octocat",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      if (input.command === "glab" && input.args.join(" ") === "auth status") {
        return Effect.succeed(
          processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
        );
      }
      if (input.command === "tea" && input.args[0] === "login") {
        return Effect.succeed(
          processOutput(
            encodeJson([
              {
                name: "forgejo",
                url: "https://forgejo.example.com",
                ssh_host: "forgejo.example.com",
                user: "forgejo-user",
                valid: "true",
                default: "true",
              },
            ]),
          ),
        );
      }
      if (
        input.command === "az" &&
        input.args.join(" ") === "account show --query user.name -o tsv"
      ) {
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const testLayer = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-auth-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      sourceControlProviderRegistryTestLayer({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "authenticated",
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: "github",
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
        {
          kind: "gitlab",
          auth: "authenticated",
          account: Option.some("gitlab-user"),
          detail: Option.none(),
        },
        {
          kind: "azure-devops",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
        {
          kind: "bitbucket",
          auth: "authenticated",
          account: Option.some("bitbucket-user"),
          detail: Option.none(),
        },
        {
          kind: "forgejo",
          auth: "authenticated",
          account: Option.some("forgejo-user"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect("discovers Forgejo accounts and retains the server port", () =>
  Effect.gen(function* () {
    const auth = ForgejoSourceControlProvider.discovery.parseAuth(
      processOutput(
        yield* encodeJsonEffect([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            ssh_host: "git.forgejo.local",
            user: "maria",
            default: "true",
            valid: "true",
          },
        ]),
      ),
    );
    assert.deepStrictEqual(
      firstNonEmptyLine("\u001b[1mtea version 0.16.0\u001b[0m\n"),
      Option.some("tea version 0.16.0"),
    );
    assert.strictEqual(auth.status, "authenticated");
    assert.deepStrictEqual(auth.account, Option.some("maria"));
    assert.deepStrictEqual(auth.host, Option.some("forgejo.local:3000"));
    const revoked = ForgejoSourceControlProvider.discovery.parseAuth(
      processOutput(
        encodeJson([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            user: "maria",
            default: "true",
            valid: "false",
          },
        ]),
      ),
    );
    assert.strictEqual(revoked.status, "unauthenticated");
    const refined = ForgejoSourceControlProvider.discovery.refineUnknownRemote({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown",
          name: "git.forgejo.local",
          baseUrl: "https://git.forgejo.local",
        },
        remoteName: "origin",
        remoteUrl: "git@git.forgejo.local:maria/project.git",
      },
      auth: processOutput(
        yield* encodeJsonEffect([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            ssh_host: "git.forgejo.local",
            user: "maria",
            default: "true",
          },
        ]),
      ),
    });
    assert.deepStrictEqual(refined, {
      kind: "forgejo",
      name: "Forgejo / Gitea",
      baseUrl: "http://forgejo.local:3000",
    });
  }),
);

it.effect("does not choose a default Forgejo login across ambiguous SSH server ports", () =>
  Effect.gen(function* () {
    const logins = ForgejoCli.parseForgejoLogins(
      yield* encodeJsonEffect([
        {
          name: "one",
          url: "http://forgejo.local:3000",
          ssh_host: "forgejo.local",
          user: "maria",
          default: "true",
        },
        {
          name: "two",
          url: "http://forgejo.local:4000",
          ssh_host: "forgejo.local",
          user: "maria",
          default: "false",
        },
      ]),
    );
    const remote = ForgejoCli.parseForgejoRemote("git@forgejo.local:maria/project.git");
    assert.isNotNull(remote);
    assert.deepStrictEqual(
      ForgejoCli.parseForgejoRemote("forgejo.local:maria/project.git"),
      remote,
    );
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, remote!));
    assert.strictEqual(
      ForgejoCli.matchForgejoLogin(logins, remote!, "forgejo.local:4000")?.name,
      "two",
    );
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, remote!, "other.local:4000"));
    const alias = ForgejoCli.parseForgejoRemote("git@ssh.forgejo.local:maria/project.git");
    assert.isNotNull(alias);
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, alias!, "forgejo.local:4000"));
    const refined = ForgejoSourceControlProvider.discovery.refineUnknownRemote({
      cwd: "/repo",
      context: {
        provider: { kind: "unknown", name: "Forgejo", baseUrl: "https://forgejo.local" },
        remoteName: "origin",
        remoteUrl: "git@forgejo.local:maria/project.git",
        requestedHost: "forgejo.local:4000",
      },
      auth: processOutput(yield* encodeJsonEffect(logins)),
    });
    assert.strictEqual(refined?.baseUrl, "http://forgejo.local:4000");
    const https = ForgejoCli.parseForgejoRemote("http://forgejo.local:4000/maria/project.git");
    assert.isNotNull(https);
    assert.strictEqual(ForgejoCli.matchForgejoLogin(logins, https!)?.name, "two");
    const hostOnly = ForgejoCli.parseForgejoRemote("http://forgejo.local:4000");
    assert.strictEqual(
      ForgejoCli.matchForgejoLogin(logins, hostOnly!, undefined, true)?.name,
      "two",
    );
    const mounted = logins.map((login) => ({
      ...login,
      url: `http://forgejo.local:4000/${login.name}`,
    }));
    assert.isUndefined(ForgejoCli.matchForgejoLogin(mounted, hostOnly!, undefined, true));
  }),
);

it.effect("rejects HTTP failures even when tea exits successfully", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .api({
        cwd: "/repo",
        repository: "http://forgejo.local:3000/maria/project",
        path: "repos/maria/project/pulls/42",
        method: "PATCH",
        body: { state: "closed" },
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.strictEqual(
        result.failure.detail,
        "Forgejo repository or pull request was not found.",
      );
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(false),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("tea must handle its own HTTP request");
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.args[0] === "api") {
            assert.strictEqual(input.stdin, '{"state":"closed"}');
            assert.include(input.args, "work");
            assert.include(
              input.args,
              "http://forgejo.local:3000/api/v1/repos/maria/project/pulls/42",
            );
          }
          return Effect.succeed(
            input.args[0] === "login"
              ? processOutput(
                  encodeJson([
                    {
                      name: "work",
                      url: "http://forgejo.local:3000",
                      ssh_host: "forgejo.local",
                      user: "maria",
                      default: "true",
                    },
                  ]),
                )
              : processOutput('{"message":"not found"}', { stderr: "HTTP/1.1 404 Not Found\n" }),
          );
        },
      }),
    ),
  ),
);

it.effect("routes mounted Forgejo repositories without repeating the mount in API paths", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const viewer = yield* cli.api({ cwd: "/upstream-only", host: "code.test", path: "user" });
    assert.strictEqual(viewer.stdout, "[]");
    const mountedRepository = yield* cli.resolveRepository({
      cwd: "/upstream-only",
      host: "code.test",
      repository: "maria/project",
    });
    assert.strictEqual(mountedRepository.baseUrl, "https://code.test/forgejo");
    assert.strictEqual(mountedRepository.repository, "maria/project");
    for (const path of [
      "repos/forgejo/maria/project/pulls?state=open",
      "repos/forgejo/maria/project",
      "repos/reviewer/project/contents/file.ts",
    ]) {
      const result = yield* cli.api({
        cwd: "/repo",
        repository: "forgejo/maria/project",
        context: {
          provider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://code.test/forgejo" },
          remoteName: "origin",
          remoteUrl: "https://code.test/forgejo/maria/project.git",
        },
        path,
      });
      assert.strictEqual(result.stdout, "[]");
    }
    const sameOwnerAsMount = yield* cli.resolveRepository({
      cwd: "/repo",
      repository: "forgejo/project",
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://code.test/forgejo" },
        remoteName: "origin",
        remoteUrl: "ssh://git@code.test/forgejo/project.git",
      },
    });
    assert.strictEqual(sameOwnerAsMount.command, "tea");
    assert.strictEqual(sameOwnerAsMount.repository, "forgejo/project");
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "code.test/forgejo": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("tea must handle its own HTTP request");
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git")
            return Effect.succeed(processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) }));
          if (input.args[0] === "login")
            return Effect.succeed(
              processOutput(
                encodeJson([
                  {
                    name: "mounted",
                    url: "https://code.test/forgejo",
                    ssh_host: "code.test",
                    user: "maria",
                    default: "true",
                  },
                ]),
              ),
            );
          const supported = [
            "https://code.test/forgejo/api/v1/user",
            "https://code.test/forgejo/api/v1/repos/maria/project/pulls?state=open",
            "https://code.test/forgejo/api/v1/repos/maria/project",
            "https://code.test/forgejo/api/v1/repos/reviewer/project/contents/file.ts",
          ];
          if (input.args.at(-1)?.endsWith("/user")) assert.notInclude(input.args, "--repo");
          assert.strictEqual(input.command, "tea");
          return Effect.succeed(
            supported.includes(input.args.at(-1) ?? "")
              ? processOutput("[]", { stderr: "HTTP/1.1 200 OK\n" })
              : processOutput("{}", { stderr: "HTTP/1.1 404 Not Found\n" }),
          );
        },
      }),
    ),
  ),
);

it.effect("prefers fj for HTTP and ported SSH aliases on root servers", () => {
  const commands: string[] = [];
  const requests: string[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    for (const remoteUrl of [
      "http://forgejo.local:3000/maria/project.git",
      "ssh://git@ssh.forgejo.local:2222/maria/project.git",
      "ssh://git@forgejo.local:2222/maria/project.git",
    ]) {
      const result = yield* cli.api({
        cwd: "/repo",
        repository: "maria/project",
        context: {
          provider: {
            kind: "forgejo",
            name: "Forgejo",
            baseUrl: "http://forgejo.local:3000",
          },
          remoteName: "origin",
          remoteUrl,
          requestedHost: "forgejo.local:3000",
        },
        path: "repos/maria/project/issues/42/comments",
        method: "POST",
        body: { body: "verified through fj" },
      });
      assert.strictEqual(result.stdout, '{"id":99}');
    }
    assert.deepStrictEqual(commands, ["fj"]);
    assert.deepStrictEqual(requests, [
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
    ]);
    const viewer = yield* cli.api({
      cwd: "/no-remotes",
      host: "forgejo.local:3000",
      path: "user",
    });
    assert.strictEqual(viewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "https://forgejo.local:3000/api/v1/user");
    const upstreamViewer = yield* cli.api({
      cwd: "/upstream-only",
      host: "forgejo.local:3000",
      path: "user",
    });
    assert.strictEqual(upstreamViewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "http://forgejo.local:3000/api/v1/user");
    const upstreamRepository = yield* cli.resolveRepository({
      cwd: "/upstream-only",
      host: "forgejo.local:3000",
      repository: "maria/project",
    });
    assert.strictEqual(upstreamRepository.baseUrl, "http://forgejo.local:3000");
    assert.strictEqual(upstreamRepository.repository, "maria/project");
    const httpViewer = yield* cli.api({ cwd: "/repo", host: "forgejo.local:3000", path: "user" });
    assert.strictEqual(httpViewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "http://forgejo.local:3000/api/v1/user");
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: {
                "forgejo.local:3000": { type: "Application", token: "test-token" },
                "forgejo.local:4000": { type: "Application", token: "other-token" },
              },
              aliases: { "ssh.forgejo.local:2222": "forgejo.local:3000" },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        if (request.url.endsWith("/user")) {
          assert.strictEqual(request.method, "GET");
          assert.strictEqual(request.headers.authorization, "token test-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response('{"login":"maria"}')),
          );
        }
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.headers.authorization, "token test-token");
        assert.strictEqual(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array")
          assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(request.body.body)), {
            body: "verified through fj",
          });
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"id":99}', { status: 201 })),
        );
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          commands.push(input.command);
          if (input.command === "git")
            return Effect.succeed(
              input.cwd === "/no-remotes"
                ? processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) })
                : processOutput(
                    `${input.cwd === "/upstream-only" ? "upstream" : "origin"}\thttp://forgejo.local:3000/maria/project.git (fetch)\nother\thttp://forgejo.local:3000/maria/other.git (fetch)\nunrelated\thttp://other.local:3000/maria/project.git (fetch)`,
                  ),
            );
          assert.strictEqual(input.command, "fj");
          assert.deepStrictEqual(input.args, [
            "--host",
            input.cwd === "/no-remotes"
              ? "https://forgejo.local:3000"
              : "http://forgejo.local:3000",
            "whoami",
          ]);
          return Effect.succeed(processOutput(""));
        },
      }),
    ),
  );
});

it.effect("loads later fj review pages when the server caps pages below the requested size", () => {
  const pages: number[] = [];
  let issueCommentRequests = 0;
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
    });
    assert.strictEqual(activity.commentCount, 42);
    assert.strictEqual(activity.comments.at(-1)?.id, "review:41");
    assert.strictEqual(activity.commentsTruncated, false);
    assert.deepStrictEqual(pages, [1, 2, 3]);
    assert.strictEqual(issueCommentRequests, 1);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({ hosts: { "forgejo.test": { type: "Application", token: "test-token" } } }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/repos/maria/project/issues/42/comments") {
          issueCommentRequests++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                encodeJson([
                  {
                    id: 100,
                    body: "Unpaginated issue comment",
                    user: { login: "maria" },
                    created_at: "2026-09-13T00:00:00Z",
                  },
                ]),
              ),
            ),
          );
        }
        if (url.pathname.endsWith("/reviews")) {
          const page = Number(url.searchParams.get("page"));
          pages.push(page);
          assert.ok(page >= 1 && page <= 3);
          const reviews = Array.from({ length: page < 3 ? 20 : 1 }, (_, index) => ({
            id: (page - 1) * 20 + index + 1,
            body: "Review from a capped page",
            user: { login: "maria" },
            state: "COMMENT",
            submitted_at: "2026-09-13T00:00:00Z",
            comments_count: 0,
          }));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(reviews), {
                headers:
                  page === 2
                    ? {}
                    : {
                        Link:
                          page === 1
                            ? `<${url.origin}${url.pathname}?limit=50&page=2>; rel="next"`
                            : `<${url.origin}${url.pathname}?limit=50&page=1>; rel="prev"`,
                      },
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(url.pathname === "/api/v1/user" ? { login: "maria" } : [])),
          ),
        );
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git") {
            assert.deepStrictEqual(input.args, ["remote", "-v"]);
            return Effect.succeed(
              processOutput("origin\thttps://forgejo.test/maria/project.git (fetch)"),
            );
          }
          assert.strictEqual(input.command, "fj");
          assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
          return Effect.succeed(processOutput(""));
        },
      }),
    ),
  );
});

it.effect("falls back to tea when fj is missing or has no account for this server", () =>
  Effect.gen(function* () {
    for (const scenario of ["missing-cli", "missing-account", "stale-invalid-storage"] as const) {
      const commands: string[] = [];
      yield* Effect.gen(function* () {
        const cli = yield* ForgejoCli.make;
        const result = yield* cli.api({
          cwd: "/repo",
          repository: "https://forgejo.local:3000/maria/project",
          path: "repos/maria/project/pulls",
        });
        assert.strictEqual(result.stdout, "[]");
        assert.deepStrictEqual(
          commands,
          scenario === "missing-account" ? ["tea", "tea"] : ["fj", "tea", "tea"],
        );
        const viewer = yield* cli.api({
          cwd: "/upstream-only",
          host: "forgejo.local:3000",
          path: "user",
        });
        assert.strictEqual(viewer.stdout, "[]");
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(
                scenario === "stale-invalid-storage"
                  ? "invalid json"
                  : encodeJson({
                      hosts: {
                        [scenario === "missing-cli" ? "forgejo.local:3000" : "other.local"]: {
                          type: "Application",
                          token: "test-token",
                        },
                      },
                    }),
              ),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => {
            throw new Error("tea must handle its own HTTP request");
          }),
        ),
        Effect.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) => {
              commands.push(input.command);
              if (input.command === "git")
                return Effect.succeed(
                  processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) }),
                );
              if (input.command === "fj")
                return Effect.fail(
                  new VcsProcessSpawnError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    cause: new Error("fj not found"),
                  }),
                );
              assert.strictEqual(input.command, "tea");
              if (input.args.at(-1)?.endsWith("/user")) assert.notInclude(input.args, "--repo");
              return Effect.succeed(
                input.args[0] === "login"
                  ? processOutput(
                      encodeJson([
                        {
                          name: "work",
                          url: "https://forgejo.local:3000",
                          user: "maria",
                          default: "true",
                          valid: "true",
                        },
                      ]),
                    )
                  : processOutput("[]", { stderr: "HTTP/1.1 200 OK\n" }),
              );
            },
          }),
        ),
      );
    }
  }),
);

it.effect("handles fj mutation statuses without retrying failures or reading absent bodies", () =>
  Effect.gen(function* () {
    for (const status of [204, 205, 302, 401, 403, 404, 429, 500]) {
      let writes = 0;
      yield* Effect.gen(function* () {
        const cli = yield* ForgejoCli.make;
        const result = yield* cli
          .api({
            cwd: "/repo",
            repository: "https://forgejo.local/maria/project",
            path: "repos/maria/project/issues/42/comments",
            method: "POST",
            body: { body: "only once" },
          })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, status < 300 ? "Success" : "Failure");
        if (result._tag === "Success") assert.strictEqual(result.success.stdout, "");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.command, "fj");
          assert.strictEqual(result.failure.httpStatus, status);
        }
        assert.strictEqual(writes, 1);
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(
                encodeJson({
                  hosts: {
                    "forgejo.local": { type: "Application", token: "test-token" },
                  },
                }),
              ),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            writes++;
            assert.strictEqual(
              request.url,
              "https://forgejo.local/api/v1/repos/maria/project/issues/42/comments",
            );
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(status < 300 ? null : "", {
                  status,
                  headers: { location: "https://other.local/" },
                }),
              ),
            );
          }),
        ),
        Effect.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) => {
              assert.strictEqual(
                input.command,
                "fj",
                "a failed mutation must never switch accounts or CLI",
              );
              return Effect.succeed(processOutput(""));
            },
          }),
        ),
      );
    }
  }),
);

it.effect(
  "discovers fj first and retains configured authentication failures instead of switching accounts",
  () =>
    Effect.gen(function* () {
      for (const scenario of ["authenticated", "revoked", "missing", "invalid-storage"] as const) {
        const commands: string[] = [];
        yield* Effect.gen(function* () {
          const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
          assert.strictEqual(spec.type, "managed-cli");
          if (spec.type !== "managed-cli") return;
          const result = yield* spec.probe("/repo");
          assert.strictEqual(result.executable, scenario === "missing" ? "tea" : "fj");
          assert.strictEqual(
            result.auth.status,
            scenario === "revoked"
              ? "unauthenticated"
              : scenario === "invalid-storage"
                ? "unknown"
                : "authenticated",
          );
          if (scenario !== "revoked" && scenario !== "invalid-storage")
            assert.deepStrictEqual(result.auth.host, Option.some("forgejo.local:3000"));
          assert.deepStrictEqual(
            result.auth.account,
            scenario === "authenticated" || scenario === "missing"
              ? Option.some("maria")
              : Option.none(),
          );
          assert.strictEqual(
            commands.some((command) => command.startsWith("tea ")),
            scenario === "missing",
          );
          assert.include(commands, "fj version");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ForgejoCli.ForgejoCli)({
                getAccount: (input) => {
                  assert.strictEqual(scenario, "authenticated");
                  assert.deepStrictEqual(input, {
                    cwd: "/repo",
                    baseUrl: "http://forgejo.local:3000",
                  });
                  return Effect.succeed("maria");
                },
                listLogins: (input) => {
                  assert.strictEqual(
                    input.remoteUrl,
                    "http://forgejo.local:3000/maria/project.git",
                  );
                  if (scenario === "invalid-storage")
                    return Effect.fail(
                      new ForgejoCli.ForgejoCliError({
                        command: "fj",
                        cwd: input.cwd,
                        reason: "authentication",
                        detail: "fj authentication storage is invalid.",
                      }),
                    );
                  return Effect.succeed([
                    {
                      name: "forgejo.local:3000",
                      url: "http://forgejo.local:3000",
                      user: "",
                      default: "false",
                    },
                  ]);
                },
              }),
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) => {
                  commands.push(`${input.command} ${input.args.join(" ")}`);
                  if (input.command === "git")
                    return Effect.succeed(
                      processOutput("http://forgejo.local:3000/maria/project.git\n"),
                    );
                  if (input.command === "fj") {
                    if (scenario === "missing")
                      return Effect.fail(
                        new VcsProcessSpawnError({
                          operation: input.operation,
                          command: input.command,
                          cwd: input.cwd,
                          cause: new Error("fj not found"),
                        }),
                      );
                    if (input.args[0] === "version")
                      return Effect.succeed(processOutput("fj 0.10.0"));
                    if (scenario === "invalid-storage") {
                      assert.deepStrictEqual(input.args, ["auth", "list"]);
                      return Effect.succeed(processOutput(""));
                    }
                    assert.deepStrictEqual(input.args, [
                      "--host",
                      "http://forgejo.local:3000",
                      "whoami",
                    ]);
                    return Effect.succeed(
                      processOutput("", {
                        exitCode: ChildProcessSpawner.ExitCode(scenario === "revoked" ? 1 : 0),
                      }),
                    );
                  }
                  assert.strictEqual(input.command, "tea");
                  return Effect.succeed(
                    input.args[0] === "--version"
                      ? processOutput("tea version 0.16.0")
                      : processOutput(
                          encodeJson([
                            {
                              name: "work",
                              url: "http://forgejo.local:3000",
                              user: "maria",
                              default: "true",
                              valid: "true",
                            },
                          ]),
                        ),
                  );
                },
              }),
            ),
          ),
        );
      }
    }),
);

it.effect(
  "checks out fj pull refs and preserves existing branches and dirty files until forced",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* VcsProcess.VcsProcess;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fj-checkout-" });
      const source = path.join(root, "source");
      const cwd = path.join(root, "checkout");
      yield* fs.makeDirectory(source);
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      yield* fs.writeFileString(path.join(source, "base.txt"), "base\n");
      for (const args of [
        ["add", "base.txt"],
        ["commit", "-m", "base"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const base = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: root,
        args: ["clone", source, cwd],
      });
      yield* fs.writeFileString(path.join(source, "feature.txt"), "pull request change\n");
      for (const args of [
        ["add", "feature.txt"],
        ["commit", "-m", "feature"],
        ["update-ref", "refs/pull/42/head", "HEAD"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const head = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      const fetched: string[] = [];
      const provider = yield* ForgejoSourceControlProvider.make.pipe(
        Effect.provideService(
          VcsProcess.VcsProcess,
          VcsProcess.VcsProcess.of({
            run: (input) => {
              if (input.args[0] !== "fetch") return git.run(input);
              const url = input.args[2];
              assert.isDefined(url);
              fetched.push(url!);
              // Only SSH transport is substituted; both paths fetch the real pull ref.
              return git.run({
                ...input,
                args: input.args.map((arg) =>
                  arg === "git@forgejo.test:reviewer/project.git" ? source : arg,
                ),
              });
            },
          }),
        ),
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            resolveRepository: () =>
              Effect.succeed({
                command: "fj",
                login: "work",
                repository: "reviewer/project",
                baseUrl: "https://forgejo.test",
              }),
            api: (input) => {
              assert.include(
                ["repos/reviewer/project", "repos/reviewer/project/pulls/42"],
                input.path,
              );
              return Effect.succeed(
                processOutput(
                  encodeJson(
                    input.path.endsWith("/pulls/42")
                      ? {
                          number: 42,
                          title: "Checkout",
                          html_url: "https://forgejo.test/reviewer/project/pulls/42",
                          state: "open",
                          merged: false,
                          base: { ref: "main", sha: base, repo: null },
                          head: { ref: "feature", sha: head, repo: null },
                        }
                      : {
                          full_name: "reviewer/project",
                          clone_url: source,
                          ssh_url: "git@forgejo.test:reviewer/project.git",
                          default_branch: "main",
                        },
                  ),
                ),
              );
            },
          }),
        ),
      );
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "https://forgejo.test/reviewer/project/pulls/42",
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["branch", "--show-current"],
        })).stdout.trim(),
        "pulls/42",
      );
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      for (const args of [
        ["checkout", "main"],
        ["branch", "-f", "pulls/42", "main"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd, args });
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "uncommitted work\n");
      yield* provider.checkoutChangeRequest({ cwd, reference: "42" });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        base,
      );
      assert.strictEqual(yield* fs.exists(path.join(cwd, "feature.txt")), false);
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "42",
        force: true,
        context: {
          provider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://forgejo.test" },
          remoteName: "origin",
          remoteUrl: "git@forgejo.test:maria/project.git",
        },
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "base.txt")),
        "uncommitted work\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      assert.deepStrictEqual(fetched, [source, source, "git@forgejo.test:reviewer/project.git"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
