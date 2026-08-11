package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ThreadSummary
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.abs

/** Native counterpart of mobile `threadListV2.ts`. */
enum class ThreadListV2Status {
  Approval,
  Input,
  Working,
  Failed,
  Ready,
}

enum class ThreadListV2Variant {
  Card,
  Slim,
}

enum class ThreadFilterStatus(val label: String) {
  All("All Threads"),
  Active("Active"),
  Snoozed("Snoozed"),
  Settled("Settled"),
}

enum class ThreadListV2SwipePrimary {
  Settle,
  Unsettle,
  Unsnooze,
}

data class ThreadListV2Item(
  val thread: ThreadSummary,
  val variant: ThreadListV2Variant,
  val snoozed: Boolean,
  val pinned: Boolean,
)

data class ThreadListV2Layout(
  val items: List<ThreadListV2Item>,
  val snoozedCount: Int,
  val settledCount: Int,
  val hiddenSettledCount: Int,
  val snoozedShelfHeaderIndex: Int?,
  val settledShelfHeaderIndex: Int?,
)

fun filterThreadListV2Items(
  items: List<ThreadListV2Item>,
  status: ThreadFilterStatus,
): List<ThreadListV2Item> = when (status) {
  ThreadFilterStatus.All -> items
  ThreadFilterStatus.Active -> items.filter { !it.snoozed && it.variant == ThreadListV2Variant.Card }
  ThreadFilterStatus.Snoozed -> items.filter(ThreadListV2Item::snoozed)
  ThreadFilterStatus.Settled -> items.filter { !it.snoozed && it.variant == ThreadListV2Variant.Slim }
}

data class SnoozePreset(
  val id: String,
  val label: String,
  val snoozedUntil: Instant,
)

const val THREAD_LIST_V2_SETTLED_INITIAL = 10
const val THREAD_LIST_V2_SETTLED_PAGE = 25

fun resolveThreadListV2Status(thread: ThreadSummary): ThreadListV2Status = when {
  thread.hasPendingApprovals -> ThreadListV2Status.Approval
  thread.hasPendingUserInput -> ThreadListV2Status.Input
  thread.session?.status == "running" || thread.session?.status == "starting" ->
    ThreadListV2Status.Working
  thread.session?.status == "error" || thread.latestTurn?.state == "error" ->
    ThreadListV2Status.Failed
  else -> ThreadListV2Status.Ready
}

fun resolveThreadListV2SwipePrimary(
  variant: ThreadListV2Variant,
  snoozed: Boolean,
  settlementSupported: Boolean,
): ThreadListV2SwipePrimary? = when {
  snoozed -> ThreadListV2SwipePrimary.Unsnooze
  !settlementSupported -> null
  variant == ThreadListV2Variant.Slim -> ThreadListV2SwipePrimary.Unsettle
  else -> ThreadListV2SwipePrimary.Settle
}

/** Secondary half-swipe action: snooze when the row can be parked. */
fun resolveThreadListV2SwipeSecondary(
  snoozed: Boolean,
  snoozeSupported: Boolean,
  snoozable: Boolean,
): Boolean = !snoozed && snoozeSupported && snoozable

fun isEffectivelySnoozed(thread: ThreadSummary, now: Instant): Boolean {
  val until = parseInstant(thread.snoozedUntil) ?: return false
  if (!until.isAfter(now)) return false
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  val snoozedAt = thread.snoozedAt
  val session = thread.session
  if (session?.status == "error" && (
      snoozedAt == null || isAfter(session.updatedAt, snoozedAt)
    )) return false
  val latestTurn = thread.latestTurn
  if (
    snoozedAt != null &&
    latestTurn?.state == "completed" &&
    isAfter(latestTurn.completedAt, snoozedAt)
  ) return false
  return true
}

private fun isAfter(value: String?, reference: String): Boolean {
  val instant = parseInstant(value) ?: return false
  val referenceInstant = parseInstant(reference) ?: return false
  return instant.isAfter(referenceInstant)
}

fun isEffectivelySettled(
  thread: ThreadSummary,
  now: Instant,
  settlementSupported: Boolean,
  autoSettleAfterDays: Int = 3,
): Boolean {
  if (!settlementSupported) return false
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  if (thread.session?.status == "running" || thread.session?.status == "starting") return false
  if (thread.settledOverride == "settled") return true
  if (thread.settledOverride == "active") return false
  if (thread.settledAt != null) return true
  val lastActivity = parseInstant(thread.updatedAt) ?: return false
  val cutoff = now.minus(Duration.ofDays(autoSettleAfterDays.toLong()))
  return lastActivity.isBefore(cutoff)
}

fun canSnoozeThread(thread: ThreadSummary): Boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  if (thread.session?.status == "running" || thread.session?.status == "starting") return false
  return true
}

fun canSettleThread(thread: ThreadSummary): Boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  return thread.session?.status != "running" && thread.session?.status != "starting"
}

fun sortThreadsForListV2(threads: List<ThreadSummary>): List<ThreadSummary> =
  threads.sortedWith(
    compareByDescending<ThreadSummary> { parseInstant(it.createdAt)?.toEpochMilli() ?: 0L }
      .thenBy(ThreadSummary::id),
  )

fun sortPinnedThreads(threads: List<ThreadSummary>): List<ThreadSummary> {
  val (keyed, keyless) = threads.partition { it.pinOrderKey != null }
  return keyed.sortedWith(compareBy<ThreadSummary> { it.pinOrderKey }.thenBy(ThreadSummary::id)) +
    sortThreadsForListV2(keyless)
}

data class PinOrderAssignment(val threadId: String, val orderKey: String)

private const val PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz"

private fun isValidPinOrderKey(key: String): Boolean =
  key.isNotEmpty() && key.all(PIN_ORDER_DIGITS::contains) && key.last() != PIN_ORDER_DIGITS.first()

private fun pinOrderMidpoint(before: String, after: String): String {
  require(after.isEmpty() || before < after)
  if (after.isNotEmpty()) {
    var prefixLength = 0
    while ((before.getOrNull(prefixLength) ?: PIN_ORDER_DIGITS.first()) == after[prefixLength]) {
      prefixLength += 1
    }
    if (prefixLength > 0) {
      return after.take(prefixLength) + pinOrderMidpoint(
        before.drop(prefixLength),
        after.drop(prefixLength),
      )
    }
  }
  val beforeDigit = before.firstOrNull()?.let(PIN_ORDER_DIGITS::indexOf) ?: 0
  val afterDigit = after.firstOrNull()?.let(PIN_ORDER_DIGITS::indexOf) ?: PIN_ORDER_DIGITS.length
  if (afterDigit - beforeDigit > 1) return PIN_ORDER_DIGITS[(beforeDigit + afterDigit + 1) / 2].toString()
  if (after.length > 1) return after.first().toString()
  return PIN_ORDER_DIGITS[beforeDigit] + pinOrderMidpoint(before.drop(1), "")
}

fun pinOrderKeyBetween(before: String?, after: String?): String? {
  val lower = before.orEmpty()
  val upper = after.orEmpty()
  if (lower.isNotEmpty() && !isValidPinOrderKey(lower)) return null
  if (upper.isNotEmpty() && !isValidPinOrderKey(upper)) return null
  if (upper.isNotEmpty() && lower >= upper) return null
  return pinOrderMidpoint(lower, upper)
}

private fun spreadPinOrderKeys(count: Int): List<String> {
  val space = PIN_ORDER_DIGITS.length * PIN_ORDER_DIGITS.length
  val step = space.toDouble() / (count + 1)
  var previous = 0
  return List(count) { index ->
    var value = maxOf(kotlin.math.round(step * (index + 1)).toInt(), previous + 1)
    if (value % PIN_ORDER_DIGITS.length == 0) value += 1
    value = minOf(value, space - 1)
    previous = value
    "${PIN_ORDER_DIGITS[value / PIN_ORDER_DIGITS.length]}${PIN_ORDER_DIGITS[value % PIN_ORDER_DIGITS.length]}"
  }
}

fun planPinnedMove(
  ordered: List<ThreadSummary>,
  movedId: String,
  direction: Int,
): List<PinOrderAssignment> {
  val from = ordered.indexOfFirst { it.id == movedId }
  if (from < 0) return emptyList()
  val to = from + direction
  if (to !in ordered.indices) return emptyList()
  val next = ordered.toMutableList().apply { add(to, removeAt(from)) }
  val movedIndex = next.indexOfFirst { it.id == movedId }
  val before = next.getOrNull(movedIndex - 1)
  val after = next.getOrNull(movedIndex + 1)
  val beforeUsable = before == null || before.pinOrderKey != null
  val afterUsable = after == null || after.pinOrderKey != null
  if (beforeUsable && afterUsable) {
    pinOrderKeyBetween(before?.pinOrderKey, after?.pinOrderKey)?.let {
      return listOf(PinOrderAssignment(movedId, it))
    }
  }
  val keys = spreadPinOrderKeys(next.size)
  return next.mapIndexedNotNull { index, thread ->
    keys[index].takeIf { it != thread.pinOrderKey }?.let { PinOrderAssignment(thread.id, it) }
  }
}

fun buildThreadListV2Layout(
  threads: Collection<ThreadSummary>,
  settlementSupported: Boolean,
  snoozeSupported: Boolean,
  search: String = "",
  showArchived: Boolean = false,
  snoozedShelfExpanded: Boolean = false,
  settledShelfExpanded: Boolean = true,
  settledLimit: Int = THREAD_LIST_V2_SETTLED_INITIAL,
  now: Instant = Instant.now(),
  autoSettleAfterDays: Int = 3,
): ThreadListV2Layout {
  val query = search.trim()
  val pinned = mutableListOf<ThreadSummary>()
  val active = mutableListOf<ThreadSummary>()
  val settled = mutableListOf<ThreadSummary>()
  val snoozed = mutableListOf<ThreadSummary>()

  for (thread in threads) {
    val isArchived = thread.archivedAt != null
    if (isArchived != showArchived) continue
    if (query.isNotEmpty() && !thread.title.contains(query, ignoreCase = true)) continue

    if (snoozeSupported && isEffectivelySnoozed(thread, now)) {
      snoozed += thread
      continue
    }
    if (thread.pinnedAt != null) {
      pinned += thread
      continue
    }
    if (isEffectivelySettled(thread, now, settlementSupported, autoSettleAfterDays)) {
      settled += thread
    } else {
      active += thread
    }
  }

  val orderedActive = sortThreadsForListV2(active)
  val orderedPinned = sortPinnedThreads(pinned)
  val orderedSnoozed = snoozed.sortedWith(
    compareBy<ThreadSummary> { parseInstant(it.snoozedUntil)?.toEpochMilli() ?: Long.MAX_VALUE }
      .thenBy(ThreadSummary::id),
  )
  val orderedSettled = settled.sortedWith(
    compareByDescending<ThreadSummary> { parseInstant(it.updatedAt)?.toEpochMilli() ?: 0L }
      .thenBy(ThreadSummary::id),
  )

  val visibleSnoozed = if (snoozedShelfExpanded) orderedSnoozed else emptyList()
  val pagedSettled = orderedSettled.take(settledLimit)
  val visibleSettled = if (settledShelfExpanded) pagedSettled else emptyList()

  // Row order: pinned + active cards, then optional snoozed slim, then settled slim.
  val items = buildList {
    for (thread in orderedPinned) {
      add(ThreadListV2Item(thread, ThreadListV2Variant.Card, snoozed = false, pinned = true))
    }
    for (thread in orderedActive) {
      add(ThreadListV2Item(thread, ThreadListV2Variant.Card, snoozed = false, pinned = false))
    }
    for (thread in visibleSnoozed) {
      add(ThreadListV2Item(thread, ThreadListV2Variant.Slim, snoozed = true, pinned = false))
    }
    for (thread in visibleSettled) {
      add(ThreadListV2Item(thread, ThreadListV2Variant.Slim, snoozed = false, pinned = false))
    }
  }

  val activeEnd = orderedPinned.size + orderedActive.size
  return ThreadListV2Layout(
    items = items,
    snoozedCount = orderedSnoozed.size,
    settledCount = orderedSettled.size,
    hiddenSettledCount = (orderedSettled.size - pagedSettled.size).coerceAtLeast(0),
    snoozedShelfHeaderIndex = if (orderedSnoozed.isNotEmpty()) activeEnd else null,
    settledShelfHeaderIndex = if (orderedSettled.isNotEmpty()) {
      activeEnd + visibleSnoozed.size
    } else {
      null
    },
  )
}

fun resolveSnoozePresets(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<SnoozePreset> {
  val local = ZonedDateTime.ofInstant(now, zone)
  val evening = local.toLocalDate().atTime(18, 0).atZone(zone)
  val tomorrow = local.toLocalDate().plusDays(1).atTime(9, 0).atZone(zone)
  val daysUntilMonday = (8 - local.dayOfWeek.value) % 7
  val nextMonday = local.toLocalDate()
    .plusDays((daysUntilMonday.takeUnless { it == 0 } ?: 7).toLong())
    .atTime(9, 0)
    .atZone(zone)
  return buildList {
    add(SnoozePreset("hour", "In 1 hour", now.plus(1, ChronoUnit.HOURS)))
    add(SnoozePreset("three-hours", "In 3 hours", now.plus(3, ChronoUnit.HOURS)))
    if (evening.toInstant().isAfter(now.plus(1, ChronoUnit.HOURS))) {
      add(SnoozePreset("evening", "This evening", evening.toInstant()))
    }
    add(SnoozePreset("tomorrow", "Tomorrow", tomorrow.toInstant()))
    add(SnoozePreset("next-week", "Next week", nextMonday.toInstant()))
  }
}

fun relativeTimeLabel(iso: String?, now: Instant = Instant.now()): String {
  val instant = parseInstant(iso) ?: return ""
  val seconds = Duration.between(instant, now).seconds
  val abs = abs(seconds)
  return when {
    abs < 60 -> "now"
    abs < 3_600 -> "${abs / 60}m"
    abs < 86_400 -> "${abs / 3_600}h"
    abs < 86_400 * 7 -> "${abs / 86_400}d"
    else -> DateTimeFormatter.ofPattern("MMM d").withZone(ZoneId.systemDefault()).format(instant)
  }
}

fun snoozeWakeLabel(snoozedUntil: String?, now: Instant = Instant.now()): String {
  val until = parseInstant(snoozedUntil) ?: return "Snoozed"
  val seconds = Duration.between(now, until).seconds
  if (seconds <= 0) return "Woke"
  return when {
    seconds < 3_600 -> "Wakes in ${seconds / 60}m"
    seconds < 86_400 -> "Wakes in ${seconds / 3_600}h"
    else -> "Wakes in ${seconds / 86_400}d"
  }
}

fun parseInstant(value: String?): Instant? {
  if (value.isNullOrBlank()) return null
  return runCatching { Instant.parse(value) }.getOrNull()
}
