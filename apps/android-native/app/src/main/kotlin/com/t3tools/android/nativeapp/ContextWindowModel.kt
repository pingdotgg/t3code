package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ThreadActivity
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal data class ContextWindowUsage(val usedPercentage: Float) {
  val fraction: Float get() = usedPercentage / 100f

  val label: String
    get() = if (usedPercentage < 10f) {
      val tenths = (usedPercentage * 10).roundToInt()
      "${tenths / 10}${if (tenths % 10 == 0) "" else ".${tenths % 10}"}%"
    } else {
      "${usedPercentage.roundToInt()}%"
    }
}

internal fun deriveLatestContextWindowUsage(
  activities: List<ThreadActivity>,
): ContextWindowUsage? {
  activities.asReversed().forEach { activity ->
    if (activity.kind != "context-window.updated") return@forEach
    val payload = activity.payload as? JsonObject ?: return@forEach
    val usedTokens = payload.finiteNumber("usedTokens")
      ?.takeIf { it >= 0 }
      ?: return@forEach
    val maxTokens = payload.finiteNumber("maxTokens")?.takeIf { it > 0 } ?: return null
    return ContextWindowUsage(((usedTokens / maxTokens) * 100).toFloat().coerceIn(0f, 100f))
  }
  return null
}

private fun JsonObject.finiteNumber(key: String): Double? =
  (this[key] as? JsonPrimitive)
    ?.contentOrNull
    ?.toDoubleOrNull()
    ?.takeIf(Double::isFinite)
