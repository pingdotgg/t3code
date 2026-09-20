import * as Effect from "effect/Effect";
import type {
  ChangeRequest,
  ProjectId,
  GitCommandError,
  VcsPanelActionableForkBranch,
  VcsPanelBranchCommitsInput,
  VcsPanelBranchCommitsResult,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelSnapshotResult,
  VcsPanelRemote,
  VcsPanelStashDetails,
  VcsRef,
  ServerProvider,
  SourceControlProviderError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import * as SharedServerSettings from "@t3tools/shared/serverSettings";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { SourceControlWritingPolicyResolver } from "../textGeneration/SourceControlWriting.ts";
import type { ExecuteGitProgress } from "../vcs/GitVcsDriver.ts";
import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import type { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import {
  parseAheadBehindCounts,
  branchActivityTime,
  parseCommits,
  parseCommitsWithStats,
  parseCreatedFromRef,
  parseFileChangesFromNumstat,
  parseNameStatus,
  parseRemoteVerbose,
  providerContextForRemote,
} from "./SourceControlPanelParsers.ts";
import {
  fileChangesRelativeToCwd,
  parseNumstat,
  parsePorcelainStatus,
} from "./SourceControlPanelStatusParsers.ts";

type ConfiguredSourceControlProviderKind = Exclude<SourceControlProviderKind, "unknown">;

function isConfiguredSourceControlProviderKind(
  kind: SourceControlProviderKind,
): kind is ConfiguredSourceControlProviderKind {
  return kind !== "unknown";
}

type Run = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: {
    readonly allowNonZeroExit?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly progress?: ExecuteGitProgress;
  },
) => Effect.Effect<string, GitCommandError>;

export interface SourceControlPanelReaderDependencies {
  readonly run: Run;
  readonly serverSettings: ServerSettingsService["Service"];
  readonly sourceControlProviders: SourceControlProviderRegistry["Service"] | undefined;
  readonly sourceControlRateLimits:
    | SourceControlRateLimit.SourceControlRateLimit["Service"]
    | undefined;
  readonly textGeneration: TextGeneration["Service"] | undefined;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly projectIdForWorkspace?: (
    cwd: string,
  ) => Effect.Effect<ProjectId | null, ProjectionRepositoryError>;
  readonly resolveWritingPolicy: SourceControlWritingPolicyResolver;
}

export function makeSourceControlPanelReaders(deps: SourceControlPanelReaderDependencies) {
  const {
    run,
    serverSettings,
    sourceControlProviders,
    sourceControlRateLimits,
    textGeneration,
    getProviders,
    resolveWritingPolicy,
  } = deps;
  const COMMIT_PAGE_SIZE = 10;

  // A registered linked worktree owns its settings; otherwise use the main checkout's project.
  const writingSettingsFor = Effect.fn("SourceControlPanelReaders.writingSettingsFor")(function* (
    cwd: string,
  ) {
    const settings = yield* serverSettings.getSettings;
    const lookup = deps.projectIdForWorkspace;
    if (!lookup || !hasProjectSettingsOverrides(settings)) return settings;
    const projectId = yield* Effect.gen(function* () {
      const direct = yield* lookup(cwd);
      if (direct !== null) return direct;
      const root = (yield* run("vcs.panel.writingWorkspaceRoot", cwd, [
        "rev-parse",
        "--show-toplevel",
      ])).trim();
      if (root && root !== cwd) {
        const project = yield* lookup(root);
        if (project !== null) return project;
      }
      const worktrees = yield* run("vcs.panel.writingWorktrees", cwd, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      const first = worktrees.split("\0")[0];
      const mainRoot = first?.startsWith("worktree ") ? first.slice(9) : null;
      return mainRoot && mainRoot !== cwd && mainRoot !== root ? yield* lookup(mainRoot) : null;
    }).pipe(Effect.orElseSucceed(() => null));
    return resolveProjectSettings(settings, projectId).settings;
  });

  const protectProviderRequest = <A>(
    context: SourceControlProvider.SourceControlProviderContext,
    effect: Effect.Effect<A, SourceControlProviderError>,
  ) =>
    sourceControlRateLimits === undefined
      ? effect
      : SourceControlRateLimit.protectProviderRequest({
          limits: sourceControlRateLimits,
          provider: context.provider.kind,
          baseUrl: context.provider.baseUrl,
          effect,
        });

  const readWorkingTreeChangeGroups = (
    cwd: string,
  ): Effect.Effect<
    {
      readonly porcelain: string;
      readonly unstagedNumstat: string;
      readonly prefix: string;
      readonly changeGroups: VcsPanelChangeGroup[];
    },
    GitCommandError
  > =>
    Effect.all(
      [
        run("vcs.panel.statusPorcelain", cwd, [
          "-c",
          "status.relativePaths=true",
          "status",
          "--porcelain=2",
          "--branch",
          "-uall",
        ]),
        run("vcs.panel.unstagedNumstat", cwd, [
          "diff",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.stagedNumstat", cwd, [
          "diff",
          "--cached",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.stagedNameStatus", cwd, [
          "diff",
          "--cached",
          "--no-relative",
          "--name-status",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.workingTreePrefix", cwd, ["rev-parse", "--show-prefix"]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([porcelain, unstagedNumstat, stagedNumstat, stagedNameStatus, prefixOutput]) => {
        const prefix = prefixOutput.replace(/\r?\n$/u, "");
        const stagedFiles = fileChangesRelativeToCwd(
          parseFileChangesFromNumstat({
            numstat: stagedNumstat,
            statuses: parseNameStatus(stagedNameStatus),
          }),
          prefix,
        );
        return {
          porcelain,
          unstagedNumstat,
          prefix,
          changeGroups: parsePorcelainStatus({
            status: porcelain,
            stagedFiles,
            stagedStats: parseNumstat(stagedNumstat, prefix),
            unstagedStats: parseNumstat(unstagedNumstat, prefix),
            untrackedStats: new Map(),
          }),
        };
      }),
    );

  const changeGroupsHaveFiles = (groups: readonly VcsPanelChangeGroup[]) =>
    groups.some((group) => group.files.length > 0);

  const commitFiles = (cwd: string, sha: string) =>
    Effect.all(
      [
        run("vcs.panel.commitNumstat", cwd, [
          "show",
          "--format=",
          "--numstat",
          "-z",
          "--find-renames",
          sha,
        ]),
        run("vcs.panel.commitNameStatus", cwd, [
          "show",
          "--format=",
          "--name-status",
          "-z",
          "--find-renames",
          sha,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
    );

  const commitRefsBySha = (cwd: string, commits: VcsPanelSnapshotResult["recentCommits"]) => {
    const commitShas = new Set(commits.map((commit) => commit.sha));
    if (commitShas.size === 0) {
      return Effect.succeed(
        new Map<
          string,
          { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
        >(),
      );
    }

    return run("vcs.panel.commitRefs", cwd, [
      "for-each-ref",
      "--format=%(objectname)%09%(*objectname)%09%(refname:short)%09%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]).pipe(
      Effect.map((output) => {
        const refs = new Map<
          string,
          { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
        >();
        for (const line of output.split(/\r?\n/u)) {
          const [objectName, peeledObjectName, shortRefName, fullRefName] = line.split("\t");
          const sha = peeledObjectName || objectName;
          if (!sha || !shortRefName || !fullRefName || !commitShas.has(sha)) continue;
          if (shortRefName.endsWith("/HEAD") || shortRefName.includes(" -> ")) continue;
          if (fullRefName.startsWith("refs/remotes/") && !shortRefName.includes("/")) continue;

          const current = refs.get(sha) ?? { headRefs: [], tags: [] };
          if (fullRefName.startsWith("refs/tags/")) {
            refs.set(sha, {
              headRefs: current.headRefs,
              tags: [...current.tags, shortRefName].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            });
            continue;
          }
          refs.set(sha, {
            headRefs: [...current.headRefs, shortRefName].toSorted((left, right) =>
              left.localeCompare(right),
            ),
            tags: current.tags,
          });
        }
        return refs;
      }),
      Effect.orElseSucceed(
        () =>
          new Map<
            string,
            { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
          >(),
      ),
    );
  };

  const commitAvatarProviderContexts = (cwd: string) => {
    if (!sourceControlProviders) {
      return Effect.succeed<ReadonlyArray<SourceControlProvider.SourceControlProviderContext>>([]);
    }

    return Effect.all({
      settings: serverSettings.getSettings,
      remotes: run("vcs.panel.commitAvatarRemotes", cwd, ["remote", "-v"]),
    }).pipe(
      Effect.map(({ settings, remotes }) =>
        parseRemoteVerbose(remotes)
          .map(providerContextForRemote)
          .filter(
            (context): context is SourceControlProvider.SourceControlProviderContext =>
              context !== null,
          )
          .filter(
            (context) =>
              isConfiguredSourceControlProviderKind(context.provider.kind) &&
              context.provider.kind !== "forgejo" &&
              settings.sourceControl.providers[context.provider.kind]?.showCommitAuthorAvatar ===
                true,
          ),
      ),
      Effect.orElseSucceed(() => []),
    );
  };

  const providerAvatarUrlForCommit = (
    cwd: string,
    registry: SourceControlProviderRegistry["Service"],
    contexts: ReadonlyArray<SourceControlProvider.SourceControlProviderContext>,
    commit: VcsPanelSnapshotResult["recentCommits"][number],
  ) =>
    Effect.gen(function* () {
      for (const context of contexts) {
        const provider = yield* registry
          .get(context.provider.kind)
          .pipe(Effect.orElseSucceed(() => null));
        if (!provider) continue;
        const avatarUrl = yield* protectProviderRequest(
          context,
          provider.getCommitAvatarUrl({
            cwd,
            context,
            sha: commit.sha,
            authorEmail: commit.authorEmail,
          }),
        ).pipe(Effect.orElseSucceed(() => null));
        if (avatarUrl) return avatarUrl;
      }
      return null;
    });

  const withCommitAvatars = (cwd: string, commits: VcsPanelSnapshotResult["recentCommits"]) => {
    if (commits.length === 0 || !sourceControlProviders) {
      return Effect.succeed(commits);
    }

    const registry = sourceControlProviders;
    return commitAvatarProviderContexts(cwd).pipe(
      Effect.flatMap((contexts) => {
        if (contexts.length === 0) {
          return Effect.succeed(commits);
        }

        // Required and intended behavior: commit rows should show the source-control
        // provider account avatar image when the provider exposes one. `null` is only
        // the initials fallback path; do not replace this with generated avatars.
        return Effect.forEach(
          commits,
          (commit) =>
            providerAvatarUrlForCommit(cwd, registry, contexts, commit).pipe(
              Effect.map((authorAvatarUrl) =>
                authorAvatarUrl ? { ...commit, authorAvatarUrl } : commit,
              ),
            ),
          { concurrency: 4 },
        );
      }),
      Effect.orElseSucceed(() => commits),
    );
  };

  const withCommitDetails = (
    cwd: string,
    commits: VcsPanelSnapshotResult["recentCommits"],
    deferFiles = false,
  ) =>
    withCommitAvatars(cwd, commits).pipe(
      Effect.flatMap((withAvatars) =>
        commitRefsBySha(cwd, withAvatars).pipe(
          Effect.flatMap((refs) =>
            Effect.forEach(
              withAvatars,
              (commit) => {
                const summary = {
                  ...commit,
                  ...(refs.get(commit.sha) ?? { headRefs: [], tags: [] }),
                };
                // Older clients expect files inline and do not know the detail endpoint.
                return deferFiles
                  ? Effect.succeed({ ...summary, files: [], filesDeferred: true })
                  : commitFiles(cwd, commit.sha).pipe(
                      Effect.orElseSucceed(() => []),
                      Effect.map((files) => ({ ...summary, files })),
                    );
              },
              { concurrency: 2 },
            ),
          ),
        ),
      ),
    );

  const parseCount = (value: string) => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const countCommitsForRange = (cwd: string, range: string) =>
    run("vcs.panel.branchCommitCount", cwd, ["rev-list", "--count", range]).pipe(
      Effect.map(parseCount),
      Effect.orElseSucceed(() => 0),
    );

  const countAheadBehindForRefs = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkAheadBehind", cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${leftRef}...${rightRef}`,
    ]).pipe(
      Effect.map(parseAheadBehindCounts),
      Effect.orElseSucceed(() => ({ aheadCount: 0, behindCount: 0 })),
    );

  const refsShareAncestry = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkMergeBase", cwd, ["merge-base", leftRef, rightRef], {
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const actionableForkBranches = (
    cwd: string,
    localBranches: readonly VcsRef[],
    remotes: readonly VcsPanelRemote[],
  ): Effect.Effect<readonly VcsPanelActionableForkBranch[], never> => {
    const uniqueForks = (
      forks: readonly VcsPanelActionableForkBranch[],
    ): readonly VcsPanelActionableForkBranch[] => {
      const byKey = new Map<string, VcsPanelActionableForkBranch>();
      for (const fork of forks) {
        const key = `${fork.localBranchName}\0${fork.remoteRefName}`;
        const existing = byKey.get(key);
        if (!existing || fork.behindCount > existing.behindCount) {
          byKey.set(key, fork);
        }
      }
      return [...byKey.values()].toSorted((left, right) => {
        const activity = branchActivityTime(right) - branchActivityTime(left);
        return activity !== 0
          ? activity
          : `${left.remoteName}/${left.remoteBranchName}`.localeCompare(
              `${right.remoteName}/${right.remoteBranchName}`,
            );
      });
    };

    const candidates =
      remotes.length < 2
        ? []
        : localBranches.flatMap((localBranch) =>
            remotes.flatMap((remote) =>
              remote.branches
                .filter((remoteBranch) => remoteBranch.name === localBranch.name)
                .filter((remoteBranch) => localBranch.upstreamName !== remoteBranch.fullRefName)
                .map((remoteBranch) => ({ localBranch, remote, remoteBranch })),
            ),
          );
    const sameNameForks = Effect.forEach(
      candidates,
      ({ localBranch, remote, remoteBranch }) =>
        Effect.gen(function* () {
          const shareAncestry = yield* refsShareAncestry(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (!shareAncestry) return null;
          const counts = yield* countAheadBehindForRefs(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (counts.behindCount <= 0) return null;
          const fork = {
            localBranchName: localBranch.name,
            remoteName: remote.name,
            remoteBranchName: remoteBranch.name,
            remoteRefName: remoteBranch.fullRefName,
            aheadCount: counts.aheadCount,
            behindCount: counts.behindCount,
          };
          return {
            ...fork,
            ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
          } satisfies VcsPanelActionableForkBranch;
        }),
      { concurrency: 4 },
    ).pipe(Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))));

    const pullRequestForks = Effect.forEach(
      remotes,
      (remote) => {
        const context = providerContextForRemote(remote);
        if (!context || !sourceControlProviders) {
          return Effect.succeed<readonly VcsPanelActionableForkBranch[]>([]);
        }

        return sourceControlProviders.get(context.provider.kind).pipe(
          Effect.flatMap((provider) =>
            protectProviderRequest(
              context,
              provider.listChangeRequests({
                cwd,
                context,
                state: "open",
                limit: Math.min(500, Math.max(100, localBranches.length * 2)),
              }),
            ),
          ),
          Effect.flatMap((changeRequests) =>
            Effect.forEach(
              changeRequests,
              (changeRequest) => {
                const localBranch = localBranches.find(
                  (branch) => branch.name === changeRequest.headRefName,
                );
                return localBranch
                  ? actionableForkForChangeRequest(cwd, localBranch, remote, changeRequest)
                  : Effect.succeed(null);
              },
              { concurrency: 4 },
            ),
          ),
          Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))),
          Effect.orElseSucceed(() => []),
        );
      },
      { concurrency: 2 },
    ).pipe(Effect.map((forks) => forks.flat()));

    return Effect.all([sameNameForks, pullRequestForks], { concurrency: "unbounded" }).pipe(
      Effect.map(([forks, prForks]) => uniqueForks([...forks, ...prForks])),
      Effect.orElseSucceed(() => []),
    );
  };

  const actionableForkForChangeRequest = (
    cwd: string,
    localBranch: VcsRef,
    remote: VcsPanelRemote,
    changeRequest: ChangeRequest,
  ): Effect.Effect<VcsPanelActionableForkBranch | null, never> => {
    if (changeRequest.headRefName !== localBranch.name) return Effect.succeed(null);
    const remoteBranch = remote.branches.find(
      (branch) => branch.name === changeRequest.baseRefName,
    );
    if (!remoteBranch) return Effect.succeed(null);

    return Effect.gen(function* () {
      const shareAncestry = yield* refsShareAncestry(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (!shareAncestry) return null;
      const counts = yield* countAheadBehindForRefs(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (counts.behindCount <= 0) return null;
      const fork = {
        localBranchName: localBranch.name,
        remoteName: remote.name,
        remoteBranchName: remoteBranch.name,
        remoteRefName: remoteBranch.fullRefName,
        aheadCount: counts.aheadCount,
        behindCount: counts.behindCount,
      };
      return {
        ...fork,
        ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
      } satisfies VcsPanelActionableForkBranch;
    }).pipe(Effect.orElseSucceed(() => null));
  };

  const commitShasForRange = (cwd: string, range: string) =>
    run("vcs.panel.branchCommitShas", cwd, ["rev-list", range]).pipe(
      Effect.map((output) =>
        output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
      Effect.orElseSucceed(() => []),
    );

  const commitsForRange = (
    cwd: string,
    range: string,
    maxCount: number,
    skip = 0,
    deferFiles = false,
  ): Effect.Effect<VcsPanelSnapshotResult["recentCommits"], GitCommandError> =>
    run(
      "vcs.panel.branchCommits",
      cwd,
      [
        "log",
        ...(deferFiles ? ["--shortstat"] : []),
        `--skip=${skip}`,
        `--max-count=${maxCount}`,
        "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
        range,
      ],
      { env: { LC_ALL: "C", LANG: "C" } },
    ).pipe(
      Effect.map(deferFiles ? parseCommitsWithStats : parseCommits),
      Effect.flatMap((commits) => withCommitDetails(cwd, commits, deferFiles)),
    );

  const branchCommits = (
    cwd: string,
    branch: VcsRef,
    baseRef: string | null | undefined,
    kind: VcsPanelBranchCommitsInput["kind"],
    skip: number,
    limit: number,
    deferFiles = false,
  ): Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError> =>
    Effect.gen(function* () {
      const refName = branch.name;
      const historyRef = yield* branchCommitRange(baseRef ?? null, refName, kind ?? "history");
      if (!historyRef) {
        return {
          commits: [],
          remaining: 0,
        };
      }
      const [total, commits] = yield* Effect.all(
        [
          countCommitsForRange(cwd, historyRef),
          commitsForRange(cwd, historyRef, limit, skip, deferFiles),
        ],
        { concurrency: "unbounded" },
      );
      return {
        commits,
        remaining: Math.max(0, total - skip - commits.length),
      };
    });

  const stashDetails = (
    cwd: string,
    stashRef: string,
  ): Effect.Effect<VcsPanelStashDetails, GitCommandError> =>
    Effect.all(
      [
        run("vcs.panel.stashNumstat", cwd, [
          "stash",
          "show",
          "--numstat",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
        run("vcs.panel.stashNameStatus", cwd, [
          "stash",
          "show",
          "--name-status",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
      Effect.orElseSucceed(() => []),
      Effect.map((files) => ({
        refName: stashRef,
        files,
      })),
    );

  const generatedStashMessage = (
    cwd: string,
    mode: "all" | "staged" | "unstaged",
    paths?: readonly string[],
  ): Effect.Effect<string, never> =>
    Effect.gen(function* () {
      const fallback = `T3 Code ${mode} stash`;
      const diffArgs =
        mode === "staged"
          ? (["diff", "--cached", "--stat"] as const)
          : mode === "all"
            ? (["diff", "HEAD", "--stat"] as const)
            : (["diff", "--stat"] as const);
      const patchArgs =
        mode === "staged"
          ? (["diff", "--cached", "--no-ext-diff", "--patch", "--minimal"] as const)
          : mode === "all"
            ? (["diff", "HEAD", "--no-ext-diff", "--patch", "--minimal"] as const)
            : (["diff", "--no-ext-diff", "--patch", "--minimal"] as const);
      const pathArgs = paths && paths.length > 0 ? (["--", ...paths] as const) : [];
      const literalPathspecArgs =
        paths && paths.length > 0 ? (["--literal-pathspecs"] as const) : [];
      const [settings, providers, summary, patch, status] = yield* Effect.all(
        [
          writingSettingsFor(cwd),
          getProviders,
          run("vcs.panel.stashMessageSummary", cwd, [
            ...literalPathspecArgs,
            ...diffArgs,
            ...pathArgs,
          ]),
          run("vcs.panel.stashMessagePatch", cwd, [
            ...literalPathspecArgs,
            ...patchArgs,
            ...pathArgs,
          ]),
          run("vcs.panel.stashMessageStatus", cwd, [
            ...literalPathspecArgs,
            "status",
            "--short",
            ...pathArgs,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      const stagedSummary = [summary.trim(), status.trim()].filter(Boolean).join("\n");
      if (!textGeneration) return fallback;
      if (stagedSummary.length === 0 && patch.trim().length === 0) return fallback;
      const modelSelection = SharedServerSettings.resolveSourceControlWriterModelSelection(
        settings,
        providers,
      );
      const policy = yield* resolveWritingPolicy(cwd, {
        modelSelection,
        providers,
        style: settings.sourceControlWritingStyle,
      });
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: stagedSummary.slice(0, 8_000),
        stagedPatch: patch.slice(0, 50_000),
        modelSelection,
        policy,
      });
      return generated.subject.trim() || fallback;
    }).pipe(Effect.orElseSucceed(() => `T3 Code ${mode} stash`));

  const generatedCommitMessage = (
    cwd: string,
    paths?: readonly string[],
    env?: NodeJS.ProcessEnv,
  ): Effect.Effect<string, never> =>
    Effect.gen(function* () {
      const fallback = "T3 Code changes";
      const pathArgs = paths && paths.length > 0 ? (["--", ...paths] as const) : [];
      const literalPathspecArgs = pathArgs.length > 0 ? (["--literal-pathspecs"] as const) : [];
      const commandOptions = env ? { env } : undefined;
      const [settings, providers, summary, patch] = yield* Effect.all(
        [
          writingSettingsFor(cwd),
          getProviders,
          run(
            "vcs.panel.commitMessageSummary",
            cwd,
            [...literalPathspecArgs, "diff", "--cached", "--stat", ...pathArgs],
            commandOptions,
          ),
          run(
            "vcs.panel.commitMessagePatch",
            cwd,
            [
              ...literalPathspecArgs,
              "diff",
              "--cached",
              "--no-ext-diff",
              "--patch",
              "--minimal",
              ...pathArgs,
            ],
            commandOptions,
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (!textGeneration) return fallback;
      if (summary.trim().length === 0 && patch.trim().length === 0) return fallback;
      const modelSelection = SharedServerSettings.resolveSourceControlWriterModelSelection(
        settings,
        providers,
      );
      const policy = yield* resolveWritingPolicy(cwd, {
        modelSelection,
        providers,
        style: settings.sourceControlWritingStyle,
      });
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: summary.slice(0, 8_000),
        stagedPatch: patch.slice(0, 50_000),
        modelSelection,
        policy,
      });
      return generated.subject.trim() || fallback;
    }).pipe(Effect.orElseSucceed(() => "T3 Code changes"));

  const compareFiles = (cwd: string, baseRef: string | null, refName: string) => {
    if (!baseRef) return Effect.succeed([]);
    return Effect.all(
      [
        run("vcs.panel.branchCompareNumstat", cwd, [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          `${baseRef}...${refName}`,
        ]),
        run("vcs.panel.branchCompareNameStatus", cwd, [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          `${baseRef}...${refName}`,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
      Effect.orElseSucceed(() => []),
    );
  };

  const branchCommitRange = (
    baseRef: string | null,
    refName: string,
    kind: NonNullable<VcsPanelBranchCommitsInput["kind"]>,
  ) => {
    switch (kind) {
      case "ahead":
        return Effect.succeed(baseRef ? `${baseRef}..${refName}` : "");
      case "behind":
        return Effect.succeed(baseRef ? `${refName}..${baseRef}` : "");
      case "compare-history":
        return Effect.succeed(baseRef ? `${baseRef}...${refName}` : refName);
      case "history":
        return Effect.succeed(refName);
    }
  };

  const upstreamForRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchUpstream", cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${refName}@{upstream}`,
    ]).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
      Effect.map((value) => (value.length > 0 ? value : null)),
    );

  const refExists = (operation: string, cwd: string, refName: string) =>
    run(operation, cwd, ["show-ref", "--verify", refName], { allowNonZeroExit: true }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const createdFromRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchCreatedFrom", cwd, [
      "reflog",
      "show",
      "--format=%gs",
      "--max-count=20",
      refName,
    ]).pipe(
      Effect.map(parseCreatedFromRef),
      Effect.orElseSucceed(() => null),
    );

  const branchDetails = (
    cwd: string,
    branch: VcsRef,
    defaultCompareRef: string | null,
    compareBaseRef?: string,
    deferFiles = false,
  ): Effect.Effect<VcsPanelBranchDetails, GitCommandError> =>
    Effect.gen(function* () {
      const refName = branch.name;
      const upstreamRef = branch.isRemote ? null : yield* upstreamForRef(cwd, refName);
      const createdBaseRef = upstreamRef ? null : yield* createdFromRef(cwd, refName);
      const baseRef = compareBaseRef ?? upstreamRef ?? createdBaseRef ?? defaultCompareRef;
      const unsyncedBaseRef = branch.isRemote ? null : (upstreamRef ?? defaultCompareRef);
      const historyRef = refName;
      const [
        aheadCommits,
        aheadCommitTotal,
        behindCommits,
        behindCommitTotal,
        totalCommits,
        commits,
        files,
        unsyncedCommitShas,
      ] = yield* Effect.all(
        [
          baseRef
            ? commitsForRange(cwd, `${baseRef}..${refName}`, COMMIT_PAGE_SIZE, 0, deferFiles)
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${baseRef}..${refName}`) : Effect.succeed(0),
          baseRef
            ? commitsForRange(cwd, `${refName}..${baseRef}`, COMMIT_PAGE_SIZE, 0, deferFiles)
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${refName}..${baseRef}`) : Effect.succeed(0),
          countCommitsForRange(cwd, historyRef),
          commitsForRange(cwd, historyRef, COMMIT_PAGE_SIZE, 0, deferFiles),
          compareFiles(cwd, baseRef, refName),
          unsyncedBaseRef
            ? commitShasForRange(cwd, `${unsyncedBaseRef}..${refName}`)
            : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      );
      return {
        name: branch.name,
        fullRefName: branch.name,
        isRemote: branch.isRemote === true,
        remoteName: branch.remoteName ?? null,
        current: branch.current,
        isDefault: branch.isDefault,
        worktreePath: branch.worktreePath,
        upstreamRef,
        baseRef,
        unsyncedCommitShas,
        aheadCommits,
        aheadCommitsRemaining: Math.max(0, aheadCommitTotal - aheadCommits.length),
        behindCommits,
        behindCommitsRemaining: Math.max(0, behindCommitTotal - behindCommits.length),
        compareCommits: [],
        compareCommitsRemaining: 0,
        commits,
        commitsRemaining: Math.max(0, totalCommits - commits.length),
        compareFiles: files,
      };
    });

  return {
    actionableForkBranches,
    actionableForkForChangeRequest,
    commitFiles,
    branchCommits,
    branchDetails,
    changeGroupsHaveFiles,
    generatedCommitMessage,
    generatedStashMessage,
    readWorkingTreeChangeGroups,
    refExists,
    stashDetails,
    upstreamForRef,
    withCommitDetails,
  };
}
