import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
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
        Layer.mock(ForgejoCli.ForgejoCli)({}),
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
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            if (input.method) {
              writes.push(input);
              return Effect.succeed(processOutput("{}"));
            }
            const path = input.path.split("?")[0]!;
            assert.ok(Object.hasOwn(responses, path), `Unexpected Forgejo request: ${path}`);
            return encodeJsonEffect(responses[path]).pipe(Effect.orDie, Effect.map(processOutput));
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
  }).pipe(
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
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
            "https://code.test/forgejo/api/v1/repos/maria/project/pulls?state=open",
            "https://code.test/forgejo/api/v1/repos/maria/project",
            "https://code.test/forgejo/api/v1/repos/reviewer/project/contents/file.ts",
          ];
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
