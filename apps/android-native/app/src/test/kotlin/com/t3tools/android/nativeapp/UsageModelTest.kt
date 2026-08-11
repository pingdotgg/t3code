package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.UsageBucket
import com.t3tools.android.protocol.UsageCostSource
import com.t3tools.android.protocol.UsagePricing
import com.t3tools.android.protocol.UsageProvider
import com.t3tools.android.protocol.UsageSource
import com.t3tools.android.protocol.UsageSourceFingerprint
import com.t3tools.android.protocol.UsageSourceStatus
import com.t3tools.android.protocol.UsageSummary
import com.t3tools.android.protocol.UsageTokenTotals
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageModelTest {
  @Test
  fun `merges unique transcript sources without double counting reasoning`() {
    val current = usageSummary()
    val duplicate = usageSummary()
    val stale = usageSummary(contractVersion = 2, hostId = "old-host")

    val merged = mergeUsage(
      listOf(
        EnvironmentUsageReport("a", "Ubuntu", current),
        EnvironmentUsageReport("b", "Worktree", duplicate),
        EnvironmentUsageReport("c", "Old", stale),
      ),
    )

    assertEquals(50L, merged.totalTokens)
    assertEquals(7L, merged.reasoningTokens)
    assertEquals(2.0, merged.costUsd, 0.0)
    assertEquals(3L, merged.sessions)
    assertEquals(listOf("Worktree: /workspace/codex-home"), merged.duplicateSources)
    assertEquals(listOf("c"), merged.staleEnvironments)
  }

  @Test
  fun `builds an inclusive local calendar window`() {
    val window = usageWindow(
      days = 7,
      zone = ZoneId.of("Europe/Sarajevo"),
      today = LocalDate.of(2026, 8, 10),
    )

    assertEquals("2026-08-04", window.sinceDay)
    assertEquals("2026-08-10", window.untilDay)
    assertEquals("Europe/Sarajevo", window.timeZone)
  }
}

private fun usageSummary(contractVersion: Int = 3, hostId: String = "host-1") = UsageSummary(
  contractVersion = contractVersion,
  readAt = "2026-08-10T12:00:00Z",
  timeZone = "Europe/Sarajevo",
  sinceDay = "2026-08-04",
  untilDay = "2026-08-10",
  buckets = listOf(
    UsageBucket(
      day = "2026-08-10",
      provider = UsageProvider.Codex,
      model = "gpt-5.6-sol",
      totals = UsageTokenTotals(
        uncachedInputTokens = 10,
        cachedInputTokens = 20,
        cacheCreationTokens = 5,
        outputTokens = 15,
        reasoningTokens = 7,
      ),
      costUsd = 2.0,
      cacheSavingsUsd = 1.0,
      costSource = UsageCostSource.ModelPriced,
      records = 1,
      unpricedRecords = 0,
      sessions = 3,
    ),
  ),
  sources = listOf(
    UsageSource(
      fingerprint = UsageSourceFingerprint(
        hostId = hostId,
        provider = UsageProvider.Codex,
        resolvedHomePath = "/workspace/codex-home",
        volumeId = "1:2",
      ),
      status = UsageSourceStatus.Ok,
      scannedFiles = 1,
      skippedFiles = 0,
      malformedRecords = 0,
      distinctSessions = 3,
      message = null,
    ),
  ),
  pricing = UsagePricing("fresh", "LiteLLM", null, 100),
  scanDurationMs = 10,
)
