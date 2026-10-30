import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  SourceControlProviderError,
  type SourceControlCloneRepositoryInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
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
    kind: SourceControlProviderKind.make("github"),
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

function layer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const layerService = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
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
    ? layerService.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : layerService.pipe(Layer.provideMerge(NodeServices.layer));
}

const lookupFailingWith = (cause: unknown, detail: string) =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    return yield* service
      .lookupRepository({ provider: SourceControlProviderKind.make("bitbucket"), repository: "x" })
      .pipe(Effect.flip);
  }).pipe(
    Effect.provide(
      layer({
        provider: makeProvider({
          getRepositoryCloneUrls: (input) =>
            Effect.fail(
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("bitbucket"),
                operation: "getRepositoryCloneUrls",
                cwd: input.cwd,
                detail,
                cause,
              }),
            ),
        }),
      }),
    ),
  );

it.effect("tells the user a host's fixed explanation of a failed repository lookup", () =>
  Effect.gen(function* () {
    const error = yield* lookupFailingWith(
      { userFacingDetail: "Repositories are named workspace/repository." },
      "Repositories are named workspace/repository.",
    );
    assert.strictEqual(error.detail, "Repositories are named workspace/repository.");
  }),
);

it.effect("keeps a host's raw response text out of a failed repository lookup", () =>
  Effect.gen(function* () {
    const error = yield* lookupFailingWith(
      new Error("upstream"),
      "<html>internal token=abc</html>",
    );
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
  }),
);

it.effect("clones a looked-up repository after creating missing parent directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const parent = path.join(temporaryDirectory, "missing", "nested");
    const destinationPath = path.join(parent, "t3code");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: SourceControlProviderKind.make("github"), ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"],
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                assert.isTrue(yield* fs.exists(parent).pipe(Effect.orDie));
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["--bare", "source.git"])(
  "clones a local repository named %s as a working tree",
  (repositoryName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-options-" });
      yield* git.execute({
        operation: "test.init",
        cwd: parent,
        args: ["init", "--bare", path.join(parent, repositoryName)],
      });
      const destinationPath = path.join(parent, "checkout");
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const result = yield* service.cloneRepository({
          remoteUrl: repositoryName,
          destinationPath,
        });
        assert.strictEqual(result.cwd, destinationPath);
        assert.isTrue(yield* fs.exists(path.join(destinationPath, ".git")));
      }).pipe(Effect.provide(layer({ git: { execute: git.execute } })));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-clone-options-config-",
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
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
        layer({
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
    assert.strictEqual(
      error.detail,
      "fatal: early EOF fatal: unable to access 'https://github.com/octocat/t3code.git/': could not resolve host",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

function rejectingSsh(
  urls: Array<string>,
  httpsFails: boolean,
  reason: GitCommandError["reason"] = "authentication_failed",
) {
  return {
    execute: (input: GitVcsDriver.ExecuteGitInput) =>
      Effect.gen(function* () {
        const url = input.args.at(-2)!;
        urls.push(url);
        if (url.startsWith("https://") && !httpsFails) return processOutput();
        yield* (
          input.progress?.onStderrLine?.(
            url.startsWith("https://")
              ? "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
              : "git@github.com: Permission denied (publickey).",
          ) ?? Effect.void
        );
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          reason,
          detail: "Git command exited with a non-zero status.",
        });
      }),
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}

const cloneInTemporaryDirectory = (
  git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
  input: Omit<SourceControlCloneRepositoryInput, "destinationPath">,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-clone-fallback-" })
      .pipe(Effect.orDie);
    return yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.cloneRepository({
        ...input,
        destinationPath: path.join(parent, "t3code"),
      });
    }).pipe(Effect.provide(layer({ git }).pipe(Layer.orDie)));
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("retries a clone over HTTPS when the SSH login is refused", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const result = yield* cloneInTemporaryDirectory(rejectingSsh(urls, false), {
      remoteUrl: CLONE_URLS.sshUrl,
    });

    assert.deepStrictEqual(urls, [CLONE_URLS.sshUrl, "https://github.com/octocat/t3code.git"]);
    assert.strictEqual(result.remoteUrl, "https://github.com/octocat/t3code.git");
  }),
);

it.effect("reports both failures when the HTTPS retry fails too", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const error = yield* Effect.flip(
      cloneInTemporaryDirectory(rejectingSsh(urls, true), { remoteUrl: CLONE_URLS.sshUrl }),
    );

    assert.strictEqual(urls.length, 2);
    assert.strictEqual(
      error.detail,
      "git@github.com: Permission denied (publickey). Cloning over HTTPS instead also failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
  }),
);

it.effect.each([
  ["the caller asked for SSH", "ssh", "authentication_failed"],
  ["git failed for another reason", undefined, "remote_unreachable"],
] as const)("does not retry over HTTPS when %s", ([, protocol, reason]) =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    yield* Effect.flip(
      cloneInTemporaryDirectory(rejectingSsh(urls, false, reason), {
        remoteUrl: CLONE_URLS.sshUrl,
        ...(protocol === undefined ? {} : { protocol }),
      }),
    );

    assert.deepStrictEqual(urls, [CLONE_URLS.sshUrl]);
  }),
);

it.effect.each([
  ["a plain token", "s3cret"],
  ["a token with an apostrophe", "s3'cret"],
  ["a token with a double quote", 's3"cret'],
  ["a host-only token with an at sign", "abc@secret"],
  ["an unquoted token with an apostrophe", "s3'cret", true],
  ["an unquoted token with a double quote", 's3"cret', true],
  ["an unquoted URL with an apostrophe in its path", "path-token", true],
] as const)("keeps %s in the query out of a failed clone's error text", ([, token, unquoted]) =>
  Effect.gen(function* () {
    const remote =
      token === "abc@secret"
        ? "https://github.com"
        : token === "path-token"
          ? "https://github.com/octocat/t3code's.git"
          : "https://github.com/octocat/t3code.git";
    const error = yield* Effect.flip(
      cloneInTemporaryDirectory(
        {
          execute: (input) =>
            Effect.gen(function* () {
              const cloneUrl = input.args.at(-2)!;
              // Git treats @ in a pathless URL's query as userinfo, losing the query delimiter.
              const diagnosticUrl =
                cloneUrl === "https://github.com?access_token=abc@secret"
                  ? "https://secret"
                  : cloneUrl;
              yield* (
                input.progress?.onStderrLine?.(
                  unquoted
                    ? `fatal: ${diagnosticUrl}/info/refs not valid: is this a git repository?`
                    : `fatal: unable to access '${diagnosticUrl}/': Could not resolve host: github.com`,
                ) ?? Effect.void
              );
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git",
                cwd: input.cwd,
                detail: "Git command exited with a non-zero status.",
                exitCode: 128,
              });
            }),
        },
        { remoteUrl: `${remote}?access_token=${token}` },
      ),
    );

    assert.strictEqual(
      error.detail,
      unquoted
        ? `fatal: ${remote} not valid: is this a git repository?`
        : `fatal: unable to access '${remote}${token === "abc@secret" ? "/" : ""}': Could not resolve host: github.com`,
    );
  }),
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
        layer({
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

    const replaced = path.join(parent, "replaced");
    yield* fs.writeFileString(replaced, "not a directory");

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.discardClone(partial);
      const error = yield* Effect.flip(service.discardClone(foreign));
      assert.include(error.detail, "not from the clone");
      const replacedError = yield* Effect.flip(service.discardClone(replaced));
      assert.include(replacedError.detail, "could not be inspected");
      yield* service.discardClone(path.join(parent, "missing"));
    }).pipe(Effect.provide(layer({})));

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
    }).pipe(Effect.provide(layer({})));
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
      layer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
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
      provider: SourceControlProviderKind.make("github"),
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      layer({
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

function failingPush(reason?: GitCommandError["reason"]) {
  return {
    pushCurrentBranch: (cwd: string) =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
          command: "git",
          cwd,
          ...(reason === undefined ? {} : { reason }),
          detail: "Git command exited with a non-zero status.",
        }),
      ),
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}

it.effect("explains a rejected SSH push after creating the repository", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        visibility: "private",
        protocol: "ssh",
      }),
    );

    assert.strictEqual(error.operation, "publishRepository");
    assert.strictEqual(
      error.detail,
      'Created octocat/t3code and added it as remote "origin", but the push failed because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "git remote set-url origin https://github.com/octocat/t3code", then push again.',
    );
    assert.instanceOf(error.cause, GitCommandError);
  }).pipe(Effect.provide(layer({ git: failingPush("authentication_failed") }))),
);

// regression: #19219 publishing did not explain why the first push failed
it.effect("says the repository exists when an unclassified publish push fails", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        visibility: "private",
        protocol: "https",
      }),
    );

    assert.strictEqual(
      error.detail,
      'Created octocat/t3code and added it as remote "origin", but the push failed. Fix the problem, then push again.',
    );
  }).pipe(Effect.provide(layer({ git: failingPush() }))),
);

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: SourceControlProviderKind.make("github"),
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: SourceControlProviderKind.make("github"), ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      layer({
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
