import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import { lookupExtensionRepository } from "../extensions/repositoryLookup.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

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

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly process?: Partial<VcsProcess.VcsProcess["Service"]>;
  readonly github?: Partial<GitHubCli.GitHubCli["Service"]>;
  readonly gitlab?: Partial<GitLabCli.GitLabCli["Service"]>;
  readonly forgejo?: Partial<ForgejoCli.ForgejoCli["Service"]>;
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const registryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver["Service"]),
    resolve:
      input.resolve ??
      (() =>
        Effect.succeed({
          kind: "git",
          repository: {
            kind: "git",
            rootPath: "/repo",
            metadataPath: null,
            freshness: {
              source: "live-local" as const,
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: driver as unknown as VcsDriver.VcsDriver["Service"],
        })),
  });

  const processLayer = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput("")),
    ...input.process,
  });

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        registryLayer,
        processLayer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)({}),
        Layer.mock(GitHubCli.GitHubCli)(input.github ?? {}),
        Layer.mock(GitLabCli.GitLabCli)(input.gitlab ?? {}),
        Layer.mock(ForgejoCli.ForgejoCli)({
          listLogins: () => Effect.succeed([]),
          ...input.forgejo,
        }),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get("github");

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("includes the request cwd when an unregistered provider is used", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ remotes: [] });
    const provider = yield* registry.get("unknown");

    const error = yield* provider
      .getChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "getChangeRequest");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "#42");
  }),
);

it.effect("retains VCS detection failures with structured cwd context", () =>
  Effect.gen(function* () {
    const cause = new VcsRepositoryDetectionError({
      operation: "resolve",
      cwd: "/repo",
      detail: "raw VCS detection failure",
      cause: new Error("raw nested failure"),
    });
    const registry = yield* makeRegistry({
      remotes: [],
      resolve: () => Effect.fail(cause),
    });

    const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "detectProvider");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.detail, "Failed to detect source control provider.");
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes(cause.message), false);
  }),
);

it.effect("routes GitLab remotes to the GitLab provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("routes authenticated self-hosted GitLab remotes without relying on host naming", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://self-hosted.example.test/group/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
              { exitCode: ChildProcessSpawner.ExitCode(1) },
            ),
          ),
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("refines the caller-selected remote instead of choosing another configured remote", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:fork/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(`self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
`),
          ),
      },
    });

    const handle = yield* registry.resolveHandle({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown",
          name: "self-hosted.example.test",
          baseUrl: "https://self-hosted.example.test",
        },
        remoteName: "upstream",
        remoteUrl: "https://self-hosted.example.test/group/project.git",
      },
    });

    assert.strictEqual(handle.context?.provider.kind, "gitlab");
    assert.strictEqual(handle.context?.remoteName, "upstream");
  }),
);

it.effect("routes authenticated self-hosted GitLab remotes on non-standard ports", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://self-hosted.example.test:8443/group/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `self-hosted.example.test:8443
  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user
  ✓ Token found: ******
`,
            ),
          ),
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("routes Bitbucket remotes to the Bitbucket provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@bitbucket.org:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "bitbucket");
  }),
);

it.effect("routes Azure DevOps remotes to the Azure DevOps provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect("falls back to a non-origin remote when origin is not configured", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "upstream", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect(
  "routes linked subjects by URL independently of the checkout and skips unsupported links",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        remotes: [{ name: "origin", url: "https://github.com/unrelated/checkout.git" }],
        github: {
          execute: () =>
            Effect.succeed(processOutput(JSON.stringify({ title: "GitHub issue", body: null }))),
        },
        gitlab: {
          execute: () =>
            Effect.succeed(
              processOutput(JSON.stringify({ title: "GitLab MR", description: "Nested project" })),
            ),
        },
      });
      for (const [url, expected] of [
        ["https://github.com/team/project/issues/1", { title: "GitHub issue", body: null }],
        [
          "https://gitlab.com/team/sub/project/-/merge_requests/2",
          { title: "GitLab MR", body: "Nested project" },
        ],
      ] as const) {
        const lookup = registry.resolveLink({ cwd: "/unrelated", url: new URL(url) });
        assert.ok(lookup);
        assert.deepStrictEqual(yield* lookup, expected);
      }
      for (const url of [
        "https://example.test/team/project/issues/1",
        "https://github.attacker.test/team/project/issues/1",
        "https://gitlab.attacker.test/team/project/-/issues/1",
        "https://github.com/team/project",
        "https://codeberg.org/team/project/issues/1",
        "https://bitbucket.org/team/project/pull-requests/1",
        "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
        "http://github.com/team/project/issues/1",
        "https://user:secret@github.com/team/project/issues/1",
      ]) {
        assert.strictEqual(
          registry.resolveLink({ cwd: "/unrelated", url: new URL(url) }),
          undefined,
        );
      }
    }).pipe(Effect.scoped),
);

it.effect("probes only the requested provider and retains every authenticated GitHub host", () =>
  Effect.gen(function* () {
    const commands: unknown[] = [];
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            return processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                hosts: {
                  "ghe.corp": [{ state: "success", active: true, host: "ghe.corp", login: "alex" }],
                  "github.com": [
                    { state: "success", active: true, host: "github.com", login: "alex" },
                  ],
                  "logged-out.corp": [
                    { state: "error", active: true, host: "logged-out.corp", login: "alex" },
                  ],
                },
              }),
              { exitCode: ChildProcessSpawner.ExitCode(1) },
            );
          }),
      },
    });
    assert.deepStrictEqual(yield* registry.repositoryHosts("github"), ["ghe.corp", "github.com"]);
    assert.deepStrictEqual(commands, [
      { command: "gh", args: ["auth", "status", "--json", "hosts"] },
    ]);
  }),
);
it.effect("retains every authenticated GitLab host without probing other providers", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: (input) =>
          Effect.sync(() => {
            commands.push(input.command);
            return processOutput(
              "first.corp\n  Logged in to first.corp as alex\ngitlab.corp\n  Logged in to gitlab.corp as alex\nsigned-out.corp\n  Not logged in",
            );
          }),
      },
    });
    assert.deepStrictEqual(yield* registry.repositoryHosts("gitlab"), [
      "first.corp",
      "gitlab.corp",
    ]);
    assert.deepStrictEqual(commands, ["glab"]);
  }),
);
it.effect("retains Forgejo HTTP origins and ports from authenticated tea status", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: (input) =>
          Effect.sync(() => {
            commands.push(input.command);
            return processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  name: "local",
                  url: "http://forgejo.lan:3000",
                  user: "alex",
                  default: "true",
                  valid: "true",
                },
                {
                  name: "other",
                  url: "https://forgejo.corp",
                  user: "alex",
                  default: "false",
                  valid: "true",
                },
                {
                  name: "out",
                  url: "https://signed-out.corp",
                  user: "alex",
                  default: "false",
                  valid: "false",
                },
              ]),
            );
          }),
      },
    });
    assert.deepStrictEqual(yield* registry.repositoryHosts("forgejo"), [
      "http://forgejo.lan:3000",
      "https://forgejo.corp",
    ]);
    assert.deepStrictEqual(commands, ["tea"]);
  }),
);
it.effect(
  "uses the authenticated Azure CLI organization for legacy and on-prem host authority",
  () =>
    Effect.gen(function* () {
      for (const organization of ["https://org.visualstudio.com", "https://ado.corp/collection"]) {
        const commands: unknown[] = [];
        const registry = yield* makeRegistry({
          remotes: [],
          process: {
            run: (input) =>
              Effect.sync(() => {
                commands.push({ command: input.command, args: input.args });
                return processOutput(
                  input.args[0] === "account"
                    ? "alex"
                    : `[defaults]\norganization = ${organization}\nproject = p`,
                );
              }),
          },
        });
        assert.deepStrictEqual(yield* registry.repositoryHosts("azure-devops"), [
          "dev.azure.com",
          organization,
        ]);
        assert.deepStrictEqual(commands, [
          { command: "az", args: ["account", "show", "--query", "user.name", "-o", "tsv"] },
          { command: "az", args: ["devops", "configure", "--list"] },
        ]);
      }
    }),
);

it.effect("uses the resolved Forgejo default login origin without host probes", () =>
  Effect.gen(function* () {
    for (const hostile of [false, true]) {
      let probes = 0;
      let lookups = 0;
      const registry = yield* makeRegistry({
        remotes: [],
        process: {
          run: () =>
            Effect.sync(() => {
              probes++;
              return processOutput("");
            }),
        },
        forgejo: {
          resolveRepository: () =>
            Effect.succeed({
              command: "tea",
              login: "local",
              baseUrl: "http://forgejo.lan:3000",
              repository: "o/n",
            }),
          api: () =>
            Effect.sync(() => {
              lookups++;
              return processOutput(
                hostile
                  ? '{"full_name":"o/n","clone_url":"https://attacker.tld/o/n","ssh_url":"git@attacker.tld:o/n.git"}'
                  : '{"full_name":"o/n","clone_url":"http://forgejo.lan:3000/o/n","ssh_url":"git@forgejo.lan:o/n.git"}',
              );
            }),
        },
      });
      const result = yield* Effect.exit(
        lookupExtensionRepository(registry, {
          provider: "forgejo",
          repository: "o/n",
          cwd: "/host",
        }),
      );
      assert.strictEqual(result._tag, hostile ? "Failure" : "Success");
      assert.strictEqual(lookups, 1);
      assert.strictEqual(probes, 0);
    }
  }),
);
