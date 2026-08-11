package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveWorkspaceModelTest {
  @Test
  fun `requires both split width and height`() {
    assertFalse(deriveAdaptiveWorkspaceLayout(719f, 800f).usesSplitView)
    assertFalse(deriveAdaptiveWorkspaceLayout(900f, 599f).usesSplitView)
    assertTrue(deriveAdaptiveWorkspaceLayout(720f, 600f).usesSplitView)
  }

  @Test
  fun `clamps the proportional sidebar width`() {
    assertEquals(280f, deriveAdaptiveWorkspaceLayout(720f, 600f).sidebarWidth)
    assertEquals(320f, deriveAdaptiveWorkspaceLayout(1_000f, 700f).sidebarWidth)
    assertEquals(380f, deriveAdaptiveWorkspaceLayout(1_600f, 900f).sidebarWidth)
  }
}
