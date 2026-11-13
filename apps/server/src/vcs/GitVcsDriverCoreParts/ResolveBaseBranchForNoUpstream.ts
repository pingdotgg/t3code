import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { GitCommandError } from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { parseRemoteNamesInGitOrder, parseRemoteRefWithRemoteNames } from "../../git/remoteRefs.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import { DEFAULT_BASE_BRANCH_CANDIDATES, NON_REPOSITORY_REMOTE_STATUS_DETAILS, STATUS_DEFAULT_BRANCH_CACHE_TTL, STATUS_ORIGIN_EXISTS_CACHE_TTL, STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY, STATUS_UPSTREAM_REFRESH_INTERVAL, StatusRemoteRefreshCacheKey, branchBaseConfigKey, branchNameFromHeadRef, gitCommandContext, isMissingGitCwdError, isNonRepositoryGitStderr, isUnbornHeadStderr, legacyBranchBaseConfigKey, parseDefaultBranchFromRemoteHeadRef, parseRemoteFetchUrls, parseUpstreamRefByFirstSeparator, sanitizeRemoteName, statusUpstreamRefreshFailureCooldown } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";

type Deps = Record<never, never> & ExecuteRawPart;

export const installResolveBaseBranchForNoUpstream = Effect.fnUntraced(function* (deps: Deps) {
  const { branchExists, executeGit, executeGitWithStableDiagnostics, fetchRemoteForStatus, normalizeRepositoryPathsCacheKey, path, readCurrentUpstreamRef, resolveCurrentUpstream, resolveRepositoryPaths, runGitStdout, statusRemoteRefreshFailures } = deps;

const defaultBranchCache = yield* Cache.makeWith(
  (gitCommonDir: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
      return yield* executeGit(
        "GitVcsDriver.statusDetails.defaultBranch",
        fetchCwd,
        ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) return null;
          return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
        }),
      );
    }),
  {
    capacity: 2_048,
    timeToLive: Exit.match({
      onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  },
);

const primaryRemoteExistsCache = yield* Cache.makeWith(
  (gitCommonDir: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
      return yield* executeGit(
        "GitVcsDriver.statusDetails.primaryRemoteExists",
        fetchCwd,
        ["--git-dir", gitCommonDir, "remote"],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim().length > 0));
    }),
  {
    capacity: 2_048,
    timeToLive: Exit.match({
      onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  },
);

const invalidateStatusStaticCaches = Effect.fn("GitVcsDriverCore.invalidateStatusStaticCaches")(
  function* (cwd: string, gitCommonDir?: string | null) {
    const commonDir =
      gitCommonDir === undefined
        ? (yield* resolveRepositoryPaths(cwd).pipe(
            Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
          ))?.gitCommonDir
        : gitCommonDir;
    const cacheKey = commonDir ?? normalizeRepositoryPathsCacheKey(cwd);
    yield* Cache.invalidate(defaultBranchCache, cacheKey);
    yield* Cache.invalidate(primaryRemoteExistsCache, cacheKey);
  },
);

const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
  const repositoryPaths = yield* resolveRepositoryPaths(cwd);
  if (repositoryPaths !== null) {
    return repositoryPaths.gitCommonDir;
  }
  return yield* new GitCommandError({
    ...gitCommandContext({
      operation: "GitVcsDriver.resolveGitCommonDir",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    }),
    detail: "Cannot resolve a Git common directory outside a repository.",
  });
});

const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
  `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;

const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
  cacheKey: StatusRemoteRefreshCacheKey,
) {
  return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
    Effect.as(true as const),
  );
});

const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
  capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
  // Cache/back off failed fetches while status uses old refs; repeated mounts must not cause subprocess storms.
  timeToLive: (exit, cacheKey) =>
    Exit.isSuccess(exit)
      ? STATUS_UPSTREAM_REFRESH_INTERVAL
      : statusUpstreamRefreshFailureCooldown(
          statusRemoteRefreshFailures.get(statusRemoteRefreshFailureKey(cacheKey))?.count ?? 1,
        ),
});

const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
  cwd: string,
) {
  const headRef = yield* runGitStdout(
    "GitVcsDriver.refreshStatusUpstreamIfStale.headRef",
    cwd,
    ["symbolic-ref", "--quiet", "HEAD"],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));
  if (headRef.length === 0) return;
  const remoteName = yield* runGitStdout(
    "GitVcsDriver.refreshStatusUpstreamIfStale.upstreamRemote",
    cwd,
    ["for-each-ref", "--format=%(upstream:remotename)", headRef],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));
  // Empty means no upstream; `.` means the upstream is a local branch.
  if (remoteName.length === 0 || remoteName === ".") return;
  const gitCommonDir = yield* resolveGitCommonDir(cwd);
  yield* Cache.get(
    statusRemoteRefreshCache,
    new StatusRemoteRefreshCacheKey({ gitCommonDir, remoteName }),
  ).pipe(Effect.ignore);
});

const resolveDefaultBranchName = (
  cwd: string,
  remoteName: string,
): Effect.Effect<string | null, GitCommandError> =>
  executeGit(
    "GitVcsDriver.resolveDefaultBranchName",
    cwd,
    ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
    { allowNonZeroExit: true },
  ).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) {
        return null;
      }
      return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
    }),
  );

const remoteBranchExists: GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"] = (input) =>
  executeGit(
    "GitVcsDriver.remoteBranchExists",
    input.cwd,
    ["show-ref", "--verify", "--quiet", `refs/remotes/${input.remoteName}/${input.refName}`],
    {
      allowNonZeroExit: true,
    },
  ).pipe(Effect.map((result) => result.exitCode === 0));

const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
  executeGit(
    "GitVcsDriver.remoteExists",
    input.cwd,
    ["remote", "get-url", "--", input.remoteName],
    {
      allowNonZeroExit: true,
    },
  ).pipe(Effect.map((result) => result.exitCode === 0));

const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
  remoteExists({ cwd, remoteName: "origin" });

const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
  runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
    Effect.map(parseRemoteNamesInGitOrder),
  );

const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
  cwd: string,
  branchName: string,
) {
  const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
  const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
  return parsedRemoteRef?.branchName ?? branchName;
});

const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
  if (yield* originRemoteExists(cwd)) {
    return "origin";
  }
  const remotes = yield* listRemoteNames(cwd);
  const [firstRemote] = remotes;
  if (firstRemote) {
    return firstRemote;
  }
  return yield* new GitCommandError({
    ...gitCommandContext({
      operation: "GitVcsDriver.resolvePrimaryRemoteName",
      cwd,
      args: ["remote"],
    }),
    detail: "No git remote is configured for this repository.",
  });
});

const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
  cwd: string,
  refName: string,
) {
  const branchPushRemote = yield* runGitStdout(
    "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
    cwd,
    ["config", "--get", `branch.${refName}.pushRemote`],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));
  if (branchPushRemote.length > 0) {
    return branchPushRemote;
  }

  const pushDefaultRemote = yield* runGitStdout(
    "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
    cwd,
    ["config", "--get", "remote.pushDefault"],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));
  if (pushDefaultRemote.length > 0) {
    return pushDefaultRemote;
  }

  return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
});

const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
  "ensureRemote",
)(function* (input) {
  const preferredName = sanitizeRemoteName(input.preferredName);
  const normalizedTargetUrl = sourceControlDefinitions.repositoryKeyFromRemote(input.url);
  const listRemoteFetchUrls = runGitStdout(
    "GitVcsDriver.ensureRemote.listRemoteUrls",
    input.cwd,
    ["remote", "-v"],
  ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));
  const findMatchingRemote = (remoteFetchUrls: Map<string, string>) =>
    Array.from(remoteFetchUrls.entries()).find(
      ([, remoteUrl]) =>
        sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl) === normalizedTargetUrl,
    )?.[0];

  const remoteFetchUrls = yield* listRemoteFetchUrls;
  const existing = findMatchingRemote(remoteFetchUrls);
  if (existing !== undefined) return existing;

  let remoteName = preferredName;
  let suffix = 1;
  while (remoteFetchUrls.has(remoteName)) {
    remoteName = `${preferredName}-${suffix}`;
    suffix += 1;
  }

  return yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.ensureRemote.add",
    input.cwd,
    ["remote", "add", "--", remoteName, input.url],
    { writesSharedConfig: true },
  ).pipe(
    retryWhileConfigLocked,
    Effect.as(remoteName),
    // A parallel launch for the same fork may have added it since the listing above.
    Effect.catch((error) =>
      listRemoteFetchUrls.pipe(
        Effect.flatMap((current) => {
          const added = findMatchingRemote(current);
          return added === undefined ? Effect.fail(error) : Effect.succeed(added);
        }),
      ),
    ),
  );
});

const resolveComparisonBaseRef = Effect.fn("resolveComparisonBaseRef")(function* (
  cwd: string,
  baseRef: string,
) {
  const comparisonRef =
    baseRef.startsWith("refs/heads/") || baseRef.startsWith("refs/remotes/")
      ? baseRef
      : baseRef.includes("/") && !baseRef.startsWith("refs/")
        ? `refs/remotes/${baseRef}`
        : null;
  if (comparisonRef === null) return null;
  const resolved = yield* executeGit(
    "GitVcsDriver.resolveComparisonBaseRef",
    cwd,
    ["show-ref", "--verify", "--quiet", comparisonRef],
    { allowNonZeroExit: true },
  );
  return resolved.exitCode === 0 ? { baseRef, comparisonRef } : null;
});

const resolveTrackedRemoteBaseRef = Effect.fn("resolveTrackedRemoteBaseRef")(function* (
  cwd: string,
  refName: string,
) {
  const upstream = yield* executeGit(
    "GitVcsDriver.resolveTrackedRemoteBaseRef",
    cwd,
    ["rev-parse", "--symbolic-full-name", `${refName}@{upstream}`],
    { allowNonZeroExit: true },
  );
  const comparisonRef = upstream.stdout.trim();
  if (upstream.exitCode !== 0 || !comparisonRef.startsWith("refs/remotes/")) return null;
  return { baseRef: comparisonRef.slice("refs/remotes/".length), comparisonRef };
});

const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
  cwd: string,
  refName: string,
  options?: {
    readonly allowRemoteOfCurrent?: boolean;
    readonly knownOriginDefaultBranch?: string | null;
  },
) {
  const configuredBaseRef = yield* readConfigValue(cwd, `branch.${refName}.t3-merge-base-ref`);
  if (
    configuredBaseRef?.startsWith("refs/heads/") ||
    configuredBaseRef?.startsWith("refs/remotes/")
  ) {
    const base = yield* resolveComparisonBaseRef(cwd, configuredBaseRef);
    if (base !== null) {
      const shortRef = configuredBaseRef.replace(/^refs\/remotes\//, "");
      return {
        ...base,
        baseRef: (yield* branchExists(cwd, shortRef)) ? configuredBaseRef : shortRef,
      };
    }
  }

  const configuredBaseBranch = (yield* readBranchBase(cwd, refName)) ?? "";
  const configuredBase = yield* resolveComparisonBaseRef(cwd, configuredBaseBranch);
  if (
    configuredBase !== null &&
    configuredBaseBranch.includes("/") &&
    !configuredBaseBranch.startsWith("refs/") &&
    (yield* branchExists(cwd, configuredBaseBranch))
  ) {
    const comparisonRef = `refs/heads/${configuredBaseBranch}`;
    return { baseRef: comparisonRef, comparisonRef };
  }
  if (configuredBase !== null) return configuredBase;

  const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
    Effect.orElseSucceed(() => null),
  );
  const candidates = [
    Effect.succeed(configuredBaseBranch),
    primaryRemoteName === null
      ? Effect.succeed(null)
      : primaryRemoteName === "origin" && options?.knownOriginDefaultBranch != null
        ? Effect.succeed(options.knownOriginDefaultBranch)
        : resolveDefaultBranchName(cwd, primaryRemoteName),
    ...DEFAULT_BASE_BRANCH_CANDIDATES.map(Effect.succeed),
  ];

  for (const readCandidate of candidates) {
    const candidate = yield* readCandidate;
    if (!candidate) {
      continue;
    }

    const remotePrefix =
      primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
    const normalizedCandidate = candidate.startsWith("origin/")
      ? candidate.slice("origin/".length)
      : remotePrefix && candidate.startsWith(remotePrefix)
        ? candidate.slice(remotePrefix.length)
        : candidate;
    if (normalizedCandidate.length === 0) {
      continue;
    }
    if (normalizedCandidate === refName) {
      if (options?.allowRemoteOfCurrent) {
        const trackedRemoteBase = yield* resolveTrackedRemoteBaseRef(cwd, refName);
        if (trackedRemoteBase !== null) return trackedRemoteBase;
        if (
          primaryRemoteName &&
          (yield* remoteBranchExists({
            cwd,
            remoteName: primaryRemoteName,
            refName: normalizedCandidate,
          }))
        ) {
          return {
            baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
            comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
          };
        }
      }
      continue;
    }

    if (
      primaryRemoteName &&
      (yield* remoteBranchExists({
        cwd,
        remoteName: primaryRemoteName,
        refName: normalizedCandidate,
      }))
    ) {
      return {
        baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
        comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
      };
    }

    if (yield* branchExists(cwd, normalizedCandidate)) {
      return { baseRef: normalizedCandidate, comparisonRef: `refs/heads/${normalizedCandidate}` };
    }
  }

  return null;
});

const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
  cwd: string,
  refName: string,
  options?: { readonly knownOriginDefaultBranch: string | null },
) {
  const base = yield* resolveBaseBranchForNoUpstream(cwd, refName, options);
  if (!base) {
    return 0;
  }

  const result = yield* executeGit(
    "GitVcsDriver.computeAheadCountAgainstBase",
    cwd,
    ["rev-list", "--count", "--end-of-options", `${base.comparisonRef}..HEAD`],
    { allowNonZeroExit: true },
  );
  if (result.exitCode !== 0) {
    return 0;
  }

  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
});

const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
  const branchResult = yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.statusDetailsRemote.branch",
    cwd,
    ["rev-parse", "--symbolic-full-name", "HEAD"],
    { allowNonZeroExit: true },
  ).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
    }),
  );

  if (branchResult === null) {
    return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
  }
  let branch: string | null;
  if (branchResult.exitCode !== 0) {
    if (isNonRepositoryGitStderr(branchResult.stderr)) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    if (!isUnbornHeadStderr(branchResult.stderr)) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetailsRemote.branch",
          cwd,
          args: ["rev-parse", "--symbolic-full-name", "HEAD"],
        }),
        detail: "Git branch lookup failed.",
        exitCode: branchResult.exitCode,
        stdoutLength: branchResult.stdout.length,
        stderrLength: branchResult.stderr.length,
      });
    }

    const branchValue = yield* runGitStdout(
      "GitVcsDriver.statusDetailsRemote.unbornBranch",
      cwd,
      ["symbolic-ref", "--quiet", "HEAD"],
    );
    branch = branchNameFromHeadRef(branchValue);
  } else {
    branch = branchNameFromHeadRef(branchResult.stdout);
  }
  const currentUpstreamRef = yield* readCurrentUpstreamRef(cwd);
  let upstreamRef =
    currentUpstreamRef === null
      ? null
      : (parseUpstreamRefByFirstSeparator(currentUpstreamRef)?.upstreamRef ?? null);
  // Trimming a remote that starts with Unicode whitespace can leave a leading slash.
  if (currentUpstreamRef?.startsWith("/")) {
    upstreamRef = (yield* resolveCurrentUpstream(cwd, currentUpstreamRef))?.upstreamRef ?? null;
  }
  let aheadCount = 0;
  let behindCount = 0;

  if (upstreamRef) {
    const divergence = yield* executeGit(
      "GitVcsDriver.statusDetailsRemote.divergence",
      cwd,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { allowNonZeroExit: true },
    );
    if (divergence.exitCode === 0) {
      const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
      const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
      const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
      aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
      behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
    }
  } else if (branch) {
    aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
      Effect.orElseSucceed(() => 0),
    );
  }

  const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
  const isDefaultBranch =
    branch !== null &&
    (branch === defaultBranch ||
      (defaultBranch === null && (branch === "main" || branch === "master")));
  const aheadOfDefaultCount =
    branch && !isDefaultBranch
      ? upstreamRef === null
        ? aheadCount
        : yield* computeAheadCountAgainstBase(cwd, branch, {
            knownOriginDefaultBranch: defaultBranch,
          }).pipe(Effect.orElseSucceed(() => 0))
      : 0;

  return {
    isRepo: true,
    defaultBranch,
    isDefaultBranch,
    branch,
    upstreamRef,
    hasUpstream: upstreamRef !== null,
    aheadCount,
    behindCount,
    aheadOfDefaultCount,
  };
});

const resolveReviewMergeBase = Effect.fn("resolveReviewMergeBase")(function* (
  cwd: string,
  branch: string | null,
  explicitBaseRef?: string,
  knownOriginDefaultBranch: string | null = null,
) {
  const base =
    explicitBaseRef !== undefined
      ? ((yield* resolveComparisonBaseRef(cwd, explicitBaseRef)) ?? {
          baseRef: explicitBaseRef,
          comparisonRef:
            !explicitBaseRef.startsWith("refs/") && (yield* branchExists(cwd, explicitBaseRef))
              ? `refs/heads/${explicitBaseRef}`
              : explicitBaseRef,
        })
      : branch
        ? yield* resolveBaseBranchForNoUpstream(cwd, branch, {
            allowRemoteOfCurrent: true,
            knownOriginDefaultBranch,
          }).pipe(Effect.orElseSucceed(() => null))
        : null;
  if (base === null) return { baseRef: null, mergeBase: "HEAD" };
  const { baseRef, comparisonRef } = base;
  const args = ["merge-base", "--end-of-options", comparisonRef, "HEAD"];
  const result = yield* executeGit("GitVcsDriver.resolveReviewMergeBase", cwd, args, {
    allowNonZeroExit: true,
  });
  const mergeBase = result.stdout.trim();
  if (result.exitCode !== 0 || mergeBase.length === 0) {
    const head = yield* executeGit(
      "GitVcsDriver.resolveReviewMergeBase.head",
      cwd,
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      { allowNonZeroExit: true },
    );
    if (explicitBaseRef === undefined && head.exitCode !== 0) {
      return { baseRef: null, mergeBase: "HEAD" };
    }
    return yield* new GitCommandError({
      ...gitCommandContext({ operation: "GitVcsDriver.resolveReviewMergeBase", cwd, args }),
      detail: `Could not find a common commit between '${baseRef}' and HEAD.`,
      exitCode: result.exitCode,
    });
  }
  return { baseRef, mergeBase };
});

const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
  runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
    Effect.map((stdout) => stdout.trim()),
    Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
  );

const retryWhileConfigLocked = <A>(effect: Effect.Effect<A, GitCommandError>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error.reason === "config_locked",
      times: 10,
      schedule: Schedule.spaced("50 millis"),
    }),
  );

const readBranchBase: GitVcsDriver.GitVcsDriver["Service"]["readBranchBase"] = Effect.fn(
  "GitVcsDriver.readBranchBase",
)(function* (cwd, branch) {
  const base = yield* readConfigValue(cwd, branchBaseConfigKey(branch));
  return base ?? (yield* readConfigValue(cwd, legacyBranchBaseConfigKey(branch)));
});

  return { defaultBranchCache, primaryRemoteExistsCache, invalidateStatusStaticCaches, resolveGitCommonDir, statusRemoteRefreshFailureKey, refreshStatusRemoteCacheEntry, statusRemoteRefreshCache, refreshStatusUpstreamIfStale, resolveDefaultBranchName, remoteBranchExists, remoteExists, originRemoteExists, listRemoteNames, resolvePublishBranchName, resolvePrimaryRemoteName, resolvePushRemoteName, ensureRemote, resolveComparisonBaseRef, resolveTrackedRemoteBaseRef, resolveBaseBranchForNoUpstream, computeAheadCountAgainstBase, readStatusDetailsRemote, resolveReviewMergeBase, readConfigValue, retryWhileConfigLocked, readBranchBase };
});

export type ResolveBaseBranchForNoUpstreamPart = ReturnType<typeof installResolveBaseBranchForNoUpstream> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installResolveBaseBranchForNoUpstream>;
