import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
): SourceControlProvider.SourceControlProvider["Service"] {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly host?: string;
  readonly probe?: () => void;
}) {
  const serviceLayer = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        discover: Effect.sync(() => {
          input.probe?.();
          return [
            {
              kind: input.provider?.kind ?? "github",
              label: "Provider",
              status: "available" as const,
              installHint: "Install the CLI",
              version: Option.none(),
              detail: Option.none(),
              auth: {
                status: "authenticated" as const,
                account: Option.some("alex"),
                host: Option.some(input.host ?? providerHost(input.provider?.kind ?? "github")),
                detail: Option.none(),
              },
            },
          ];
        }),
        repositoryHosts: () =>
          Effect.sync(() => {
            input.probe?.();
            return [];
          }),
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        input.fileSystem ? "/tmp/t3-source-control-repos" : { prefix: "t3-source-control-repos-" },
      ),
    ),
  );

  return input.fileSystem
    ? serviceLayer.pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
}

const providerKinds = ["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const;
const providerHost = (kind: SourceControlProvider.SourceControlProvider["Service"]["kind"]) =>
  ({
    github: "github.com",
    gitlab: "gitlab.com",
    forgejo: "forge.example",
    "azure-devops": "dev.azure.com",
    bitbucket: "bitbucket.org",
    unknown: "unknown",
  })[kind];
const providerUrls = (host: string) => ({
  nameWithOwner: "o/n",
  url: `https://${host}/o/n`,
  sshUrl: `git@${host}:o/n.git`,
});

it.effect.each(providerKinds)("clones a configured %s repository", (kind) => {
  const host = providerHost(kind);
  const urls = providerUrls(host);
  const calls: Parameters<
    SourceControlProvider.SourceControlProvider["Service"]["getRepositoryCloneUrls"]
  >[0][] = [];
  const clones: ReadonlyArray<string>[] = [];
  const provider = makeProvider({
    kind,
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return urls;
      }),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "configured-clone-" });
      const result = yield* service.cloneRepository({
        provider: kind,
        repository: "o/n",
        destinationPath: `${parent}/repo`,
      });
      assert.strictEqual(result.remoteUrl, urls.sshUrl);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(clones, [["clone", "--progress", "--", urls.sshUrl, "repo"]]);
      assert.strictEqual(calls[0]?.host, undefined);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider,
          git: {
            execute: (input) =>
              Effect.sync(() => {
                clones.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    ),
  );
});

it.effect.each(["github", "gitlab"] as const)(
  "leaves trusted native %s enterprise locators unchanged",
  (kind) =>
    Effect.gen(function* () {
      const host = "enterprise.example";
      for (const repository of [
        `${host}/o/n`,
        `https://${host}/o/n`,
        `ssh://${host}/o/n`,
        `git@${host}:o/n`,
        `https://${host}/o/n/`,
      ]) {
        const calls: Parameters<
          SourceControlProvider.SourceControlProvider["Service"]["getRepositoryCloneUrls"]
        >[0][] = [];
        const provider = makeProvider({
          kind,
          getRepositoryCloneUrls: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return providerUrls(host);
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
          const result = yield* service.lookupRepository({ provider: kind, repository });
          assert.strictEqual(result.url, `https://${host}/o/n`);
          assert.strictEqual(calls[0]?.host, undefined);
          assert.strictEqual(calls[0]?.repository, repository);
        }).pipe(Effect.provide(makeLayer({ provider, host })));
      }
    }),
);

it.effect("preserves native scp username behavior from integration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "scp-redaction-" });
      const prepared = yield* service.prepareClone({
        remoteUrl: "private-user@github.com:o/n.git",
        destinationPath: `${parent}/repo`,
      });
      assert.strictEqual(prepared.remoteUrl, "private-user@github.com:o/n.git");
      assert.strictEqual(prepared.cloneUrl, "private-user@github.com:o/n.git");
    }),
  ).pipe(Effect.provide(makeLayer({}))),
);

it.effect("preserves native provider snapshot behavior from integration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "provider-scp-redaction-" });
      const prepared = yield* service.prepareClone({
        provider: "github",
        repository: "o/n",
        destinationPath: `${parent}/repo`,
      });
      assert.strictEqual(prepared.cloneUrl, "private-user@github.com:o/n.git");
      assert.strictEqual(prepared.repository?.sshUrl, "private-user@github.com:o/n.git");
    }),
  ).pipe(
    Effect.provide(
      makeLayer({
        provider: makeProvider({
          getRepositoryCloneUrls: () =>
            Effect.succeed({
              ...providerUrls("github.com"),
              sshUrl: "private-user@github.com:o/n.git",
            }),
        }),
      }),
    ),
  ),
);

it.effect("accepts Azure's fixed SSH endpoint for a configured Azure API host", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({ provider: "azure-devops", repository: "o/n" });
    assert.strictEqual(result.sshUrl, "git@ssh.dev.azure.com:v3/o/p/n");
  }).pipe(
    Effect.provide(
      makeLayer({
        provider: makeProvider({
          kind: "azure-devops",
          getRepositoryCloneUrls: () =>
            Effect.succeed({
              ...providerUrls("dev.azure.com"),
              sshUrl: "git@ssh.dev.azure.com:v3/o/p/n",
            }),
        }),
      }),
    ),
  ),
);

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("preserves provider failures without deriving the repository message from them", () => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    repository: "octocat/t3code",
    detail: "credential token abc123 was rejected",
  });
  const provider = makeProvider({
    getRepositoryCloneUrls: () => Effect.fail(providerCause),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/t3code",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.provider, "github");
    assert.strictEqual(error.operation, "lookupRepository");
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.strictEqual(
      error.message,
      "Source control repository operation lookupRepository failed for github: The source control operation could not be completed.",
    );
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = path.join(parent, "t3code");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports clone progress from git's stderr and keeps its error text on failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-progress-",
    });
    const destinationPath = path.join(parent, "t3code");
    const progress: Array<{ stage: string; percent: number | null; detail: string | null }> = [];

    const stderrLines = [
      "Cloning into 't3code'...",
      "remote: Enumerating objects: 10, done.",
      "Receiving objects:  40% (4/10), 1.00 MiB | 2.00 MiB/s",
      "Receiving objects: 100% (10/10), 2.50 MiB | 2.00 MiB/s, done.",
      "fatal: early EOF",
      "fatal: unable to access 'https://user:s3c@ret@github.com/octocat/t3code.git/': could not resolve host",
    ];
    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* Effect.flip(
        service.cloneRepository(
          { remoteUrl: CLONE_URLS.sshUrl, destinationPath },
          { onProgress: (line) => Effect.sync(() => void progress.push(line)) },
        ),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                for (const line of stderrLines) {
                  yield* input.progress?.onStderrLine?.(line) ?? Effect.void;
                }
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );

    assert.deepStrictEqual(progress, [
      { stage: "counting", percent: null, detail: null },
      { stage: "receiving", percent: 40, detail: "1.00 MiB | 2.00 MiB/s" },
      { stage: "receiving", percent: 100, detail: "2.50 MiB | 2.00 MiB/s" },
    ]);
    // Git echoes the remote in some failures; the credentials must not follow.
    assert.strictEqual(
      error.detail,
      "fatal: early EOF fatal: unable to access 'https://github.com/octocat/t3code.git/': could not resolve host",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("strips embedded credentials from the remote URL it reports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact-" });
    const destinationPath = path.join(parent, "t3code");
    const cloneArgs: Array<ReadonlyArray<string>> = [];
    const result = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.prepareClone({
        remoteUrl: "https://user:s3cret@github.com/octocat/t3code.git",
        destinationPath,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneArgs.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
    assert.equal(result.remoteUrl, "https://github.com/octocat/t3code.git");
    // Git itself still receives the credentials.
    assert.equal(result.cloneUrl, "https://user:s3cret@github.com/octocat/t3code.git");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards only a directory git wrote to", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-discard-" });
    const partial = path.join(parent, "partial");
    yield* fs.makeDirectory(path.join(partial, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(partial, "README.md"), "half");
    const foreign = path.join(parent, "foreign");
    yield* fs.makeDirectory(foreign);
    yield* fs.writeFileString(path.join(foreign, "notes.txt"), "mine");

    // A file where the directory should be must not be removed either.
    const replaced = path.join(parent, "replaced");
    yield* fs.writeFileString(replaced, "not a directory");

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.discardClone(partial);
      const error = yield* Effect.flip(service.discardClone(foreign));
      assert.include(error.detail, "not from the clone");
      const replacedError = yield* Effect.flip(service.discardClone(replaced));
      assert.include(replacedError.detail, "could not be inspected");
      // A destination that never got created is nothing to discard.
      yield* service.discardClone(path.join(parent, "missing"));
    }).pipe(Effect.provide(makeLayer({})));

    // The partial clone is emptied but its directory (the workspace root) stays.
    assert.deepStrictEqual(yield* fs.readDirectory(partial), []);
    assert.deepStrictEqual(yield* fs.readDirectory(foreign), ["notes.txt"]);
    assert.strictEqual(yield* fs.readFileString(replaced), "not a directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("redacts query tokens and userinfo containing '@' from reported URLs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact2-" });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const query = yield* service.prepareClone({
        remoteUrl: "https://github.com/octocat/t3code.git?access_token=s3cret",
        destinationPath: path.join(parent, "a"),
      });
      assert.equal(query.remoteUrl, "https://github.com/octocat/t3code.git");
      const nested = yield* service.prepareClone({
        remoteUrl: "https://user:pa@rt@github.com/octocat/t3code.git",
        destinationPath: path.join(parent, "b"),
      });
      assert.equal(nested.remoteUrl, "https://github.com/octocat/t3code.git");
    }).pipe(Effect.provide(makeLayer({})));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves destination probe failures instead of treating them as missing paths", () => {
  const fileSystemCause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: "/restricted/t3code",
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath: "/restricted/t3code",
      }),
    );

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "cloneRepository");
    assert.strictEqual(error.cause, fileSystemCause);
  }).pipe(
    Effect.provide(
      makeLayer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
      }),
    ),
  );
});

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/t3code", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

const nativeParityCases = [
  { kind: "github", repository: "github.com/o/n", urls: providerUrls("github.com") },
  { kind: "github", repository: "o/n", urls: providerUrls("github.com") },
  {
    kind: "gitlab",
    repository: "g/p",
    urls: { ...providerUrls("gitlab.corp"), sshUrl: "ssh://git@gitlab.corp:2222/g/p.git" },
  },
  {
    kind: "forgejo",
    repository: "o/n",
    urls: { ...providerUrls("forgejo.lan"), url: "http://forgejo.lan:3000/o/n.git" },
  },
  {
    kind: "bitbucket",
    repository: "o/n",
    urls: { ...providerUrls("bitbucket.org"), url: "https://alex@bitbucket.org/o/n.git" },
  },
  {
    kind: "azure-devops",
    repository: "p/r",
    urls: { ...providerUrls("org.visualstudio.com"), sshUrl: "org@vs-ssh.visualstudio.com:p/r" },
  },
] as const;
it.effect.each(nativeParityCases)(
  "preserves integration native lookup for $kind: $repository",
  ({ kind, repository, urls }) => {
    const calls: unknown[] = [];
    let probes = 0;
    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.lookupRepository({
        provider: kind,
        repository: ` ${repository} `,
      });
      assert.deepStrictEqual(result, { provider: kind, ...urls });
      assert.deepStrictEqual(calls, [{ cwd: process.cwd(), repository }]);
      assert.strictEqual(probes, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeProvider({
            kind,
            getRepositoryCloneUrls: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return urls;
              }),
          }),
          host: "discovery-pick.corp",
          probe: () => {
            probes++;
          },
        }),
      ),
    );
  },
);

it.effect.each(nativeParityCases)(
  "preserves integration native clone for $kind: $repository with zero probes",
  ({ kind, repository, urls }) => {
    let probes = 0;
    const clones: ReadonlyArray<string>[] = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "native-clone-parity-" });
        for (const protocol of ["https", "ssh"] as const) {
          const remote = protocol === "https" ? urls.url : urls.sshUrl;
          yield* service.cloneRepository({
            provider: kind,
            repository,
            protocol,
            destinationPath: `${parent}/${protocol}`,
          });
          assert.deepStrictEqual(clones.at(-1), ["clone", "--progress", "--", remote, protocol]);
        }
        assert.strictEqual(probes, 0);
      }),
    ).pipe(
      Effect.provide(
        makeLayer({
          provider: makeProvider({ kind, getRepositoryCloneUrls: () => Effect.succeed(urls) }),
          host: "discovery-pick.corp",
          probe: () => {
            probes++;
          },
          git: {
            execute: (input) =>
              Effect.sync(() => {
                clones.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
  },
);
