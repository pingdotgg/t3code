import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type GitCommandFailureReason,
  type ProjectCloneExistingDestination,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitCommandError = Schema.is(GitCommandError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly existingDestination?: ProjectCloneExistingDestination | undefined;
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  // English progress without overriding LC_CTYPE, which a global post-checkout hook inherits.
  LANGUAGE: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            (isSourceControlProviderError(cause)
              ? SourceControlProvider.userFacingSourceControlDetail(cause.cause)
              : undefined) ?? "The source control operation could not be completed.",
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

// Redact credentials from client clone snapshots; git still receives the credentials.
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

function redactUrlCredentials(text: string): string {
  return text
    .replace(QUOTED_URL_QUERY, "$1$2$1")
    .replace(URL_QUERY, "$1")
    .replace(URL_WITH_USERINFO, "$1");
}

// The remote already exists after push failure; advise fixing access and pushing.
// Use fixed text and provider URLs because git stderr can expose credentials.
function publishPushFailureDetail(input: {
  readonly urls: SourceControlRepositoryCloneUrls;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly reason: GitCommandFailureReason | undefined;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.url}`;
  const usesSsh = input.remoteUrl === input.urls.sshUrl;
  switch (input.reason) {
    case "authentication_failed":
      return usesSsh
        ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
        : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
    case "host_key_unverified":
      return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
    default:
      return `${created}. Fix the problem, then push again.`;
  }
}

/**
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

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

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

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

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(
    function* (input: SourceControlRepositoryLookupInput) {
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
    },
    // Someone adding or cloning a repository is waiting, so a background rate-limit pause must not
    // refuse the lookup.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string, existingDestination?: ProjectCloneExistingDestination) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (existingDestination) {
          const info = yield* fileSystem.lstat(normalizedDestination);
          const realDestination = yield* fileSystem.realPath(normalizedDestination);
          const home = yield* HostProcess.HomeDirectory;
          const protectedPaths = [home, config.cwd, config.baseDir];
          const containsProtectedPath = protectedPaths.some((protectedPath) => {
            const relative = path.relative(realDestination, path.resolve(protectedPath));
            return (
              relative === "" ||
              (!relative.startsWith(`..${path.sep}`) &&
                relative !== ".." &&
                !path.isAbsolute(relative))
            );
          });
          if (
            info.type !== "Directory" ||
            containsProtectedPath ||
            realDestination.split(path.sep).some((segment) => segment.toLowerCase() === ".git")
          ) {
            return yield* new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("unknown"),
              detail:
                "Choose a project folder, outside the home folder and running server directories.",
            });
          }
        }
        if (entries.length > 0 && !existingDestination) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
            reason: "destination_exists",
          });
        }
      } else {
        // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
        const parentPath = path.dirname(normalizedDestination);
        if (!(yield* fileSystem.exists(parentPath))) {
          yield* fileSystem.makeDirectory(parentPath, { recursive: true });
        }
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const preparedDestination = yield* prepareDestination(
      input.destinationPath,
      options?.existingDestination,
    );
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

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

    if (options?.existingDestination && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\\]+:)/i.test(remoteUrl)) {
      remoteUrl = path.resolve(
        preparedDestination.parentPath,
        expandHomePath(remoteUrl, yield* HostProcess.HomeDirectory),
      );
    }

    if (
      options?.existingDestination === "combine" &&
      (yield* fileSystem.exists(path.join(preparedDestination.destinationPath, ".git")))
    ) {
      const remote = yield* git.execute({
        operation: "SourceControlRepositoryService.combineRepository",
        cwd: preparedDestination.destinationPath,
        args: ["remote", "get-url", "origin"],
      });
      const protocol = cloneUrlProtocol(remoteUrl);
      const existingRemote = redactRemoteUrl(
        protocol
          ? (cloneUrlForProtocol(remote.stdout.trim(), protocol) ?? remote.stdout.trim())
          : remote.stdout.trim(),
      );
      const expectedRemote = redactRemoteUrl(remoteUrl);
      const matches = protocol
        ? existingRemote.replace(/(?:\.git)?\/$|\.git$/, "") ===
          expectedRemote.replace(/(?:\.git)?\/$|\.git$/, "")
        : existingRemote === expectedRemote;
      if (!matches) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: input.provider ?? SourceControlProviderKind.make("unknown"),
          detail:
            "This folder belongs to a different repository. Choose another folder or Replace.",
        });
      }
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git mixes progress and diagnostics on stderr; retain non-progress tail lines for failure details.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    // Git misreads @ in a pathless URL's query as userinfo and echoes its suffix as the host.
    const normalizedCloneUrl = cloneUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", normalizedCloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
  });

  const overlayDestination = Effect.fn("SourceControlRepositoryService.overlayDestination")(
    function* (
      source: string,
      target: string,
    ): Effect.fn.Return<void, PlatformError.PlatformError> {
      const sourceInfo = yield* fileSystem.lstat(source);
      const targetInfo = yield* fileSystem.lstat(target).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (sourceInfo.type === "Directory" && targetInfo?.type === "Directory") {
        for (const entry of yield* fileSystem.readDirectory(source)) {
          yield* overlayDestination(path.join(source, entry), path.join(target, entry));
        }
        yield* fileSystem.chmod(target, sourceInfo.mode);
      } else {
        yield* fileSystem.remove(target, { recursive: true, force: true });
        yield* fileSystem
          .copy(source, target, { preserveTimestamps: true })
          .pipe(Effect.uninterruptible);
      }
    },
  );

  const cloneIntoExistingDestination = Effect.fn(
    "SourceControlRepositoryService.cloneIntoExistingDestination",
  )(function* (
    input: SourceControlCloneRepositoryInput,
    prepared: SourceControlPreparedClone,
    options: SourceControlCloneOptions,
  ): Effect.fn.Return<
    SourceControlCloneRepositoryResult,
    | SourceControlRepositoryError
    | SourceControlProviderError
    | GitCommandError
    | PlatformError.PlatformError
  > {
    const destination = prepared.destinationPath;
    if (
      options.existingDestination === "combine" &&
      (yield* fileSystem.exists(path.join(destination, ".git")))
    ) {
      return { cwd: destination, remoteUrl: prepared.remoteUrl, repository: prepared.repository };
    }
    const temporary = yield* fileSystem.makeTempDirectory({
      directory: path.dirname(destination),
      prefix: ".t3-clone-",
    });
    const staging = path.join(temporary, "checkout");
    const backup = path.join(temporary, "previous");
    return yield* Effect.gen(function* () {
      const result = yield* cloneRepository(
        { ...input, remoteUrl: prepared.cloneUrl, destinationPath: staging },
        {
          ...options,
          existingDestination: undefined,
        },
      );
      if (options.existingDestination === "combine" && (yield* fileSystem.exists(destination))) {
        yield* overlayDestination(destination, staging);
      }
      // Keep the original until the completed checkout is installed, including on cancellation.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const exists = yield* fileSystem.exists(destination);
          if (exists) yield* fileSystem.rename(destination, backup);
          yield* fileSystem.rename(staging, destination).pipe(
            Effect.tapError(() =>
              exists
                ? fileSystem.rename(backup, destination).pipe(
                    Effect.mapError(
                      (cause) =>
                        new SourceControlRepositoryError({
                          operation: "cloneRepository",
                          provider: input.provider ?? SourceControlProviderKind.make("unknown"),
                          detail: `Could not restore the destination. The original folder is saved at ${backup}.`,
                          cause,
                        }),
                    ),
                  )
                : Effect.void,
            ),
          );
        }),
      );
      yield* fileSystem.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore);
      return { ...result, cwd: destination };
    }).pipe(
      Effect.ensuring(
        // A failed rollback leaves `previous` available for recovery.
        fileSystem.remove(staging, { recursive: true, force: true }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (!(yield* fileSystem.exists(backup))) {
                yield* fileSystem.remove(temporary, { recursive: true });
              }
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input, options);
    if (options?.existingDestination) {
      return yield* cloneIntoExistingDestination(input, prepared, options);
    }
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const remoteUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.remoteUrl),
      // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - The condition also narrows httpsUrl for the fallback closure.
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              Effect.as(redactRemoteUrl(httpsUrl)),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only .git-bearing partial clones may be deleted; other files arrived after the empty-directory check.
    // Missing destinations are already discarded; other read failures must refuse removal.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // Preserve the workspace directory after removing partial contents; retry while interrupted git closes files.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
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

      // Empty repos cannot push HEAD; report partial success because the remote already exists.
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

      const push = (pushUrl: string) =>
        git.pushCurrentBranch(input.cwd, null, { remoteName }).pipe(
          Effect.map((result) => ({ branch: result.branch, remoteUrl: pushUrl })),
          Effect.mapError(
            (cause) =>
              new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: publishPushFailureDetail({
                  urls,
                  remoteName,
                  remoteUrl: pushUrl,
                  reason: cause.reason,
                }),
                cause,
              }),
          ),
        );

      // Like clone, an auto-selected SSH remote switches to HTTPS when SSH is refused;
      // otherwise the remote keeps failing every later fetch and push.
      const canSwitchToHttps = input.protocol !== "ssh" && remoteUrl === urls.sshUrl;
      const pushed = yield* push(remoteUrl).pipe(
        Effect.catchIf(
          (error) => canSwitchToHttps && isSshRejection(error),
          (sshError) =>
            git
              .execute({
                operation: "SourceControlRepositoryService.publishRepository.switchToHttps",
                cwd: input.cwd,
                args: ["remote", "set-url", remoteName, urls.url],
              })
              .pipe(
                Effect.mapError(() => sshError),
                Effect.andThen(push(urls.url)),
              ),
        ),
      );

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl: pushed.remoteUrl,
        branch: pushed.branch,
        status: "pushed" as const,
      };
    },
  );

  // Forwarders retain the underlying operation spans.
  return SourceControlRepositoryService.of({
    lookupRepository: Effect.fnUntraced(function* (input) {
      return yield* lookupRepository(input).pipe(
        mapRepositoryError("lookupRepository", input.provider),
      );
    }),
    prepareClone: Effect.fnUntraced(function* (input, options) {
      return yield* prepareClone(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    cloneRepository: Effect.fnUntraced(function* (input, options) {
      return yield* cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    discardClone: Effect.fnUntraced(function* (destinationPath) {
      return yield* discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      );
    }),
    publishRepository: Effect.fnUntraced(function* (input) {
      return yield* publishRepository(input).pipe(
        mapRepositoryError("publishRepository", input.provider),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
