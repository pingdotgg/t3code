package com.t3tools.android.nativeapp

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class DraftContextTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun preserves_project_branch_and_worktree_context() {
    val draft = ComposerDraft(
      text = "Fix the draft row",
      projectId = "project-1",
      branch = "feat/draft-row",
      worktreePath = "/repo-worktrees/feat-draft-row",
      isWorktree = true,
    )

    val restored = json.decodeFromString<ComposerDraft>(
      json.encodeToString(ComposerDraft.serializer(), draft),
    )

    assertEquals(draft, restored)
  }

  @Test
  fun legacy_drafts_default_to_missing_context() {
    val restored = json.decodeFromString<ComposerDraft>("""{"text":"Old draft"}""")

    assertEquals("Old draft", restored.text)
    assertNull(restored.projectId)
    assertNull(restored.branch)
    assertNull(restored.worktreePath)
    assertFalse(restored.isWorktree)
  }
}
