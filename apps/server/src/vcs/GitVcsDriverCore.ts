import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  type GitCommandFailureReason,
  T3_PROJECT_FILE_NAME,
  type ReviewBranchCommitsInput,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewInput,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewSource,
  type VcsRef,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeEmptyDirectory } from "./removeEmptyDirectory.ts";
import { explicitBareRepositoryEnv, gitConfigEnv } from "./VcsProcess.ts";
import { removeLinkedWorktree } from "./worktreeRemoval.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

// ---- decomposition ----
export * from "./GitVcsDriverCorePrelude/CreateTrace2Monitor.ts";
export * from "./GitVcsDriverCorePrelude/FetchFailureDetail.ts";

import { installExecuteRaw } from "./GitVcsDriverCoreParts/ExecuteRaw.ts";
import { installResolveBaseBranchForNoUpstream } from "./GitVcsDriverCoreParts/ResolveBaseBranchForNoUpstream.ts";
import { installReadStatusDetailsLocal } from "./GitVcsDriverCoreParts/ReadStatusDetailsLocal.ts";
import { installPushCurrentBranch } from "./GitVcsDriverCoreParts/PushCurrentBranch.ts";
import { installGetReviewDiffPreview } from "./GitVcsDriverCoreParts/GetReviewDiffPreview.ts";
import { installCreateWorktree } from "./GitVcsDriverCoreParts/CreateWorktree.ts";
import { installSwitchRef } from "./GitVcsDriverCoreParts/SwitchRef.ts";

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const ExecuteRaw = yield* installExecuteRaw({});
  const ResolveBaseBranchForNoUpstream = yield* installResolveBaseBranchForNoUpstream({ ...ExecuteRaw });
  const ReadStatusDetailsLocal = yield* installReadStatusDetailsLocal({ ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream });
  const PushCurrentBranch = yield* installPushCurrentBranch({ ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream, ...ReadStatusDetailsLocal });
  const GetReviewDiffPreview = yield* installGetReviewDiffPreview({ ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream, ...ReadStatusDetailsLocal, ...PushCurrentBranch });
  const CreateWorktree = yield* installCreateWorktree({ ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream, ...ReadStatusDetailsLocal, ...PushCurrentBranch, ...GetReviewDiffPreview });
  const SwitchRef = yield* installSwitchRef({ ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream, ...ReadStatusDetailsLocal, ...PushCurrentBranch, ...GetReviewDiffPreview, ...CreateWorktree });
  const { commit, createBranch, createRef, createWorktree, deleteLocalBranch, ensureRemote, execute, fetchRefCommit, fetchRefIntoBranch, fetchRemote, fetchRemoteBranch, fetchRemoteTrackingBranch, fetchWorktreeBaseCommit, getReviewBranchCommits, getReviewDiffFileContents, getReviewDiffPreview, initRepo, initRepoWithListRefsInvalidation, invalidateWorktreeCreationCaches, listLocalBranchNames, listRefs, listWorktreePaths, prepareCommitContext, pruneWorktrees, pullCurrentBranch, pushCurrentBranch, readBranchBase, readConfigValue, readRangeContext, refreshCheckedOutBranch, remoteBranchExists, remoteExists, removeWorktree, renameBranch, resolveBranchName, resolveCommit, resolveDefaultBranchName, resolvePrimaryRemoteName, resolveRemoteTrackingCommit, resolveWorktreeBaseRemote, setBranchUpstream, status, statusDetails, statusDetailsLocal, statusDetailsRemote, switchRef, withListRefsInvalidation, writeConfigValue } = { ...ExecuteRaw, ...ResolveBaseBranchForNoUpstream, ...ReadStatusDetailsLocal, ...PushCurrentBranch, ...GetReviewDiffPreview, ...CreateWorktree, ...SwitchRef };
return GitVcsDriver.GitVcsDriver.of({
  execute,
  status,
  statusDetails,
  statusDetailsLocal,
  statusDetailsRemote,
  prepareCommitContext,
  commit: Effect.fnUntraced(function* (cwd, subject, body, options) {
    return yield* withListRefsInvalidation(cwd, commit(cwd, subject, body, options));
  }),
  pushCurrentBranch: Effect.fnUntraced(function* (cwd, fallbackBranch, options) {
    return yield* withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options));
  }),
  pullCurrentBranch: Effect.fnUntraced(function* (cwd) {
    return yield* withListRefsInvalidation(cwd, pullCurrentBranch(cwd));
  }),
  readRangeContext,
  getReviewBranchCommits,
  getReviewDiffPreview,
  getReviewDiffFileContents,
  readConfigValue,
  readBranchBase,
  resolveBranchName,
  listRefs,
  createWorktree: Effect.fnUntraced(function* (input, options) {
    return yield* createWorktree(input, options).pipe(
      Effect.ensuring(invalidateWorktreeCreationCaches(input.cwd)),
    );
  }),
  fetchRefIntoBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, fetchRefIntoBranch(input));
  }),
  fetchRefCommit,
  resolveCommit,
  refreshCheckedOutBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, refreshCheckedOutBranch(input));
  }),
  ensureRemote: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, ensureRemote(input));
  }),
  resolvePrimaryRemoteName,
  resolveDefaultBranchName,
  fetchRemote: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(
      input.cwd,
      fetchRemote(input).pipe(
        Effect.flatMap((fetched) =>
          fetched
            ? Effect.void
            : fetchRemote({ cwd: input.cwd, remoteName: input.remoteName }).pipe(Effect.asVoid),
        ),
      ),
    );
  }),
  remoteExists,
  remoteBranchExists,
  resolveRemoteTrackingCommit,
  resolveWorktreeBaseRemote,
  fetchWorktreeBaseCommit: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, fetchWorktreeBaseCommit(input));
  }),
  fetchRemoteBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, fetchRemoteBranch(input));
  }),
  fetchRemoteTrackingBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input));
  }),
  setBranchUpstream: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, setBranchUpstream(input));
  }),
  createBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, createBranch(input));
  }),
  writeConfigValue,
  removeWorktree: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, removeWorktree(input));
  }),
  pruneWorktrees: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, pruneWorktrees(input));
  }),
  deleteLocalBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, deleteLocalBranch(input));
  }),
  renameBranch: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, renameBranch(input));
  }),
  createRef: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, createRef(input));
  }),
  switchRef: Effect.fnUntraced(function* (input) {
    return yield* withListRefsInvalidation(input.cwd, switchRef(input));
  }),
  initRepo: initRepoWithListRefsInvalidation,
  listLocalBranchNames,
  listWorktreePaths,
});
});
