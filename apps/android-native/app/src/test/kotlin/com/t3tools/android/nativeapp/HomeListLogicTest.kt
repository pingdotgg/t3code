package com.t3tools.android.nativeapp

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeListLogicTest {
  @Test
  fun `reveals the top when a draft first appears`() {
    assertTrue(
      shouldRevealHomeListTop(
        HomeListRevealSignal(draftVisible = false),
        HomeListRevealSignal(draftVisible = true),
      ),
    )
  }

  @Test
  fun `reveals the top after this client creates a thread`() {
    assertTrue(
      shouldRevealHomeListTop(
        HomeListRevealSignal(createdThreadRequest = 2),
        HomeListRevealSignal(createdThreadRequest = 3),
      ),
    )
  }

  @Test
  fun `ordinary updates do not move the list`() {
    val unchanged = HomeListRevealSignal(draftVisible = true, createdThreadRequest = 3)

    assertFalse(shouldRevealHomeListTop(unchanged, unchanged))
  }
}
