package com.t3tools.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement

const val USAGE_CONTRACT_VERSION = 4
const val MIN_SUPPORTED_USAGE_CONTRACT = 3

fun isSupportedUsageContract(version: Int): Boolean =
  version in MIN_SUPPORTED_USAGE_CONTRACT..USAGE_CONTRACT_VERSION

@Serializable
enum class UsageProvider {
  @SerialName("claude") Claude,
  @SerialName("codex") Codex,
}

@Serializable
enum class UsageCostSource {
  @SerialName("providerReported") ProviderReported,
  @SerialName("modelPriced") ModelPriced,
  @SerialName("unpriced") Unpriced,
}

@Serializable
enum class UsageSourceStatus {
  @SerialName("ok") Ok,
  @SerialName("missing") Missing,
  @SerialName("partial") Partial,
  @SerialName("failed") Failed,
}

@Serializable
data class UsageTokenTotals(
  val uncachedInputTokens: Long,
  val cachedInputTokens: Long,
  val cacheCreationTokens: Long,
  val outputTokens: Long,
  val reasoningTokens: Long,
)

@Serializable
data class UsageBucket(
  val day: String,
  val hourStart: String? = null,
  val provider: UsageProvider,
  val model: String,
  val totals: UsageTokenTotals,
  val costUsd: Double,
  val cacheSavingsUsd: Double,
  val costSource: UsageCostSource,
  val records: Long,
  val unpricedRecords: Long,
  val sessions: Long,
)

@Serializable
data class UsageSourceFingerprint(
  val hostId: String,
  val provider: UsageProvider,
  val resolvedHomePath: String,
  val volumeId: String,
)

@Serializable
data class UsageSource(
  val fingerprint: UsageSourceFingerprint,
  val status: UsageSourceStatus,
  val scannedFiles: Long,
  val skippedFiles: Long,
  val malformedRecords: Long,
  val distinctSessions: Long,
  val message: String?,
)

@Serializable
data class UsagePricing(
  val status: String,
  val source: String,
  val fetchedAt: String?,
  val knownModels: Long,
)

@Serializable
data class UsageSummary(
  val contractVersion: Int,
  val readAt: String,
  val timeZone: String,
  val sinceDay: String,
  val untilDay: String,
  val buckets: List<UsageBucket>,
  val sources: List<UsageSource>,
  val pricing: UsagePricing,
  val scanDurationMs: Long,
)

data class UsageWindow(
  val sinceDay: String,
  val untilDay: String,
  val timeZone: String,
)

internal fun usageSummaryPayload(window: UsageWindow) = buildJsonObject(
  "sinceDay" to JsonPrimitive(window.sinceDay),
  "untilDay" to JsonPrimitive(window.untilDay),
  "timeZone" to JsonPrimitive(window.timeZone),
)

private val usageJson = Json { ignoreUnknownKeys = true }

internal fun JsonElement.toUsageSummary(): UsageSummary =
  usageJson.decodeFromJsonElement(this)
