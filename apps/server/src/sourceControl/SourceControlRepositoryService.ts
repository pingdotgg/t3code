import { redactGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  type ProjectCloneMember,
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type GitCommandFailureReason,
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
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    /**
     * Everything `cloneMultiRepo` checks before running git: the destination
     * is empty, and every member is its own folder inside it.
     */
    readonly prepareMultiRepoClone: (input: {
      readonly destinationPath: string;
      readonly members: ReadonlyArray<ProjectCloneMember>;
    }) => Effect.Effect<SourceControlPreparedMultiRepoClone, SourceControlRepositoryError>;
    /**
     * Clones every member of a multi-repo project in turn, then writes the
     * `.workler` that lists them. Progress details name the member.
     */
    readonly cloneMultiRepo: (
      prepared: SourceControlPreparedMultiRepoClone,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    /** Removes what a partial or failed multi-repo clone left in the destination. */
    readonly discardMultiRepoClone: (
      prepared: SourceControlPreparedMultiRepoClone,
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

export interface SourceControlPreparedMultiRepoClone {
  readonly destinationPath: string;
  readonly members: ReadonlyArray<{
    /** `/`-separated, relative to the destination. */
    readonly path: string;
    /** Credential-free; safe to show and to store in snapshots. */
    readonly remoteUrl: string;
    /** What git is given; may carry embedded credentials. */
    readonly cloneUrl: string;
  }>;
}

export interface SourceControlCloneOptions {
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

const WORKLER_CONFIG_FILE = ".workler";
// Folders Workler manages itself, so they can never be a member.
const RESERVED_MEMBER_FOLDERS = new Set([".git", ".worktrees", WORKLER_CONFIG_FILE]);

/** A member path as Workler accepts it, `/`-separated, or null when it would leave its folder. */
function normalizeMultiRepoMemberPath(raw: string): string | null {
  // `.workler` is one `project <path>` per line with no escapes, so control
  // characters (a newline above all) would leave a broken file behind a finished clone.
  if (/[\u0000-\u001f\u007f]/.test(raw) || /^(?:[a-zA-Z]:|[\\/])/.test(raw)) return null;
  // Workler quotes a path with one kind of quote, so it cannot hold both.
  if (raw.includes('"') && raw.includes("'")) return null;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  if (RESERVED_MEMBER_FOLDERS.has(segments[0]!.toLowerCase())) return null;
  // A repository's own .git folder is never a place for another clone.
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return null;
  return segments.join("/");
}

function memberPathsOverlap(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Quotes a `.workler` path the way Workler writes one. */
function quoteWorklerPath(value: string): string {
  if (!/[\s#"']/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
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
    function* (destinationPath: string, ignoredEntries: ReadonlyArray<string> = []) {
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
        if (entries.some((entry) => !ignoredEntries.includes(entry))) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
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
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
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

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactGitRemoteUrl(remoteUrl),
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
    const provider = input.provider ?? SourceControlProviderKind.make("unknown");
    const timeoutMs = options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs;
    const clone = git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", normalizedCloneUrl, path.basename(destinationPath)],
        // The deadline is applied below so a timeout is reported as one, not as git's last line.
        timeoutMs: null,
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
              provider,
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
    if (timeoutMs === null) return yield* clone;
    // Interrupting the clone closes the scope that owns git, which kills it.
    return yield* clone.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider,
              detail: `The clone timed out after ${Duration.format(Duration.millis(timeoutMs))}.`,
            }),
          ),
      }),
    );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
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

    // A ref list read while the clone ran saw an unborn HEAD and no refs.
    yield* git.invalidateRefs(prepared.destinationPath);
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

  const prepareMultiRepoClone = Effect.fn("SourceControlRepositoryService.prepareMultiRepoClone")(
    function* (input: {
      readonly destinationPath: string;
      readonly members: ReadonlyArray<ProjectCloneMember>;
    }) {
      const members: Array<SourceControlPreparedMultiRepoClone["members"][number]> = [];
      for (const member of input.members) {
        const memberPath = normalizeMultiRepoMemberPath(member.path);
        if (memberPath === null) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: `'${member.path}' is not a folder inside the project.`,
          });
        }
        const overlap = members.find((existing) => memberPathsOverlap(existing.path, memberPath));
        if (overlap) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: `The repositories '${overlap.path}' and '${memberPath}' would share a folder.`,
          });
        }
        members.push({
          path: memberPath,
          remoteUrl: redactGitRemoteUrl(member.remoteUrl),
          cloneUrl: member.remoteUrl,
        });
      }
      // Members clone into subfolders, so Finder's .DS_Store in a folder made in
      // Finder doesn't get in their way.
      const destination = yield* prepareDestination(input.destinationPath, [".DS_Store"]);
      return {
        destinationPath: destination.destinationPath,
        members,
      } satisfies SourceControlPreparedMultiRepoClone;
    },
  );

  const cloneMultiRepo = Effect.fn("SourceControlRepositoryService.cloneMultiRepo")(function* (
    prepared: SourceControlPreparedMultiRepoClone,
    options?: SourceControlCloneOptions,
  ) {
    for (const [index, member] of prepared.members.entries()) {
      const label = `${member.path} (${index + 1}/${prepared.members.length})`;
      const onProgress = options?.onProgress;
      yield* cloneRepository(
        {
          remoteUrl: member.cloneUrl,
          destinationPath: path.join(prepared.destinationPath, member.path),
        },
        {
          ...options,
          ...(onProgress
            ? {
                onProgress: (line) =>
                  onProgress({
                    ...line,
                    detail: line.detail ? `${label} · ${line.detail}` : label,
                  }),
              }
            : {}),
        },
      ).pipe(
        Effect.mapError((error) =>
          isSourceControlRepositoryError(error)
            ? new SourceControlRepositoryError({
                operation: error.operation,
                provider: error.provider,
                detail: `${member.path}: ${error.detail}`,
                cause: error,
              })
            : error,
        ),
      );
    }
    // Written last: until every member is in place the folder is no group.
    yield* fileSystem
      .writeFileString(
        path.join(prepared.destinationPath, WORKLER_CONFIG_FILE),
        prepared.members.map((member) => `project ${quoteWorklerPath(member.path)}\n`).join(""),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("unknown"),
              detail: "The repositories were cloned, but the .workler file could not be written.",
              cause,
            }),
        ),
      );
  });

  const discardMultiRepoClone = Effect.fn("SourceControlRepositoryService.discardMultiRepoClone")(
    function* (prepared: SourceControlPreparedMultiRepoClone) {
      const root = yield* normalizeDestinationPath(prepared.destinationPath);
      // The destination was empty when the clone started, so the .workler is ours.
      yield* fileSystem.remove(path.join(root, WORKLER_CONFIG_FILE), { force: true });
      // Deepest first, so the folders a nested member needed can go as well.
      const members = prepared.members.toSorted((a, b) => b.path.length - a.path.length);
      for (const member of members) {
        let folder = path.join(root, member.path);
        yield* discardClone(folder);
        while (folder !== root && folder.startsWith(root)) {
          const entries = yield* fileSystem
            .readDirectory(folder)
            .pipe(Effect.orElseSucceed(() => null));
          if (entries !== null && entries.length > 0) break;
          // Empty, so recursive only satisfies `rm` for a directory.
          if (entries !== null) yield* fileSystem.remove(folder, { recursive: true });
          folder = path.dirname(folder);
        }
      }
    },
  );

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
          Effect.as(true),
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
    prepareClone: Effect.fnUntraced(function* (input) {
      return yield* prepareClone(input).pipe(
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
    prepareMultiRepoClone: Effect.fn("SourceControlRepositoryService.prepareMultiRepo")((input) =>
      prepareMultiRepoClone(input).pipe(
        mapRepositoryError("cloneRepository", SourceControlProviderKind.make("unknown")),
      ),
    ),
    cloneMultiRepo: Effect.fn("SourceControlRepositoryService.cloneMembers")((input, options) =>
      cloneMultiRepo(input, options).pipe(
        mapRepositoryError("cloneRepository", SourceControlProviderKind.make("unknown")),
      ),
    ),
    discardMultiRepoClone: Effect.fn("SourceControlRepositoryService.discardMembers")((input) =>
      discardMultiRepoClone(input).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    ),
    publishRepository: Effect.fnUntraced(function* (input) {
      return yield* publishRepository(input).pipe(
        mapRepositoryError("publishRepository", input.provider),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
