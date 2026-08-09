package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.TerminalStatus
import com.t3tools.android.protocol.TerminalSummary

data class TerminalTarget(
  val environmentId: String,
  val threadId: String,
  val terminalId: String,
  val cwd: String,
  val worktreePath: String?,
) {
  val key get() = "$environmentId:$threadId:$terminalId"
}

data class TerminalUiState(
  val target: TerminalTarget? = null,
  val sessions: List<TerminalSummary> = emptyList(),
  val status: TerminalStatus = TerminalStatus.Closed,
  val label: String = "Terminal",
  val hasRunningSubprocess: Boolean = false,
  val cols: Int = 80,
  val rows: Int = 24,
  val loading: Boolean = false,
  val operation: String? = null,
  val error: String? = null,
)

sealed interface TerminalRenderCommand {
  val targetKey: String

  data class Reset(override val targetKey: String, val buffer: String) : TerminalRenderCommand
  data class Append(override val targetKey: String, val data: String) : TerminalRenderCommand
  data class Clear(override val targetKey: String) : TerminalRenderCommand
}

sealed interface TerminalUiEvent {
  data class SessionEnded(val threadId: String, val terminalId: String) : TerminalUiEvent
}

internal fun terminalSessionsForThread(
  sessions: List<TerminalSummary>,
  threadId: String,
) = sessions.filter { it.threadId == threadId }.sortedWith(
  compareBy<TerminalSummary> { terminalNumber(it.terminalId) }
    .thenBy(TerminalSummary::terminalId),
)

internal fun previousLiveTerminalId(
  sessions: List<TerminalSummary>,
  exitedTerminalId: String,
): String? {
  val live = sessions.filter {
    it.terminalId != exitedTerminalId &&
      it.status in setOf(TerminalStatus.Starting, TerminalStatus.Running)
  }.sortedWith(compareBy<TerminalSummary> { terminalNumber(it.terminalId) })
  val exitedNumber = terminalNumber(exitedTerminalId)
  return live.lastOrNull { terminalNumber(it.terminalId) < exitedNumber }?.terminalId
    ?: live.firstOrNull()?.terminalId
}

internal fun inferTerminalHostPlatform(label: String): TerminalHostPlatform {
  val normalized = label.lowercase()
  return when {
    listOf("mac", "macbook", "mac mini", "imac", "darwin").any(normalized::contains) ->
      TerminalHostPlatform.Mac
    listOf("windows", "win").any(normalized::contains) -> TerminalHostPlatform.Windows
    listOf("linux", "ubuntu", "debian").any(normalized::contains) -> TerminalHostPlatform.Linux
    else -> TerminalHostPlatform.Unknown
  }
}

internal enum class TerminalHostPlatform { Mac, Linux, Windows, Unknown }
internal enum class PendingTerminalModifier { Ctrl, Meta }

internal fun consumeTerminalModifier(
  modifier: PendingTerminalModifier?,
  input: String,
): Pair<PendingTerminalModifier?, String> = null to when (modifier) {
  PendingTerminalModifier.Ctrl -> applyTerminalCtrlModifier(input)
  PendingTerminalModifier.Meta -> "\u001b$input"
  null -> input
}

internal fun applyTerminalCtrlModifier(input: String): String {
  val first = input.firstOrNull() ?: return input
  val lower = first.lowercaseChar()
  if (lower in 'a'..'z') return (lower.code - 96).toChar().toString()
  return when (first) {
    '@' -> "\u0000"
    '[' -> "\u001b"
    '\\' -> "\u001c"
    ']' -> "\u001d"
    '^' -> "\u001e"
    '_' -> "\u001f"
    '?' -> "\u007f"
    else -> input
  }
}

private fun terminalNumber(id: String) = id.removePrefix("term-").toIntOrNull() ?: Int.MAX_VALUE
