import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const cloneOperations = yield* makeKeyedSerialExecutor<string>();

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePathWith(trimmed, path));
    },
  );

  const canonicalDestinationKey = Effect.fn(
    "SourceControlRepositoryService.canonicalDestinationKey",
  )(function* (destinationPath: string) {
    if (yield* fileSystem.exists(destinationPath)) {
      return yield* fileSystem.realPath(destinationPath);
    }

    const suffix = [path.basename(destinationPath)];
    let ancestor = path.dirname(destinationPath);
    while (!(yield* fileSystem.exists(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    return path.join(yield* fileSystem.realPath(ancestor), ...suffix);
  });

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (normalizedDestination: string) {
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        return {
          destinationPath: normalizedDestination,
          parentPath: path.dirname(normalizedDestination),
          directoryName: path.basename(normalizedDestination),
          occupied: entries.length > 0,
        } as const;
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
        occupied: false,
      } as const;
    },
  );

  const isMatchingClone = Effect.fn("SourceControlRepositoryService.isMatchingClone")(function* (
    destinationPath: string,
    remoteUrl: string,
  ) {
    const repositoryRoot = yield* git.execute({
      operation: "SourceControlRepositoryService.cloneRepository.verifyRoot",
      cwd: destinationPath,
      args: ["rev-parse", "--show-toplevel"],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
    const reportedRoot = repositoryRoot.stdout.trim();
    if (reportedRoot.length === 0) return false;
    const [canonicalDestination, canonicalRoot] = yield* Effect.all([
      fileSystem.realPath(destinationPath),
      fileSystem.realPath(reportedRoot),
    ]);
    if (canonicalDestination !== canonicalRoot) return false;
    const existingRemote = yield* git.readConfigValue(destinationPath, "remote.origin.url");
    if (existingRemote === null || existingRemote.trim() !== remoteUrl.trim()) {
      return false;
    }

    // A repository shell with only an origin, or with fetched refs but an
    // unfinished checkout, can be left behind by an interrupted clone.
    const headCommit = yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository.verifyHead",
        cwd: destinationPath,
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim() || null),
        Effect.orElseSucceed(() => null),
      );
    if (headCommit === null) return false;

    const remoteCommits = yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository.verifyRemoteRefs",
        cwd: destinationPath,
        args: ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin"],
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.map((result) => new Set(result.stdout.split("\n").map((line) => line.trim()))),
        Effect.orElseSucceed(() => new Set<string>()),
      );
    if (!remoteCommits.has(headCommit)) return false;

    return yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository.verifyCheckout",
        cwd: destinationPath,
        args: ["status", "--porcelain=v1", "--untracked-files=no"],
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim().length === 0),
        Effect.orElseSucceed(() => false),
      );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const destinationPath = yield* normalizeDestinationPath(input.destinationPath);
    const destinationKey = yield* canonicalDestinationKey(destinationPath);
    return yield* cloneOperations.withLock(
      destinationKey,
      Effect.gen(function* () {
        let repository: SourceControlRepositoryInfo | null = null;
        let remoteUrl = input.remoteUrl?.trim() ?? null;
        let provider: SourceControlProviderKind = input.provider ?? "unknown";

        if (!remoteUrl && !(input.provider && input.repository)) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider,
            detail: "Enter a repository path or clone URL before cloning.",
          });
        }

        const preparedDestination = yield* prepareDestination(destinationPath);

        if (input.provider && input.repository) {
          repository = yield* lookupRepository({
            provider: input.provider,
            repository: input.repository,
            cwd: preparedDestination.parentPath,
          });
          remoteUrl = selectRemoteUrl(repository, input.protocol);
          provider = input.provider;
        }

        if (!remoteUrl) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider,
            detail: "Enter a repository path or clone URL before cloning.",
          });
        }

        if (preparedDestination.occupied) {
          const matches = yield* isMatchingClone(destinationPath, remoteUrl).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!matches) {
            return yield* new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider,
              detail:
                "Destination path already exists and is not a clone of the requested repository.",
            });
          }
          return { cwd: destinationPath, remoteUrl, repository };
        }

        yield* git.execute({
          operation: "SourceControlRepositoryService.cloneRepository",
          cwd: preparedDestination.parentPath,
          args: ["clone", remoteUrl, preparedDestination.directoryName],
          timeoutMs: 120_000,
          maxOutputBytes: 256 * 1024,
        });

        return { cwd: destinationPath, remoteUrl, repository };
      }),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
