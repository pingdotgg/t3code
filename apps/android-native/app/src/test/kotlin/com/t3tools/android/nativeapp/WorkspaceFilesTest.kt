package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.WorkspaceEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceFilesTest {
  @Test
  fun resolves_workspace_file_paths_for_server_assets() {
    assertEquals("/repo/assets/logo.png", resolveWorkspaceFilePath("/repo", "assets/logo.png"))
    assertEquals("C:\\repo\\assets\\logo.png", resolveWorkspaceFilePath("C:\\repo", "assets/logo.png"))
    assertEquals("/tmp/logo.png", resolveWorkspaceFilePath("/repo", "/tmp/logo.png"))
  }

  @Test
  fun builds_sorted_tree_and_only_flattens_expanded_directories() {
    val tree = buildWorkspaceTree(
      listOf(
        WorkspaceEntry("README.md", "file"),
        WorkspaceEntry("src/z.kt", "file"),
        WorkspaceEntry("src/a.kt", "file"),
        WorkspaceEntry("assets", "directory"),
      ),
    )

    assertEquals(listOf("assets", "src", "README.md"), tree.map(WorkspaceTreeNode::path))
    assertEquals(
      listOf("assets", "src", "src/a.kt", "src/z.kt", "README.md"),
      visibleWorkspaceNodes(tree, setOf("src")).map { it.node.path },
    )
  }

  @Test
  fun classifies_supported_preview_paths() {
    assertTrue(isImageWorkspacePath("assets/logo.PNG"))
    assertTrue(isMarkdownWorkspacePath("docs/guide.mdx"))
    assertFalse(isImageWorkspacePath("src/App.kt"))
    assertEquals("App.kt", workspaceFileName("src/App.kt"))
  }
}
