import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
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

function processOutputWithStdout(stdout: string): GitVcsDriver.ExecuteGitResult {
  return { ...processOutput(), stdout };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const serviceLayer = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
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
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
}

function makeRealGitLayer() {
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(NodeServices.layer),
  );
  return SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(makeProvider()),
      }),
    ),
    Layer.provideMerge(gitLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-real-git-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

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
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/missing/nested/t3code`;
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];
    const lookupCwds: Array<string> = [];
    const provider = makeProvider({
      getRepositoryCloneUrls: (input) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* fs.exists(input.cwd).pipe(Effect.orDie), true);
          lookupCwds.push(input.cwd);
          return CLONE_URLS;
        }),
    });

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
          cwd: `${parent}/missing/nested`,
          args: ["clone", CLONE_URLS.url, "t3code"],
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
          provider,
        }),
      ),
    );
    assert.deepStrictEqual(lookupCwds, [`${parent}/missing/nested`]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers a matching completed clone and rejects unrelated contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-recover-clone-",
    });
    const matchingDestination = `${parent}/matching`;
    const unrelatedDestination = `${parent}/unrelated`;
    const wrongPortDestination = `${parent}/wrong-port`;
    const wrongCaseDestination = `${parent}/wrong-case`;
    const wrongUserDestination = `${parent}/wrong-user`;
    const absoluteSshDestination = `${parent}/absolute-ssh`;
    yield* fs.makeDirectory(matchingDestination);
    yield* fs.makeDirectory(unrelatedDestination);
    yield* fs.makeDirectory(wrongPortDestination);
    yield* fs.makeDirectory(wrongCaseDestination);
    yield* fs.makeDirectory(wrongUserDestination);
    yield* fs.makeDirectory(absoluteSshDestination);
    yield* fs.writeFileString(`${matchingDestination}/README.md`, "matching clone");
    yield* fs.writeFileString(`${unrelatedDestination}/README.md`, "unrelated repository");
    yield* fs.writeFileString(`${wrongPortDestination}/README.md`, "different port");
    yield* fs.writeFileString(`${wrongCaseDestination}/README.md`, "different case");
    yield* fs.writeFileString(`${wrongUserDestination}/README.md`, "different user");
    yield* fs.writeFileString(`${absoluteSshDestination}/README.md`, "absolute SSH path");
    const cloneCalls: Array<ReadonlyArray<string>> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const recovered = yield* service.cloneRepository({
        remoteUrl: CLONE_URLS.url,
        destinationPath: matchingDestination,
      });
      assert.strictEqual(recovered.cwd, matchingDestination);
      assert.deepStrictEqual(cloneCalls, []);

      const mismatch = yield* Effect.flip(
        service.cloneRepository({
          remoteUrl: CLONE_URLS.url,
          destinationPath: unrelatedDestination,
        }),
      );
      assert.strictEqual(
        mismatch.detail,
        "Destination path already exists and is not a clone of the requested repository.",
      );

      for (const [destinationPath, remoteUrl] of [
        [wrongPortDestination, "https://git.example:8444/org/repo.git"],
        [wrongCaseDestination, "https://git.example/org/repo.git"],
        [wrongUserDestination, "bob@git.example:repo.git"],
        [absoluteSshDestination, "git@git.example:repo.git"],
      ] as const) {
        const strictMismatch = yield* Effect.flip(
          service.cloneRepository({ remoteUrl, destinationPath }),
        );
        assert.strictEqual(
          strictMismatch.detail,
          "Destination path already exists and is not a clone of the requested repository.",
        );
      }
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) => {
              if (input.args[0] === "rev-parse") {
                return Effect.succeed(
                  processOutputWithStdout(
                    input.cwd === matchingDestination ? matchingDestination : unrelatedDestination,
                  ),
                );
              }
              if (input.args[0] === "for-each-ref") {
                return Effect.succeed(processOutputWithStdout(input.cwd));
              }
              if (input.args[0] === "status") return Effect.succeed(processOutput());
              cloneCalls.push(input.args);
              return Effect.succeed(processOutput());
            },
            readConfigValue: (cwd) =>
              Effect.succeed(
                cwd === matchingDestination
                  ? CLONE_URLS.url
                  : cwd === wrongPortDestination
                    ? "https://git.example:8443/org/repo.git"
                    : cwd === wrongCaseDestination
                      ? "https://git.example/org/Repo.git"
                      : cwd === wrongUserDestination
                        ? "alice@git.example:repo.git"
                        : cwd === absoluteSshDestination
                          ? "ssh://git@git.example/repo.git"
                          : "https://github.com/acme/other.git",
              ),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers a real completed clone after a lost result and rejects unsafe adoption", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-real-recovery-",
    });
    const sourcePath = `${parent}/source`;
    const otherSourcePath = `${parent}/other-source`;
    const destinationPath = `${parent}/destination`;
    const incompletePath = `${parent}/incomplete`;
    const unrelatedCleanPath = `${parent}/unrelated-clean`;

    const initializeRepository = (cwd: string, contents: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(cwd);
        yield* git.execute({ operation: "test.init", cwd, args: ["init"] });
        yield* git.execute({
          operation: "test.config.email",
          cwd,
          args: ["config", "user.email", "tests@t3.codes"],
        });
        yield* git.execute({
          operation: "test.config.name",
          cwd,
          args: ["config", "user.name", "T3 Tests"],
        });
        yield* fs.writeFileString(`${cwd}/README.md`, contents);
        yield* git.execute({ operation: "test.add", cwd, args: ["add", "README.md"] });
        yield* git.execute({ operation: "test.commit", cwd, args: ["commit", "-m", "initial"] });
      });

    yield* initializeRepository(sourcePath, "source");
    yield* initializeRepository(otherSourcePath, "other source");

    const cloned = yield* service.cloneRepository({ remoteUrl: sourcePath, destinationPath });
    assert.strictEqual(cloned.cwd, destinationPath);

    // Simulate the caller losing the successful clone result before project registration.
    const recovered = yield* service.cloneRepository({ remoteUrl: sourcePath, destinationPath });
    assert.strictEqual(recovered.cwd, destinationPath);

    const unrelated = yield* Effect.flip(
      service.cloneRepository({ remoteUrl: otherSourcePath, destinationPath }),
    );
    assert.strictEqual(
      unrelated.detail,
      "Destination path already exists and is not a clone of the requested repository.",
    );

    yield* initializeRepository(unrelatedCleanPath, "unrelated history");
    yield* git.execute({
      operation: "test.unrelated.remote",
      cwd: unrelatedCleanPath,
      args: ["remote", "add", "origin", sourcePath],
    });
    const unrelatedHistory = yield* Effect.flip(
      service.cloneRepository({ remoteUrl: sourcePath, destinationPath: unrelatedCleanPath }),
    );
    assert.strictEqual(
      unrelatedHistory.detail,
      "Destination path already exists and is not a clone of the requested repository.",
    );

    yield* git.execute({
      operation: "test.incomplete.clone",
      cwd: parent,
      args: ["clone", "--no-checkout", sourcePath, "incomplete"],
    });
    const incomplete = yield* Effect.flip(
      service.cloneRepository({ remoteUrl: sourcePath, destinationPath: incompletePath }),
    );
    assert.strictEqual(
      incomplete.detail,
      "Destination path already exists and is not a clone of the requested repository.",
    );
  }).pipe(Effect.provide(makeRealGitLayer())),
);

it.effect("serializes overlapping clones to one destination and reuses the verified result", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-overlap-clone-",
    });
    const realParent = `${parent}/real`;
    const aliasParent = `${parent}/alias`;
    yield* fs.makeDirectory(realParent);
    yield* fs.symlink(realParent, aliasParent);
    const destinationPath = `${realParent}/t3code`;
    const aliasDestinationPath = `${aliasParent}/t3code`;
    const cloneEntered = yield* Deferred.make<void>();
    const allowClone = yield* Deferred.make<void>();
    let cloneCount = 0;

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const first = yield* Effect.forkChild(
        service.cloneRepository({ remoteUrl: CLONE_URLS.url, destinationPath }),
        { startImmediately: true },
      );
      yield* Deferred.await(cloneEntered);
      const second = yield* Effect.forkChild(
        service.cloneRepository({
          remoteUrl: CLONE_URLS.url,
          destinationPath: aliasDestinationPath,
        }),
        { startImmediately: true },
      );
      yield* Deferred.succeed(allowClone, undefined);
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      assert.deepStrictEqual(
        results.map((result) => result.cwd),
        [destinationPath, aliasDestinationPath],
      );
      assert.strictEqual(cloneCount, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) => {
              if (input.args[0] === "clone") {
                cloneCount += 1;
                return fs
                  .makeDirectory(destinationPath)
                  .pipe(
                    Effect.andThen(fs.writeFileString(`${destinationPath}/README.md`, "cloned")),
                    Effect.andThen(Deferred.succeed(cloneEntered, undefined)),
                    Effect.andThen(Deferred.await(allowClone)),
                    Effect.as(processOutput()),
                    Effect.orDie,
                  );
              }
              if (input.args[0] === "status") return Effect.succeed(processOutput());
              return Effect.succeed(processOutputWithStdout(destinationPath));
            },
            readConfigValue: () => Effect.succeed(CLONE_URLS.url),
          },
        }),
      ),
    );
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
