package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class LauncherShortcutsTest {
  @Test
  fun moves_reopened_threads_to_the_front_and_keeps_three() {
    val current = listOf(
      shortcut("a", "One"),
      shortcut("b", "Two"),
      shortcut("c", "Three"),
    )

    assertEquals(
      listOf("d", "a", "b"),
      withRecentThreadShortcut(current, shortcut("d", "Four")).map { it.threadId },
    )
    assertEquals(
      listOf("b", "a", "c"),
      withRecentThreadShortcut(current, shortcut("b", "Two updated")).map { it.threadId },
    )
  }

  @Test
  fun preserves_the_previous_title_when_an_update_has_no_title() {
    val result = withRecentThreadShortcut(listOf(shortcut("a", "Named thread")), shortcut("a", ""))

    assertEquals("Named thread", result.single().title)
  }

  private fun shortcut(threadId: String, title: String) = RecentThreadShortcut(
    environmentId = "environment",
    threadId = threadId,
    title = title,
  )
}
