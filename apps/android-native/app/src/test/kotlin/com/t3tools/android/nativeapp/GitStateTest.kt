package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.GitStackedAction
import com.t3tools.android.protocol.VcsRef
import com.t3tools.android.protocol.VcsStatus
import com.t3tools.android.protocol.VcsWorkingTree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GitStateTest {
  private fun status(
    changes: Boolean = false,
    ahead: Int = 0,
    behind: Int = 0,
    upstream: Boolean = true,
    remote: Boolean = true,
    default: Boolean = false,
  ) = VcsStatus(
    isRepo = true,
    hasPrimaryRemote = remote,
    isDefaultRef = default,
    refName = "feature/native",
    hasWorkingTreeChanges = changes,
    workingTree = VcsWorkingTree(emptyList(), 0, 0),
    hasUpstream = upstream,
    aheadCount = ahead,
    behindCount = behind,
  )

  @Test
  fun resolves_the_high_value_quick_action_states() {
    assertEquals(GitStackedAction.CommitPushPr, resolveGitQuickAction(status(changes = true), false).action)
    assertEquals(GitStackedAction.Commit, resolveGitQuickAction(status(changes = true, remote = false, upstream = false), false).action)
    assertEquals(GitQuickActionKind.Pull, resolveGitQuickAction(status(behind = 1), false).kind)
    assertEquals(GitStackedAction.CreatePr, resolveGitQuickAction(status(ahead = 1), false).action)
    assertFalse(resolveGitQuickAction(status(ahead = 1, behind = 1), false).enabled)
    assertFalse(resolveGitQuickAction(status(), false).enabled)
  }

  @Test
  fun only_mutating_default_branch_actions_require_confirmation() {
    assertFalse(requiresDefaultBranchConfirmation(GitStackedAction.Commit, true))
    assertTrue(requiresDefaultBranchConfirmation(GitStackedAction.Push, true))
    assertFalse(requiresDefaultBranchConfirmation(GitStackedAction.CommitPushPr, false))
  }

  @Test
  fun sanitizes_and_deduplicates_feature_branch_names() {
    assertEquals("feature/native-git", sanitizeFeatureBranchName(" Native Git "))
    assertEquals("feature/mobile/git", sanitizeFeatureBranchName("mobile/git"))
    assertEquals(
      "feature/update-3",
      resolveAutoFeatureBranchName(
        listOf(
          VcsRef("feature/update", false, null, false, false, null),
          VcsRef("feature/update-2", false, null, false, false, null),
        ),
      ),
    )
  }
}
