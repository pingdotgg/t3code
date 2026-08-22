package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ThreadActivity
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ContextWindowModelTest {
  @Test
  fun uses_the_latest_valid_context_snapshot() {
    val usage = deriveLatestContextWindowUsage(
      listOf(
        activity("old", "context-window.updated", """{"usedTokens":1000,"maxTokens":100000}"""),
        activity("tool", "tool.completed", "{}"),
        activity("malformed", "context-window.updated", "{}"),
        activity("latest", "context-window.updated", """{"usedTokens":14000,"maxTokens":200000}"""),
      ),
    )

    assertEquals(7f, usage?.usedPercentage)
    assertEquals("7%", usage?.label)
  }

  @Test
  fun clamps_overflow_and_hides_usage_without_a_maximum() {
    assertEquals(
      100f,
      deriveLatestContextWindowUsage(
        listOf(activity("usage", "context-window.updated", """{"usedTokens":120000,"maxTokens":100000}""")),
      )?.usedPercentage,
    )
    assertNull(
      deriveLatestContextWindowUsage(
        listOf(activity("usage", "context-window.updated", """{"usedTokens":12000}""")),
      ),
    )
  }

  private fun activity(id: String, kind: String, payload: String) = ThreadActivity(
    id = id,
    tone = "info",
    kind = kind,
    summary = kind,
    payload = Json.parseToJsonElement(payload),
    turnId = "turn-1",
    createdAt = "2026-08-09T00:00:00Z",
  )
}
