package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerDraftLogicTest {
  @Test
  fun `restored stash appends after existing composer text`() {
    assertEquals("Existing text\n\nRestored text", appendStashedText("Existing text", "Restored text"))
  }

  @Test
  fun `restored stash does not add another separator around a newline`() {
    assertEquals("Existing text\nRestored text", appendStashedText("Existing text\n", "Restored text"))
    assertEquals("Existing text\nRestored text", appendStashedText("Existing text", "\nRestored text"))
  }

  @Test
  fun `restored stash preserves either side when the other is empty`() {
    assertEquals("Restored text", appendStashedText("", "Restored text"))
    assertEquals("Existing text", appendStashedText("Existing text", ""))
  }
}
