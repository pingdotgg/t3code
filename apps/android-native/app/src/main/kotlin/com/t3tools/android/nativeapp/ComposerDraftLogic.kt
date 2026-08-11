package com.t3tools.android.nativeapp

internal fun appendStashedText(current: String, stashed: String): String = when {
  current.isEmpty() -> stashed
  stashed.isEmpty() -> current
  current.endsWith('\n') || stashed.startsWith('\n') -> current + stashed
  else -> "$current\n\n$stashed"
}
