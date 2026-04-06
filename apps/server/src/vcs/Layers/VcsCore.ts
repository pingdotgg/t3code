import { Effect, Layer } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { JjCore } from "../../jj/Services/JjCore.ts";
import { VcsCore, type VcsCoreShape } from "../Services/VcsCore.ts";
import { detectRepoKind } from "../Utils.ts";

export const VcsCoreLive = Layer.effect(
  VcsCore,
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const jjCore = yield* JjCore;

    const selectCore = (cwd: string) => (detectRepoKind(cwd) === "jj" ? jjCore : gitCore);

    const routed = {
      execute: (input) => selectCore(input.cwd).execute(input),
      status: (input) => selectCore(input.cwd).status(input),
      statusDetails: (cwd) => selectCore(cwd).statusDetails(cwd),
      prepareCommitContext: (cwd, filePaths) =>
        selectCore(cwd).prepareCommitContext(cwd, filePaths),
      commit: (cwd, subject, body, options) => selectCore(cwd).commit(cwd, subject, body, options),
      pushCurrentBranch: (cwd, fallbackBranch) =>
        selectCore(cwd).pushCurrentBranch(cwd, fallbackBranch),
      readRangeContext: (cwd, baseBranch) => selectCore(cwd).readRangeContext(cwd, baseBranch),
      readConfigValue: (cwd, key) => selectCore(cwd).readConfigValue(cwd, key),
      isInsideWorkTree: (cwd) => selectCore(cwd).isInsideWorkTree(cwd),
      listWorkspaceFiles: (cwd) => selectCore(cwd).listWorkspaceFiles(cwd),
      filterIgnoredPaths: (cwd, relativePaths) =>
        selectCore(cwd).filterIgnoredPaths(cwd, relativePaths),
      listBranches: (input) => selectCore(input.cwd).listBranches(input),
      pullCurrentBranch: (cwd) => selectCore(cwd).pullCurrentBranch(cwd),
      createWorktree: (input) => selectCore(input.cwd).createWorktree(input),
      fetchPullRequestBranch: (input) => selectCore(input.cwd).fetchPullRequestBranch(input),
      ensureRemote: (input) => selectCore(input.cwd).ensureRemote(input),
      fetchRemoteBranch: (input) => selectCore(input.cwd).fetchRemoteBranch(input),
      setBranchUpstream: (input) => selectCore(input.cwd).setBranchUpstream(input),
      removeWorktree: (input) => selectCore(input.cwd).removeWorktree(input),
      renameBranch: (input) => selectCore(input.cwd).renameBranch(input),
      createBranch: (input) => selectCore(input.cwd).createBranch(input),
      checkoutBranch: (input) => selectCore(input.cwd).checkoutBranch(input),
      initRepo: (input) => selectCore(input.cwd).initRepo(input),
      listLocalBranchNames: (cwd) => selectCore(cwd).listLocalBranchNames(cwd),
    } satisfies VcsCoreShape;

    return routed;
  }),
);

export const VcsCoreFromGitLive = Layer.effect(
  VcsCore,
  Effect.gen(function* () {
    return yield* GitCore;
  }),
);
