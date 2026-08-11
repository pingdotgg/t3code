package com.t3tools.android.protocol

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class UsageModelsTest {
  @Test
  fun `decodes the usage v3 response`() {
    val summary = Json.parseToJsonElement(
      """
      {
        "contractVersion": 3,
        "readAt": "2026-08-10T12:00:00Z",
        "timeZone": "Europe/Sarajevo",
        "sinceDay": "2026-08-04",
        "untilDay": "2026-08-10",
        "buckets": [{
          "day": "2026-08-10",
          "provider": "codex",
          "model": "gpt-5.6-sol",
          "totals": {
            "uncachedInputTokens": 100,
            "cachedInputTokens": 200,
            "cacheCreationTokens": 0,
            "outputTokens": 50,
            "reasoningTokens": 20
          },
          "costUsd": 1.25,
          "cacheSavingsUsd": 2.5,
          "costSource": "modelPriced",
          "records": 2,
          "unpricedRecords": 0,
          "sessions": 1
        }],
        "sources": [{
          "fingerprint": {
            "hostId": "host-1",
            "provider": "codex",
            "resolvedHomePath": "/workspace/codex-home",
            "volumeId": "1:2"
          },
          "status": "ok",
          "scannedFiles": 1,
          "skippedFiles": 0,
          "malformedRecords": 0,
          "distinctSessions": 1,
          "message": null
        }],
        "pricing": {
          "status": "fresh",
          "source": "LiteLLM",
          "fetchedAt": "2026-08-10T12:00:00Z",
          "knownModels": 100
        },
        "scanDurationMs": 42
      }
      """.trimIndent(),
    ).toUsageSummary()

    assertEquals(USAGE_CONTRACT_VERSION, summary.contractVersion)
    assertEquals(UsageProvider.Codex, summary.buckets.single().provider)
    assertEquals(200L, summary.buckets.single().totals.cachedInputTokens)
    assertEquals("/workspace/codex-home", summary.sources.single().fingerprint.resolvedHomePath)
  }
}
