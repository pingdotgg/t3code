package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.GitActionResult
import com.t3tools.android.protocol.GitStackedAction
import com.t3tools.android.protocol.VcsRef
import com.t3tools.android.protocol.VcsStatus

enum class GitQuickActionKind { RunAction, Pull, OpenPr, Hint }

data class GitQuickAction(
  val label: String,
  val kind: GitQuickActionKind,
  val action: GitStackedAction? = null,
  val hint: String? = null,
) {
  val enabled get() = kind != GitQuickActionKind.Hint
}

data class GitProgressUiState(
  val phase: String,
  val label: String,
  val description: String? = null,
  val output: List<String> = emptyList(),
  val pullRequestUrl: String? = null,
)

data class GitUiState(
  val environmentId: String? = null,
  val threadId: String? = null,
  val cwd: String? = null,
  val projectRoot: String? = null,
  val status: VcsStatus? = null,
  val refs: List<VcsRef> = emptyList(),
  val refsQuery: String = "",
  val refsNextCursor: Int? = null,
  val refsTotalCount: Int = 0,
  val loading: Boolean = false,
  val refsLoading: Boolean = false,
  val operation: String? = null,
  val progress: GitProgressUiState? = null,
  val error: String? = null,
)

data class BranchSelectionTarget(
  val checkoutCwd: String,
  val nextWorktreePath: String?,
  val reuseExistingWorktree: Boolean,
)

fun resolveBranchSelectionTarget(
  projectRoot: String,
  activeWorktreePath: String?,
  ref: VcsRef,
): BranchSelectionTarget {
  ref.worktreePath?.let { worktreePath ->
    return BranchSelectionTarget(
      checkoutCwd = worktreePath,
      nextWorktreePath = worktreePath.takeIf { it != projectRoot },
      reuseExistingWorktree = true,
    )
  }
  val nextWorktreePath = if (activeWorktreePath != null && ref.isDefault) null else activeWorktreePath
  return BranchSelectionTarget(
    checkoutCwd = nextWorktreePath ?: projectRoot,
    nextWorktreePath = nextWorktreePath,
    reuseExistingWorktree = false,
  )
}

fun localBranchName(ref: VcsRef): String {
  if (!ref.isRemote) return ref.name
  val prefix = ref.remoteName?.let { "$it/" } ?: return ref.name
  return ref.name.removePrefix(prefix).ifBlank { ref.name }
}

fun resolveGitQuickAction(status: VcsStatus?, busy: Boolean): GitQuickAction {
  if (busy) return GitQuickAction("Commit", GitQuickActionKind.Hint, hint = "Git action in progress.")
  if (status == null) {
    return GitQuickAction("Commit", GitQuickActionKind.Hint, hint = "Git status is unavailable.")
  }
  if (!status.isRepo) {
    return GitQuickAction("Commit", GitQuickActionKind.Hint, hint = "This workspace is not a Git repository.")
  }
  if (status.refName == null) {
    return GitQuickAction(
      "Commit",
      GitQuickActionKind.Hint,
      hint = "Create and checkout a branch before pushing or opening a PR.",
    )
  }

  val hasOpenPr = status.pullRequest?.state == "open"
  val ahead = status.aheadCount > 0
  val behind = status.behindCount > 0

  if (status.hasWorkingTreeChanges) {
    if (!status.hasUpstream && !status.hasPrimaryRemote) {
      return GitQuickAction("Commit", GitQuickActionKind.RunAction, GitStackedAction.Commit)
    }
    if (hasOpenPr || status.isDefaultRef) {
      return GitQuickAction("Commit & push", GitQuickActionKind.RunAction, GitStackedAction.CommitPush)
    }
    return GitQuickAction(
      "Commit, push & PR",
      GitQuickActionKind.RunAction,
      GitStackedAction.CommitPushPr,
    )
  }

  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote) {
      if (hasOpenPr && !ahead) return GitQuickAction("View PR", GitQuickActionKind.OpenPr)
      return GitQuickAction("Push", GitQuickActionKind.Hint, hint = "Add an origin remote before pushing.")
    }
    if (!ahead) {
      if (hasOpenPr) return GitQuickAction("View PR", GitQuickActionKind.OpenPr)
      return GitQuickAction("Push", GitQuickActionKind.Hint, hint = "No local commits to push.")
    }
    if (hasOpenPr || status.isDefaultRef) {
      return GitQuickAction("Push", GitQuickActionKind.RunAction, GitStackedAction.Push)
    }
    return GitQuickAction("Push & create PR", GitQuickActionKind.RunAction, GitStackedAction.CreatePr)
  }

  if (ahead && behind) {
    return GitQuickAction(
      "Sync branch",
      GitQuickActionKind.Hint,
      hint = "Branch has diverged from upstream. Rebase or merge first.",
    )
  }
  if (behind) return GitQuickAction("Pull", GitQuickActionKind.Pull)
  if (ahead) {
    if (hasOpenPr || status.isDefaultRef) {
      return GitQuickAction("Push", GitQuickActionKind.RunAction, GitStackedAction.Push)
    }
    return GitQuickAction("Push & create PR", GitQuickActionKind.RunAction, GitStackedAction.CreatePr)
  }
  if (hasOpenPr) return GitQuickAction("View PR", GitQuickActionKind.OpenPr)
  return GitQuickAction("Commit", GitQuickActionKind.Hint, hint = "Branch is up to date.")
}

fun requiresDefaultBranchConfirmation(action: GitStackedAction, isDefaultRef: Boolean) =
  isDefaultRef && action != GitStackedAction.Commit

fun sanitizeFeatureBranchName(raw: String): String {
  val normalized = raw.trim().lowercase()
    .replace(Regex("['\"`]+"), "")
    .replace(Regex("^[./\\s_-]+|[./\\s_-]+$"), "")
  val fragment = normalized
    .replace(Regex("[^a-z0-9/_-]+"), "-")
    .replace(Regex("/+"), "/")
    .replace(Regex("-+"), "-")
    .trim('.', '/', '_', '-')
    .take(64)
    .trimEnd('.', '/', '_', '-')
    .ifBlank { "update" }
  return if (fragment.startsWith("feature/")) fragment else "feature/$fragment"
}

fun resolveAutoFeatureBranchName(refs: List<VcsRef>): String {
  val names = refs.mapTo(mutableSetOf()) { it.name.lowercase() }
  val base = "feature/update"
  if (base !in names) return base
  var suffix = 2
  while ("$base-$suffix" in names) suffix += 1
  return "$base-$suffix"
}

fun gitStatusSummary(status: VcsStatus?): String = when {
  status == null -> "Checking status"
  !status.isRepo -> "Not a repository"
  else -> buildList {
    if (status.hasWorkingTreeChanges) add("${status.workingTree.files.size} changed")
    if (!status.hasWorkingTreeChanges && status.aheadCount == 0 && status.behindCount == 0) add("Clean")
    if (status.aheadCount > 0) add("${status.aheadCount} ahead")
    if (status.behindCount > 0) add("${status.behindCount} behind")
    status.pullRequest?.takeIf { it.state == "open" }?.let { add("PR #${it.number}") }
  }.joinToString(" · ")
}

fun GitActionResult.toProgress() = GitProgressUiState(
  phase = "success",
  label = title,
  description = description,
  pullRequestUrl = prUrl,
)
