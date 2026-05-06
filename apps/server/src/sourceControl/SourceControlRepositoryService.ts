import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  SourceControlRepositoryError,
  type SourceControlCloneProtocol,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
} from "@forma/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { GitCore } from "../git/Services/GitCore.ts";
import { runProcess } from "../processRunner.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

export interface SourceControlRepositoryServiceShape {
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

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  SourceControlRepositoryServiceShape
>()("forma/source-control/SourceControlRepositoryService") {}

function repositoryError(input: {
  readonly provider: SourceControlProviderKind;
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}): SourceControlRepositoryError {
  return new SourceControlRepositoryError({
    provider: input.provider,
    operation: input.operation,
    detail: input.detail,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: {
    readonly nameWithOwner: string;
    readonly url: string;
    readonly sshUrl: string;
  },
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectCloneUrl(
  repository: SourceControlRepositoryInfo,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "ssh":
      return repository.sshUrl;
    case "https":
      return repository.url;
    case "auto":
      return repository.sshUrl || repository.url;
  }
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function gitProcessError(operation: string, provider: SourceControlProviderKind, cause: unknown) {
  return repositoryError({
    provider,
    operation,
    detail: cause instanceof Error ? cause.message : "Git command failed.",
    cause,
  });
}

const makeService = Effect.gen(function* () {
  const registry = yield* SourceControlProviderRegistry;
  const git = yield* GitCore;

  const lookupRepository: SourceControlRepositoryServiceShape["lookupRepository"] = (input) =>
    registry.get(input.provider).pipe(
      Effect.flatMap((provider) =>
        provider.getRepositoryCloneUrls({
          cwd: input.cwd ?? process.cwd(),
          repository: input.repository,
        }),
      ),
      Effect.map((urls) => toRepositoryInfo(input.provider, urls)),
      Effect.mapError((cause) =>
        Schema.is(SourceControlRepositoryError)(cause)
          ? cause
          : repositoryError({
              provider: input.provider,
              operation: "lookupRepository",
              detail: cause instanceof Error ? cause.message : "Repository lookup failed.",
              cause,
            }),
      ),
    );

  const cloneRepository: SourceControlRepositoryServiceShape["cloneRepository"] = (input) =>
    Effect.gen(function* () {
      const provider = input.provider ?? "unknown";
      let repository: SourceControlRepositoryInfo | null = null;
      let remoteUrl = input.remoteUrl;

      if (!remoteUrl) {
        if (!input.provider || !input.repository) {
          return yield* repositoryError({
            provider,
            operation: "cloneRepository",
            detail: "Provide either a raw remoteUrl or both provider and repository.",
          });
        }
        repository = yield* lookupRepository({
          provider: input.provider,
          repository: input.repository,
        });
        remoteUrl = selectCloneUrl(repository, input.protocol);
      }

      const destinationPath = resolveUserPath(input.destinationPath);
      const parentPath = path.dirname(destinationPath);

      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(parentPath, { recursive: true });
          const existingEntries = await readdir(destinationPath).catch((error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          });
          if (existingEntries !== null && existingEntries.length > 0) {
            throw new Error(`Destination path is not empty: ${destinationPath}`);
          }
        },
        catch: (cause) => gitProcessError("cloneRepository.prepare", provider, cause),
      });

      yield* Effect.tryPromise({
        try: () =>
          runProcess("git", ["clone", "--", remoteUrl, destinationPath], {
            cwd: parentPath,
            timeoutMs: 10 * 60_000,
          }),
        catch: (cause) => gitProcessError("cloneRepository.clone", provider, cause),
      });

      const insideWorkTree = yield* git
        .isInsideWorkTree(destinationPath)
        .pipe(
          Effect.mapError((cause) => gitProcessError("cloneRepository.verify", provider, cause)),
        );
      if (!insideWorkTree) {
        return yield* repositoryError({
          provider,
          operation: "cloneRepository.verify",
          detail: `Clone did not produce a Git working tree at ${destinationPath}.`,
        });
      }

      return {
        cwd: destinationPath,
        remoteUrl,
        repository,
      } satisfies SourceControlCloneRepositoryResult;
    });

  const publishRepository: SourceControlRepositoryServiceShape["publishRepository"] = (input) =>
    Effect.gen(function* () {
      const provider = yield* registry.get(input.provider).pipe(
        Effect.mapError((cause) =>
          repositoryError({
            provider: input.provider,
            operation: "publishRepository.provider",
            detail: cause.detail,
            cause,
          }),
        ),
      );
      const remoteName = input.remoteName ?? "origin";
      const urls = yield* provider
        .createRepository({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        })
        .pipe(
          Effect.mapError((cause) =>
            repositoryError({
              provider: input.provider,
              operation: "publishRepository.createRepository",
              detail: cause.detail,
              cause,
            }),
          ),
        );
      const repository = toRepositoryInfo(input.provider, urls);
      const remoteUrl = selectCloneUrl(repository, input.protocol);
      const branchResult = yield* git
        .execute({
          operation: "SourceControlRepositoryService.currentBranch",
          cwd: input.cwd,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
        })
        .pipe(
          Effect.mapError((cause) =>
            gitProcessError("publishRepository.branch", input.provider, cause),
          ),
        );
      const branch = branchResult.stdout.trim();
      if (branch.length === 0 || branch === "HEAD") {
        return yield* repositoryError({
          provider: input.provider,
          operation: "publishRepository",
          detail: "Cannot publish from detached HEAD.",
        });
      }

      yield* git
        .execute({
          operation: "SourceControlRepositoryService.addRemote",
          cwd: input.cwd,
          args: ["remote", "add", remoteName, remoteUrl],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.void
              : git
                  .execute({
                    operation: "SourceControlRepositoryService.setRemoteUrl",
                    cwd: input.cwd,
                    args: ["remote", "set-url", remoteName, remoteUrl],
                  })
                  .pipe(Effect.asVoid),
          ),
          Effect.mapError((cause) =>
            gitProcessError("publishRepository.remote", input.provider, cause),
          ),
        );

      yield* git
        .execute({
          operation: "SourceControlRepositoryService.push",
          cwd: input.cwd,
          args: ["push", "-u", remoteName, `HEAD:refs/heads/${branch}`],
          timeoutMs: 10 * 60_000,
        })
        .pipe(
          Effect.mapError((cause) =>
            gitProcessError("publishRepository.push", input.provider, cause),
          ),
        );

      return {
        repository,
        remoteName,
        remoteUrl,
        branch,
        upstreamBranch: `${remoteName}/${branch}`,
        status: "pushed",
      } satisfies SourceControlPublishRepositoryResult;
    });

  return SourceControlRepositoryService.of({
    lookupRepository,
    cloneRepository,
    publishRepository,
  });
});

export const SourceControlRepositoryServiceLive = Layer.effect(
  SourceControlRepositoryService,
  makeService,
);
