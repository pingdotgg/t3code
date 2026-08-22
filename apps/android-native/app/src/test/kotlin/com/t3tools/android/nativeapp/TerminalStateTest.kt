package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.TerminalStatus
import com.t3tools.android.protocol.TerminalSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalStateTest {
  @Test
  fun filters_and_numerically_sorts_sessions_for_one_thread() {
    val sessions = listOf(
      summary("other", "term-1"),
      summary("thread-1", "term-10"),
      summary("thread-1", "term-2"),
      summary("thread-1", "term-1"),
    )

    assertEquals(
      listOf("term-1", "term-2", "term-10"),
      terminalSessionsForThread(sessions, "thread-1").map(TerminalSummary::terminalId),
    )
  }

  @Test
  fun matches_rn_one_shot_control_byte_mapping() {
    assertEquals("\u0003", applyTerminalCtrlModifier("c"))
    assertEquals("\u001b", applyTerminalCtrlModifier("["))
    assertEquals("\u007f", applyTerminalCtrlModifier("?"))
    assertEquals("~", applyTerminalCtrlModifier("~"))
  }

  @Test
  fun consumes_accessory_modifiers_on_android_keyboard_input() {
    assertEquals(
      null to "\u0003",
      consumeTerminalModifier(PendingTerminalModifier.Ctrl, "c"),
    )
    assertEquals(
      null to "\u001bx",
      consumeTerminalModifier(PendingTerminalModifier.Meta, "x"),
    )
    assertEquals(null to "plain", consumeTerminalModifier(null, "plain"))
  }

  @Test
  fun infers_the_same_host_modifier_family_as_rn() {
    assertEquals(TerminalHostPlatform.Mac, inferTerminalHostPlatform("Mac mini"))
    assertEquals(TerminalHostPlatform.Linux, inferTerminalHostPlatform("ubuntu-dev01"))
    assertEquals(TerminalHostPlatform.Windows, inferTerminalHostPlatform("Windows workstation"))
  }

  @Test
  fun returns_the_previous_live_session_after_exit() {
    val sessions = listOf(
      summary("thread-1", "term-1"),
      summary("thread-1", "term-2").copy(status = TerminalStatus.Exited),
      summary("thread-1", "term-3"),
    )

    assertEquals("term-1", previousLiveTerminalId(sessions, "term-2"))
    assertEquals("term-3", previousLiveTerminalId(sessions, "term-1"))
  }

  private fun summary(threadId: String, terminalId: String) = TerminalSummary(
    threadId = threadId,
    terminalId = terminalId,
    cwd = "/repo",
    worktreePath = null,
    status = TerminalStatus.Running,
    pid = 1,
    exitCode = null,
    exitSignal = null,
    hasRunningSubprocess = false,
    label = "zsh",
    updatedAt = "now",
  )
}
