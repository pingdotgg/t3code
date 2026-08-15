package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.UsageBucket
import com.t3tools.android.protocol.isSupportedUsageContract
import com.t3tools.android.protocol.UsageCostSource
import com.t3tools.android.protocol.UsageProvider
import com.t3tools.android.protocol.UsageSourceStatus
import com.t3tools.android.protocol.UsageSummary
import com.t3tools.android.protocol.UsageWindow
import java.text.NumberFormat
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

data class EnvironmentUsageReport(
  val environmentId: String,
  val label: String,
  val summary: UsageSummary? = null,
  val error: String? = null,
)

data class UsageProviderTotals(
  val provider: UsageProvider,
  val costUsd: Double,
  val totalTokens: Long,
  val records: Long,
  val costShare: Double,
  val tokenShare: Double,
)

data class UsageModelTotals(
  val provider: UsageProvider,
  val model: String,
  val costUsd: Double,
  val totalTokens: Long,
  val records: Long,
  val costShare: Double,
)

data class UsageDailyTotals(
  val day: String,
  val costUsd: Double,
  val totalTokens: Long,
  val byProvider: Map<UsageProvider, UsageProviderDayTotals>,
)

data class UsageProviderDayTotals(val costUsd: Double, val totalTokens: Long)

data class UsageCostQuality(
  val providerReportedShare: Double,
  val modelPricedShare: Double,
  val unpricedShare: Double,
  val cacheSavingsUsd: Double,
)

data class MergedUsage(
  val costUsd: Double = 0.0,
  val uncachedInputTokens: Long = 0,
  val cachedInputTokens: Long = 0,
  val cacheCreationTokens: Long = 0,
  val outputTokens: Long = 0,
  val reasoningTokens: Long = 0,
  val totalTokens: Long = 0,
  val records: Long = 0,
  val sessions: Long = 0,
  val providers: List<UsageProviderTotals> = emptyList(),
  val models: List<UsageModelTotals> = emptyList(),
  val daily: List<UsageDailyTotals> = emptyList(),
  val costQuality: UsageCostQuality = UsageCostQuality(0.0, 0.0, 0.0, 0.0),
  val duplicateSources: List<String> = emptyList(),
  val staleEnvironments: List<String> = emptyList(),
)

data class UsageUiState(
  val windowDays: Int = 30,
  val window: UsageWindow = usageWindow(30),
  val loading: Boolean = false,
  val reports: List<EnvironmentUsageReport> = emptyList(),
  val merged: MergedUsage = MergedUsage(),
  val error: String? = null,
)

fun usageWindow(
  days: Int,
  zone: ZoneId = ZoneId.systemDefault(),
  today: LocalDate = LocalDate.now(zone),
) = UsageWindow(
  sinceDay = today.minusDays((days - 1).toLong()).toString(),
  untilDay = today.toString(),
  timeZone = zone.id,
)

fun mergeUsage(reports: List<EnvironmentUsageReport>): MergedUsage {
  val stale = reports.mapNotNull { report ->
    report.summary?.takeIf { !isSupportedUsageContract(it.contractVersion) }
      ?.let { report.environmentId }
  }
  val current = reports.mapNotNull { report ->
    report.summary?.takeIf { isSupportedUsageContract(it.contractVersion) }
      ?.let { report to it }
  }.sortedBy { it.first.environmentId }

  val owners = mutableMapOf<String, String>()
  val duplicates = mutableListOf<String>()
  current.forEach { (report, summary) ->
    summary.sources.filter { it.status != UsageSourceStatus.Missing }.forEach { source ->
      val key = source.fingerprint.run {
        listOf(hostId, provider.name, resolvedHomePath, volumeId).joinToString(" ")
      }
      if (owners.putIfAbsent(key, report.environmentId) != null) {
        duplicates += "${report.label}: ${source.fingerprint.resolvedHomePath}"
      }
    }
  }

  var costUsd = 0.0
  var uncachedInputTokens = 0L
  var cachedInputTokens = 0L
  var cacheCreationTokens = 0L
  var outputTokens = 0L
  var reasoningTokens = 0L
  var records = 0L
  var sessions = 0L
  var cacheSavingsUsd = 0.0
  var providerReportedRecords = 0L
  var unpricedRecords = 0L
  val providers = mutableMapOf<UsageProvider, MutableUsageTotals>()
  val models = mutableMapOf<Pair<UsageProvider, String>, MutableUsageTotals>()
  val days = mutableMapOf<String, MutableDailyTotals>()

  current.forEach { (report, summary) ->
    val ownedProviders = summary.sources.filter { source ->
      source.status != UsageSourceStatus.Missing && owners[source.fingerprint.run {
        listOf(hostId, provider.name, resolvedHomePath, volumeId).joinToString(" ")
      }] == report.environmentId
    }.onEach { sessions += it.distinctSessions }
      .mapTo(mutableSetOf()) { it.fingerprint.provider }

    summary.buckets.filter { it.provider in ownedProviders }.forEach { bucket ->
      val tokens = bucket.totalTokens()
      costUsd += bucket.costUsd
      cacheSavingsUsd += bucket.cacheSavingsUsd
      uncachedInputTokens += bucket.totals.uncachedInputTokens
      cachedInputTokens += bucket.totals.cachedInputTokens
      cacheCreationTokens += bucket.totals.cacheCreationTokens
      outputTokens += bucket.totals.outputTokens
      reasoningTokens += bucket.totals.reasoningTokens
      records += bucket.records
      unpricedRecords += bucket.unpricedRecords
      if (bucket.costSource == UsageCostSource.ProviderReported) {
        providerReportedRecords += bucket.records
      }

      providers.getOrPut(bucket.provider, ::MutableUsageTotals).add(bucket, tokens)
      models.getOrPut(bucket.provider to bucket.model, ::MutableUsageTotals).add(bucket, tokens)
      days.getOrPut(bucket.day, ::MutableDailyTotals).add(bucket, tokens)
    }
  }

  val totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
  val providerRows = providers.map { (provider, totals) ->
    UsageProviderTotals(
      provider = provider,
      costUsd = totals.costUsd,
      totalTokens = totals.totalTokens,
      records = totals.records,
      costShare = share(totals.costUsd, costUsd),
      tokenShare = share(totals.totalTokens, totalTokens),
    )
  }.sortedByDescending { it.costUsd }
  val modelRows = models.map { (key, totals) ->
    UsageModelTotals(
      provider = key.first,
      model = key.second,
      costUsd = totals.costUsd,
      totalTokens = totals.totalTokens,
      records = totals.records,
      costShare = share(totals.costUsd, costUsd),
    )
  }.sortedWith(compareByDescending<UsageModelTotals> { it.costUsd }.thenByDescending { it.totalTokens })

  return MergedUsage(
    costUsd = costUsd,
    uncachedInputTokens = uncachedInputTokens,
    cachedInputTokens = cachedInputTokens,
    cacheCreationTokens = cacheCreationTokens,
    outputTokens = outputTokens,
    reasoningTokens = reasoningTokens,
    totalTokens = totalTokens,
    records = records,
    sessions = sessions,
    providers = providerRows,
    models = modelRows,
    daily = days.map { (day, totals) ->
      UsageDailyTotals(day, totals.costUsd, totals.totalTokens, totals.byProvider.toMap())
    }.sortedBy { it.day },
    costQuality = UsageCostQuality(
      providerReportedShare = share(providerReportedRecords, records),
      modelPricedShare = share(records - providerReportedRecords - unpricedRecords, records),
      unpricedShare = share(unpricedRecords, records),
      cacheSavingsUsd = cacheSavingsUsd,
    ),
    duplicateSources = duplicates,
    staleEnvironments = stale,
  )
}

private class MutableUsageTotals(
  var costUsd: Double = 0.0,
  var totalTokens: Long = 0,
  var records: Long = 0,
) {
  fun add(bucket: UsageBucket, tokens: Long) {
    costUsd += bucket.costUsd
    totalTokens += tokens
    records += bucket.records
  }
}

private class MutableDailyTotals(
  var costUsd: Double = 0.0,
  var totalTokens: Long = 0,
  val byProvider: MutableMap<UsageProvider, UsageProviderDayTotals> = mutableMapOf(),
) {
  fun add(bucket: UsageBucket, tokens: Long) {
    costUsd += bucket.costUsd
    totalTokens += tokens
    val current = byProvider[bucket.provider] ?: UsageProviderDayTotals(0.0, 0)
    byProvider[bucket.provider] = UsageProviderDayTotals(
      costUsd = current.costUsd + bucket.costUsd,
      totalTokens = current.totalTokens + tokens,
    )
  }
}

private fun UsageBucket.totalTokens() = totals.run {
  uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
}

private fun share(value: Long, total: Long) = if (total == 0L) 0.0 else value.toDouble() / total
private fun share(value: Double, total: Double) = if (total == 0.0) 0.0 else value / total

private val currencyFormat = NumberFormat.getCurrencyInstance(Locale.US).apply {
  minimumFractionDigits = 2
  maximumFractionDigits = 2
}
private val integerFormat = NumberFormat.getIntegerInstance(Locale.US)
private val shortDayFormat = DateTimeFormatter.ofPattern("MMM d", Locale.US)

fun formatUsageUsd(value: Double): String = currencyFormat.format(value)
fun formatUsageCount(value: Number): String = integerFormat.format(value)
fun formatUsagePercent(share: Double, digits: Int = 1): String = "%1.${digits}f%%".format(Locale.US, share * 100)
fun formatUsageDay(day: String): String = runCatching {
  LocalDate.parse(day).format(shortDayFormat)
}.getOrDefault(day)

fun formatUsageTokens(value: Long): String {
  val magnitude = abs(value.toDouble())
  val (scaled, suffix) = when {
    magnitude >= 1e12 -> value / 1e12 to "T"
    magnitude >= 1e9 -> value / 1e9 to "B"
    magnitude >= 1e6 -> value / 1e6 to "M"
    magnitude >= 1e3 -> value / 1e3 to "K"
    else -> return integerFormat.format(value)
  }
  val digits = when {
    abs(scaled) >= 100 -> 0
    abs(scaled) >= 10 -> 1
    else -> 2
  }
  return "%1.${digits}f".format(Locale.US, scaled).trimEnd('0').trimEnd('.') + suffix
}
