package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.VcsRef

internal fun canStartWorktreeFromOrigin(baseBranch: String, refs: List<VcsRef>): Boolean {
  val selected = refs.firstOrNull { it.name == baseBranch } ?: return false
  if (selected.isRemote) return selected.remoteName == "origin"
  return refs.any {
    it.isRemote &&
      it.remoteName == "origin" &&
      (it.name == baseBranch || it.name == "origin/$baseBranch")
  }
}

internal fun existingWorktreeRefs(projectRoot: String, refs: List<VcsRef>): List<VcsRef> = refs
  .filter { it.worktreePath != null && it.worktreePath != projectRoot }
  .distinctBy(VcsRef::worktreePath)

internal data class NewTaskRefGroups(
  val worktrees: List<VcsRef>,
  val localBranches: List<VcsRef>,
  val remoteBranches: List<VcsRef>,
)

internal fun groupNewTaskRefs(projectRoot: String, refs: List<VcsRef>) = NewTaskRefGroups(
  worktrees = existingWorktreeRefs(projectRoot, refs),
  localBranches = refs.filter { !it.isRemote && it.worktreePath == null }.distinctBy(VcsRef::name),
  remoteBranches = refs.filter(VcsRef::isRemote).distinctBy(VcsRef::name),
)

internal fun mergeNewTaskRefs(current: List<VcsRef>, incoming: List<VcsRef>): List<VcsRef> =
  (current + incoming).distinctBy(VcsRef::name)

internal fun shouldLoadNewTaskBranches(
  force: Boolean,
  current: NewTaskBranchesUiState,
  environmentId: String,
  projectId: String,
): Boolean {
  if (force) return true
  if (current.environmentId != environmentId || current.projectId != projectId) return true
  return !current.loading && (current.error != null || current.refs.isEmpty())
}
