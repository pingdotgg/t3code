package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.LatestTurn
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.ThreadSession
import com.t3tools.android.protocol.ThreadSummary
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadListV2Test {
  private val now = Instant.parse("2026-08-08T12:00:00Z")

  @Test
  fun snooze_presets_match_the_shared_client_order() {
    val presets = resolveSnoozePresets(
      Instant.parse("2026-08-08T10:00:00Z"),
      ZoneId.of("UTC"),
    )

    assertEquals(
      listOf("hour", "three-hours", "evening", "tomorrow", "next-week"),
      presets.map(SnoozePreset::id),
    )
    assertEquals("2026-08-08T13:00:00Z", presets.first { it.id == "three-hours" }.snoozedUntil.toString())
    assertEquals("2026-08-10T09:00:00Z", presets.first { it.id == "next-week" }.snoozedUntil.toString())
  }

  @Test
  fun snooze_presets_drop_evening_when_it_is_near_or_past() {
    val presets = resolveSnoozePresets(
      Instant.parse("2026-08-08T17:30:00Z"),
      ZoneId.of("UTC"),
    )

    assertEquals(
      listOf("hour", "three-hours", "tomorrow", "next-week"),
      presets.map(SnoozePreset::id),
    )
  }

  @Test
  fun calendar_snooze_presets_keep_local_time_across_dst() {
    val zone = ZoneId.of("America/New_York")
    val now = ZonedDateTime.parse("2026-03-07T23:30:00-05:00[America/New_York]").toInstant()
    val tomorrow = resolveSnoozePresets(now, zone).first { it.id == "tomorrow" }
    val localWake = ZonedDateTime.ofInstant(tomorrow.snoozedUntil, zone)

    assertEquals(8, localWake.dayOfMonth)
    assertEquals(9, localWake.hour)
  }

  @Test
  fun partitions_pinned_active_snoozed_settled() {
    val threads = listOf(
      summary("a", title = "Active", updatedAt = "2026-08-08T11:00:00Z"),
      summary("p", title = "Pinned", updatedAt = "2026-08-07T11:00:00Z", pinnedAt = "2026-08-07T10:00:00Z", pinOrderKey = "1"),
      summary("s", title = "Settled", updatedAt = "2026-08-01T11:00:00Z", settledAt = "2026-08-01T12:00:00Z"),
      summary("z", title = "Snoozed", updatedAt = "2026-08-08T10:00:00Z", snoozedUntil = "2026-08-08T18:00:00Z"),
      summary("old", title = "Archived", updatedAt = "2026-08-08T09:00:00Z", archivedAt = "2026-08-08T09:30:00Z"),
    )
    val layout = buildThreadListV2Layout(
      threads = threads,
      settlementSupported = true,
      snoozeSupported = true,
      now = now,
    )
    assertEquals(listOf("p", "a"), layout.items.filter { !it.snoozed && it.variant == ThreadListV2Variant.Card }.map { it.thread.id })
    assertEquals(1, layout.snoozedCount)
    assertEquals(1, layout.settledCount)
    assertTrue(layout.items.none { it.thread.id == "old" })
    // Collapsed snoozed by default, settled expanded
    assertTrue(layout.items.none { it.snoozed })
    assertEquals(listOf("s"), layout.items.filter { it.variant == ThreadListV2Variant.Slim }.map { it.thread.id })
  }

  @Test
  fun expands_snoozed_shelf_into_slim_rows() {
    val layout = buildThreadListV2Layout(
      threads = listOf(summary("z", snoozedUntil = "2026-08-08T18:00:00Z")),
      settlementSupported = true,
      snoozeSupported = true,
      snoozedShelfExpanded = true,
      now = now,
    )
    assertEquals(1, layout.items.size)
    assertTrue(layout.items.single().snoozed)
    assertEquals(ThreadListV2Variant.Slim, layout.items.single().variant)
  }

  @Test
  fun filters_the_rendered_items() {
    val layout = buildThreadListV2Layout(
      threads = listOf(
        summary("active"),
        summary("snoozed", snoozedUntil = "2026-08-08T18:00:00Z"),
        summary("settled", settledAt = "2026-08-08T10:00:00Z"),
      ),
      settlementSupported = true,
      snoozeSupported = true,
      snoozedShelfExpanded = true,
      now = now,
    )

    assertEquals(
      listOf("snoozed"),
      filterThreadListV2Items(layout.items, ThreadFilterStatus.Snoozed).map { it.thread.id },
    )
  }

  @Test
  fun orders_active_threads_globally_by_creation_time() {
    val layout = buildThreadListV2Layout(
      threads = listOf(
        summary("older-new-activity", projectId = "project-a", createdAt = "2026-08-01T10:00:00Z", updatedAt = "2026-08-08T11:00:00Z"),
        summary("newer", projectId = "project-b", createdAt = "2026-08-08T10:00:00Z", updatedAt = "2026-08-08T10:00:00Z"),
      ),
      settlementSupported = false,
      snoozeSupported = false,
      now = now,
    )

    assertEquals(listOf("newer", "older-new-activity"), layout.items.map { it.thread.id })
  }

  @Test
  fun orders_keyless_pins_by_creation_time_after_ordered_pins() {
    val threads = listOf(
      summary("older-keyless", createdAt = "2026-08-01T10:00:00Z", pinnedAt = now.toString()),
      summary("ordered", createdAt = "2026-08-01T10:00:00Z", pinnedAt = now.toString(), pinOrderKey = "m"),
      summary("newer-keyless", createdAt = "2026-08-08T10:00:00Z", pinnedAt = now.toString()),
    )

    assertEquals(listOf("ordered", "newer-keyless", "older-keyless"), sortPinnedThreads(threads).map { it.id })
  }

  @Test
  fun status_prefers_approval_then_working_then_failed() {
    assertEquals(
      ThreadListV2Status.Approval,
      resolveThreadListV2Status(summary("1", hasPendingApprovals = true, session = ThreadSession("running", null, null))),
    )
    assertEquals(
      ThreadListV2Status.Working,
      resolveThreadListV2Status(summary("2", session = ThreadSession("running", null, null))),
    )
    assertEquals(
      ThreadListV2Status.Failed,
      resolveThreadListV2Status(summary("3", latestTurn = LatestTurn("t", "error"))),
    )
    assertEquals(ThreadListV2Status.Ready, resolveThreadListV2Status(summary("4")))
  }

  @Test
  fun swipe_primary_matches_row_lifecycle() {
    assertEquals(
      ThreadListV2SwipePrimary.Settle,
      resolveThreadListV2SwipePrimary(ThreadListV2Variant.Card, snoozed = false, settlementSupported = true),
    )
    assertEquals(
      ThreadListV2SwipePrimary.Unsettle,
      resolveThreadListV2SwipePrimary(ThreadListV2Variant.Slim, snoozed = false, settlementSupported = true),
    )
    assertEquals(
      ThreadListV2SwipePrimary.Unsnooze,
      resolveThreadListV2SwipePrimary(ThreadListV2Variant.Slim, snoozed = true, settlementSupported = true),
    )
    assertNull(resolveThreadListV2SwipePrimary(
      ThreadListV2Variant.Card,
      snoozed = false,
      settlementSupported = false,
    ))
  }

  @Test
  fun half_swipe_secondary_is_snooze_only_when_snoozable() {
    assertTrue(resolveThreadListV2SwipeSecondary(snoozed = false, snoozeSupported = true, snoozable = true))
    assertFalse(resolveThreadListV2SwipeSecondary(snoozed = true, snoozeSupported = true, snoozable = true))
    assertFalse(resolveThreadListV2SwipeSecondary(snoozed = false, snoozeSupported = false, snoozable = true))
    assertFalse(canSnoozeThread(summary("a", hasPendingApprovals = true)))
    assertFalse(canSnoozeThread(summary("running", session = ThreadSession("running", null, null))))
  }

  @Test
  fun snoozed_threads_only_wake_for_fresh_attention() {
    val snoozedAt = "2026-08-08T10:00:00Z"
    val snoozedUntil = "2026-08-08T18:00:00Z"
    assertTrue(isEffectivelySnoozed(
      summary(
        "old-error",
        snoozedAt = snoozedAt,
        snoozedUntil = snoozedUntil,
        session = ThreadSession("error", null, "Failed", "2026-08-08T09:00:00Z"),
      ),
      now,
    ))
    assertFalse(isEffectivelySnoozed(
      summary(
        "new-error",
        snoozedAt = snoozedAt,
        snoozedUntil = snoozedUntil,
        session = ThreadSession("error", null, "Failed", "2026-08-08T11:00:00Z"),
      ),
      now,
    ))
    assertFalse(isEffectivelySnoozed(
      summary(
        "completed",
        snoozedAt = snoozedAt,
        snoozedUntil = snoozedUntil,
        latestTurn = LatestTurn("turn", "completed", "2026-08-08T11:00:00Z"),
      ),
      now,
    ))
  }

  @Test
  fun auto_settles_quiet_threads_after_window() {
    val quiet = summary("q", updatedAt = "2026-08-01T12:00:00Z")
    assertTrue(isEffectivelySettled(quiet, now, settlementSupported = true, autoSettleAfterDays = 3))
    val recent = summary("r", updatedAt = "2026-08-08T11:00:00Z")
    assertFalse(isEffectivelySettled(recent, now, settlementSupported = true, autoSettleAfterDays = 3))
  }

  @Test
  fun explicit_active_override_suppresses_auto_settle() {
    val active = summary(
      "active",
      updatedAt = "2026-08-01T12:00:00Z",
      settledOverride = "active",
    )

    assertFalse(isEffectivelySettled(active, now, settlementSupported = true, autoSettleAfterDays = 3))
  }

  @Test
  fun lifecycle_actions_are_blocked_while_thread_needs_attention() {
    val running = summary("running", session = ThreadSession("running", "turn-1", null))
    val approval = summary("approval", hasPendingApprovals = true)
    val ready = summary("ready")

    assertFalse(canSettleThread(running))
    assertFalse(canSnoozeThread(running))
    assertFalse(canSettleThread(approval))
    assertFalse(canSnoozeThread(approval))
    assertTrue(canSettleThread(ready))
    assertTrue(canSnoozeThread(ready))
  }

  @Test
  fun resolves_provider_driver_from_instance_or_label() {
    assertEquals(
      "claudeAgent",
      resolveProviderDriver(
        "claude-1",
        listOf(
          com.t3tools.android.protocol.ProviderModel(
            instanceId = "claude-1",
            providerLabel = "Claude Code",
            model = "opus",
            modelLabel = "Opus",
            isDefault = true,
            rawSelection = kotlinx.serialization.json.JsonObject(emptyMap()),
          ),
        ),
      ),
    )
    assertEquals("codex", resolveProviderDriver("openai-codex", emptyList()))
    assertEquals("cursor", resolveProviderDriver("cursor", emptyList()))
  }

  @Test
  fun moves_pinned_threads_with_fractional_keys() {
    val ordered = listOf(
      summary("a", pinnedAt = now.toString(), pinOrderKey = "g"),
      summary("b", pinnedAt = now.toString(), pinOrderKey = "m"),
      summary("c", pinnedAt = now.toString(), pinOrderKey = "t"),
    )

    val assignment = planPinnedMove(ordered, movedId = "b", direction = -1).single()

    assertEquals("b", assignment.threadId)
    assertTrue(assignment.orderKey < "g")
  }

  private fun summary(
    id: String,
    projectId: String = "proj",
    title: String = id,
    updatedAt: String = "2026-08-08T11:00:00Z",
    createdAt: String = updatedAt,
    archivedAt: String? = null,
    settledOverride: String? = null,
    settledAt: String? = null,
    snoozedUntil: String? = null,
    snoozedAt: String? = null,
    pinnedAt: String? = null,
    pinOrderKey: String? = null,
    hasPendingApprovals: Boolean = false,
    hasPendingUserInput: Boolean = false,
    session: ThreadSession? = null,
    latestTurn: LatestTurn? = null,
  ) = ThreadSummary(
    id = id,
    projectId = projectId,
    title = title,
    modelSelection = ModelSelection("i", "m"),
    runtimeMode = "full-access",
    interactionMode = "default",
    branch = null,
    worktreePath = null,
    latestTurn = latestTurn,
    session = session,
    createdAt = createdAt,
    updatedAt = updatedAt,
    archivedAt = archivedAt,
    settledOverride = settledOverride,
    settledAt = settledAt,
    snoozedUntil = snoozedUntil,
    snoozedAt = snoozedAt,
    pinnedAt = pinnedAt,
    pinOrderKey = pinOrderKey,
    hasPendingApprovals = hasPendingApprovals,
    hasPendingUserInput = hasPendingUserInput,
  )
}
