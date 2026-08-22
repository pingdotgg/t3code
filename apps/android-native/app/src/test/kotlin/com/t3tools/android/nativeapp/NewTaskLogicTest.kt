package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.VcsRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NewTaskLogicTest {
  @Test
  fun `start from origin requires a matching origin ref`() {
    val refs = listOf(
      ref("feature", current = true),
      ref("main"),
      ref("origin/main", isRemote = true, remoteName = "origin", isDefault = true),
    )

    assertFalse(canStartWorktreeFromOrigin("feature", refs))
    assertTrue(canStartWorktreeFromOrigin("main", refs))
    assertTrue(canStartWorktreeFromOrigin("origin/main", refs))
  }

  @Test
  fun `existing worktrees exclude the project checkout`() {
    val refs = listOf(
      ref("main", worktreePath = "/repo"),
      ref("feat/native", worktreePath = "/repo-native"),
    )

    assertEquals(listOf("feat/native"), existingWorktreeRefs("/repo", refs).map(VcsRef::name))
  }

  @Test
  fun `refs are grouped as worktrees then local and remote branches`() {
    val groups = groupNewTaskRefs(
      "/repo",
      listOf(
        ref("main", current = true, worktreePath = "/repo"),
        ref("feat/mobile", worktreePath = "/repo-mobile"),
        ref("local-only"),
        ref("origin/main", isRemote = true, remoteName = "origin"),
      ),
    )

    assertEquals(listOf("feat/mobile"), groups.worktrees.map(VcsRef::name))
    assertEquals(listOf("local-only"), groups.localBranches.map(VcsRef::name))
    assertEquals(listOf("origin/main"), groups.remoteBranches.map(VcsRef::name))
  }

  @Test
  fun `additional ref pages append without duplicates`() {
    val merged = mergeNewTaskRefs(
      listOf(ref("main"), ref("feature-one")),
      listOf(ref("feature-one"), ref("feature-two")),
    )

    assertEquals(listOf("main", "feature-one", "feature-two"), merged.map(VcsRef::name))
  }

  @Test
  fun `branch refs reload after an empty or failed result`() {
    val loaded = NewTaskBranchesUiState("environment-1", "project-1", refs = listOf(ref("main")))
    val empty = loaded.copy(refs = emptyList())
    val failed = empty.copy(error = "failed")

    assertFalse(shouldLoadNewTaskBranches(false, loaded, "environment-1", "project-1"))
    assertTrue(shouldLoadNewTaskBranches(false, empty, "environment-1", "project-1"))
    assertTrue(shouldLoadNewTaskBranches(false, failed, "environment-1", "project-1"))
  }

  private fun ref(
    name: String,
    isRemote: Boolean = false,
    remoteName: String? = null,
    current: Boolean = false,
    isDefault: Boolean = false,
    worktreePath: String? = null,
  ) = VcsRef(name, isRemote, remoteName, current, isDefault, worktreePath)
}
