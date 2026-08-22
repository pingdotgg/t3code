package com.t3tools.android.nativeapp

import java.util.Locale

data class EnvironmentCacheSummary(
  val environmentId: String,
  val environmentLabel: String,
  val recordCount: Int,
  val payloadBytes: Long,
)

data class ClientStorageUiState(
  val environments: List<EnvironmentCacheSummary> = emptyList(),
  val loading: Boolean = false,
  val clearing: Boolean = false,
  val error: String? = null,
) {
  val recordCount get() = environments.sumOf(EnvironmentCacheSummary::recordCount)
  val payloadBytes get() = environments.sumOf(EnvironmentCacheSummary::payloadBytes)
}

fun formatStorageBytes(bytes: Long): String = when {
  bytes < 1_024 -> "$bytes B"
  bytes < 1_048_576 -> String.format(Locale.US, "%.1f KB", bytes / 1_024.0).replace(".0 KB", " KB")
  else -> String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0).replace(".0 MB", " MB")
}
