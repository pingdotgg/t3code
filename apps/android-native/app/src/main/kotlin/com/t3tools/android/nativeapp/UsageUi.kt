@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.t3tools.android.protocol.UsageProvider
import java.time.LocalDate

private val UsageCard = Color(0xFF111113)
private val UsageSubtle = Color(0xFF202024)
private val UsageBorder = Color(0xFF29292E)
private val UsageMuted = Color(0xFF97979F)
private val CodexColor = Color(0xFFE6E6E6)
private val ClaudeColor = Color(0xFFD97757)
private val ProviderOrder = listOf(UsageProvider.Codex, UsageProvider.Claude)

private enum class UsageMetric { Cost, Tokens }

@Composable
internal fun UsageScreen(
  state: UsageUiState,
  onBack: () -> Unit,
  onWindowSelected: (Int) -> Unit,
  onRefresh: () -> Unit,
) {
  val metric = androidx.compose.runtime.remember {
    androidx.compose.runtime.mutableStateOf(UsageMetric.Cost)
  }
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Usage", onBack) }) { padding ->
    PullToRefreshBox(
      isRefreshing = state.loading && state.reports.isNotEmpty(),
      onRefresh = onRefresh,
      modifier = Modifier.fillMaxSize().padding(padding),
    ) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
      ) {
        item {
          UsageSegmentedControl(
            options = listOf(7 to "7 days", 30 to "30 days", 90 to "90 days"),
            selected = state.windowDays,
            onSelect = onWindowSelected,
          )
        }

        state.error?.let { error -> item { UsageNotice(error, MaterialTheme.colorScheme.error) } }
        if (state.reports.isNotEmpty()) {
          item { UsageCoverageNotice(state) }
        }

        if (state.loading && state.reports.isEmpty()) {
          item {
            Column(
              Modifier.fillMaxWidth().padding(vertical = 58.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
              LinearProgressIndicator(Modifier.fillMaxWidth(0.55f))
              Text("Scanning provider transcripts…", color = UsageMuted)
            }
          }
        } else if (state.reports.isEmpty()) {
          item {
            Text(
              "Connect an environment to see usage.",
              modifier = Modifier.fillMaxWidth().padding(vertical = 58.dp),
              color = UsageMuted,
            )
          }
        } else {
          item { UsageChartCard(state, metric.value) { metric.value = it } }
          if (state.merged.providers.isNotEmpty()) {
            item { ProviderSection(state.merged, metric.value) }
          }
          item { TotalsSection(state.merged) }
          if (state.merged.models.isNotEmpty()) {
            item { ModelsSection(state.merged) }
          }
        }
      }
    }
  }
}

@Composable
private fun UsageSegmentedControl(
  options: List<Pair<Int, String>>,
  selected: Int,
  onSelect: (Int) -> Unit,
) {
  Row(
    Modifier.fillMaxWidth().background(UsageCard, CircleShape).border(1.dp, UsageBorder, CircleShape),
  ) {
    options.forEach { (value, label) ->
      Surface(
        onClick = { onSelect(value) },
        modifier = Modifier.weight(1f),
        shape = CircleShape,
        color = if (value == selected) UsageSubtle else Color.Transparent,
      ) {
        Text(
          label,
          modifier = Modifier.padding(vertical = 9.dp),
          textAlign = androidx.compose.ui.text.style.TextAlign.Center,
          color = if (value == selected) Color.White else UsageMuted,
          fontWeight = if (value == selected) FontWeight.SemiBold else FontWeight.Normal,
          style = MaterialTheme.typography.labelLarge,
        )
      }
    }
  }
}

@Composable
private fun UsageChartCard(
  state: UsageUiState,
  metric: UsageMetric,
  onMetricChange: (UsageMetric) -> Unit,
) {
  val merged = state.merged
  UsageCardSurface {
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.Top,
    ) {
      Column(Modifier.weight(1f)) {
        Text(
          if (metric == UsageMetric.Cost) "Raw token cost" else "Processed tokens",
          color = UsageMuted,
          style = MaterialTheme.typography.bodyMedium,
        )
        Text(
          if (metric == UsageMetric.Cost) "${formatUsageUsd(merged.costUsd)}*"
          else formatUsageTokens(merged.totalTokens),
          color = Color.White,
          fontWeight = FontWeight.Bold,
          fontSize = 34.sp,
          lineHeight = 40.sp,
        )
        Text(
          if (metric == UsageMetric.Cost) "* if billed at full API rate"
          else "Across ${formatUsageCount(merged.sessions)} sessions",
          color = UsageMuted,
          style = MaterialTheme.typography.bodySmall,
        )
      }
      UsageMetricToggle(metric, onMetricChange)
    }

    Spacer(Modifier.height(18.dp))
    if (merged.daily.any { it.totalTokens > 0 }) {
      UsageDailyChart(
        days = enumerateUsageDays(state.window.sinceDay, state.window.untilDay),
        daily = merged.daily,
        metric = metric,
      )
    } else {
      Box(Modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) {
        Text("No activity in this window.", color = UsageMuted)
      }
    }
    Spacer(Modifier.height(12.dp))
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(formatUsageDay(state.window.sinceDay), color = UsageMuted, style = MaterialTheme.typography.labelSmall)
      Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        merged.providers.forEach { provider -> ProviderLegend(provider.provider) }
      }
      Text(formatUsageDay(state.window.untilDay), color = UsageMuted, style = MaterialTheme.typography.labelSmall)
    }
  }
}

@Composable
private fun UsageMetricToggle(metric: UsageMetric, onChange: (UsageMetric) -> Unit) {
  Row(Modifier.background(UsageSubtle, CircleShape)) {
    UsageMetric.entries.forEach { option ->
      Surface(
        onClick = { onChange(option) },
        shape = CircleShape,
        color = if (option == metric) Color(0xFF34343A) else Color.Transparent,
      ) {
        Text(
          option.name.uppercase(),
          modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
          color = if (option == metric) Color.White else UsageMuted,
          style = MaterialTheme.typography.labelSmall,
          fontWeight = if (option == metric) FontWeight.SemiBold else FontWeight.Normal,
        )
      }
    }
  }
}

@Composable
private fun UsageDailyChart(
  days: List<String>,
  daily: List<UsageDailyTotals>,
  metric: UsageMetric,
) {
  val byDay = daily.associateBy { it.day }
  val values = days.map { day ->
    ProviderOrder.map { provider ->
      val totals = byDay[day]?.byProvider?.get(provider)
      if (metric == UsageMetric.Cost) totals?.costUsd ?: 0.0
      else totals?.totalTokens?.toDouble() ?: 0.0
    }
  }
  val maximum = values.maxOfOrNull { it.sum() } ?: 0.0
  Canvas(Modifier.fillMaxWidth().height(180.dp)) {
    val gap = 1.dp.toPx()
    val barWidth = ((size.width - gap * (days.size - 1)) / days.size).coerceAtLeast(1f)
    values.forEachIndexed { index, providers ->
      var bottom = size.height
      providers.forEachIndexed { providerIndex, value ->
        val height = if (maximum == 0.0) 0f else (value / maximum * size.height).toFloat()
        drawUsageBar(
          x = index * (barWidth + gap),
          bottom = bottom,
          width = barWidth,
          height = height,
          color = providerColor(ProviderOrder[providerIndex]),
        )
        bottom -= height
      }
    }
  }
}

private fun DrawScope.drawUsageBar(x: Float, bottom: Float, width: Float, height: Float, color: Color) {
  if (height <= 0f) return
  drawRect(color, topLeft = Offset(x, bottom - height), size = Size(width, height))
}

@Composable
private fun ProviderSection(merged: MergedUsage, metric: UsageMetric) {
  val providers = merged.providers.sortedByDescending {
    if (metric == UsageMetric.Cost) it.costUsd else it.totalTokens.toDouble()
  }
  UsageSection("Providers") {
    providers.forEachIndexed { index, provider ->
      if (index > 0) HorizontalDivider(color = UsageBorder)
      Column(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            ProviderDot(provider.provider, 10)
            Spacer(Modifier.width(8.dp))
            Text(providerLabel(provider.provider), color = Color.White, style = MaterialTheme.typography.titleMedium)
          }
          Text(
            if (metric == UsageMetric.Cost) formatUsageUsd(provider.costUsd)
            else formatUsageTokens(provider.totalTokens),
            color = Color.White,
            style = MaterialTheme.typography.titleMedium,
          )
        }
        val share = if (metric == UsageMetric.Cost) provider.costShare else provider.tokenShare
        Row(Modifier.fillMaxWidth().height(4.dp).background(UsageSubtle, CircleShape)) {
          Box(Modifier.fillMaxWidth(share.toFloat().coerceIn(0f, 1f)).height(4.dp).background(providerColor(provider.provider), CircleShape))
        }
        Text(
          if (metric == UsageMetric.Cost) {
            "${formatUsagePercent(share)} of cost · ${formatUsageTokens(provider.totalTokens)} tokens"
          } else {
            "${formatUsagePercent(share)} of tokens · ${formatUsageUsd(provider.costUsd)}"
          },
          color = UsageMuted,
          style = MaterialTheme.typography.bodySmall,
        )
      }
    }
  }
}

@Composable
private fun TotalsSection(merged: MergedUsage) {
  val activeDays = merged.daily.count { it.totalTokens > 0 }
  val dailyAverage = if (activeDays == 0) 0 else merged.totalTokens / activeDays
  val observedInput = merged.uncachedInputTokens + merged.cachedInputTokens
  val cachedShare = if (observedInput == 0L) 0.0 else merged.cachedInputTokens.toDouble() / observedInput
  val cells = listOf(
    Triple("Processed tokens", formatUsageTokens(merged.totalTokens), "${formatUsageTokens(dailyAverage)} per active day"),
    Triple("Cache savings", formatUsageUsd(merged.costQuality.cacheSavingsUsd), "vs full input rates"),
    Triple("Cached input", formatUsageTokens(merged.cachedInputTokens), "${formatUsagePercent(cachedShare)} of observed input"),
    Triple("Uncached input", formatUsageTokens(merged.uncachedInputTokens), "${formatUsageTokens(merged.cacheCreationTokens)} cache writes"),
    Triple("Output", formatUsageTokens(merged.outputTokens), "incl. ${formatUsageTokens(merged.reasoningTokens)} reasoning"),
    Triple("Unpriced", formatUsagePercent(merged.costQuality.unpricedShare), "of records, excluded from cost"),
  )
  UsageSection("Totals") {
    cells.chunked(2).forEachIndexed { rowIndex, row ->
      if (rowIndex > 0) HorizontalDivider(color = UsageBorder)
      Row(Modifier.fillMaxWidth()) {
        row.forEach { cell ->
          Column(Modifier.weight(1f).padding(vertical = 13.dp, horizontal = 4.dp)) {
            Text(cell.first, color = UsageMuted, style = MaterialTheme.typography.bodySmall)
            Text(cell.second, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(cell.third, color = UsageMuted, style = MaterialTheme.typography.labelSmall)
          }
        }
      }
    }
  }
}

@Composable
private fun ModelsSection(merged: MergedUsage) {
  UsageSection("By model") {
    merged.models.forEachIndexed { index, model ->
      if (index > 0) HorizontalDivider(color = UsageBorder)
      Row(
        Modifier.fillMaxWidth().padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        ProviderDot(model.provider, 10)
        Column(Modifier.weight(1f)) {
          Text(model.model, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(
            "${formatUsagePercent(model.costShare)} of cost · ${formatUsageTokens(model.totalTokens)} tokens",
            color = UsageMuted,
            style = MaterialTheme.typography.bodySmall,
          )
        }
        Text(formatUsageUsd(model.costUsd), color = Color.White)
      }
    }
  }
}

@Composable
private fun UsageCoverageNotice(state: UsageUiState) {
  val failures = state.reports.filter { it.error != null }
  val stale = state.reports.filter { it.environmentId in state.merged.staleEnvironments }
  if (failures.isEmpty() && stale.isEmpty() && state.merged.duplicateSources.isEmpty()) return
  Column(
    Modifier.fillMaxWidth().background(UsageCard, RoundedCornerShape(16.dp))
      .border(1.dp, UsageBorder, RoundedCornerShape(16.dp)).padding(14.dp),
    verticalArrangement = Arrangement.spacedBy(5.dp),
  ) {
    failures.forEach { Text("${it.label} could not report usage.", color = UsageMuted, style = MaterialTheme.typography.bodySmall) }
    stale.forEach { Text("${it.label} runs an incompatible server version and is excluded.", color = UsageMuted, style = MaterialTheme.typography.bodySmall) }
    if (state.merged.duplicateSources.isNotEmpty()) {
      Text(
        "Counted once across environments sharing transcripts: ${state.merged.duplicateSources.joinToString()}",
        color = UsageMuted,
        style = MaterialTheme.typography.bodySmall,
      )
    }
  }
}

@Composable
private fun UsageNotice(text: String, color: Color) {
  Text(
    text,
    modifier = Modifier.fillMaxWidth().background(color.copy(alpha = 0.12f), RoundedCornerShape(16.dp)).padding(14.dp),
    color = color,
    style = MaterialTheme.typography.bodySmall,
  )
}

@Composable
private fun UsageSection(title: String, content: @Composable () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(title, color = UsageMuted, style = MaterialTheme.typography.labelLarge)
    UsageCardSurface(content)
  }
}

@Composable
private fun UsageCardSurface(content: @Composable () -> Unit) {
  Column(
    Modifier.fillMaxWidth().background(UsageCard, RoundedCornerShape(24.dp))
      .border(1.dp, UsageBorder, RoundedCornerShape(24.dp)).padding(16.dp),
    content = { content() },
  )
}

@Composable
private fun ProviderLegend(provider: UsageProvider) {
  Row(verticalAlignment = Alignment.CenterVertically) {
    ProviderDot(provider, 8)
    Spacer(Modifier.width(5.dp))
    Text(providerLabel(provider), color = UsageMuted, style = MaterialTheme.typography.labelSmall)
  }
}

@Composable
private fun ProviderDot(provider: UsageProvider, size: Int) {
  Box(Modifier.size(size.dp).background(providerColor(provider), CircleShape))
}

private fun providerColor(provider: UsageProvider) = when (provider) {
  UsageProvider.Codex -> CodexColor
  UsageProvider.Claude -> ClaudeColor
}

private fun providerLabel(provider: UsageProvider) = when (provider) {
  UsageProvider.Codex -> "Codex"
  UsageProvider.Claude -> "Claude Code"
}

private fun enumerateUsageDays(sinceDay: String, untilDay: String): List<String> {
  val start = runCatching { LocalDate.parse(sinceDay) }.getOrNull() ?: return emptyList()
  val end = runCatching { LocalDate.parse(untilDay) }.getOrNull() ?: return emptyList()
  if (end < start) return emptyList()
  return buildList {
    var day = start
    while (day <= end) {
      add(day.toString())
      day = day.plusDays(1)
    }
  }
}
