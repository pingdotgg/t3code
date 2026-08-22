package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

class SequenceCursorTest {
  private val json = Json

  @Test
  fun drops_replayed_and_duplicate_events() {
    val cursor = SequenceCursor(10)
    val replay = item(10)
    val next = item(11)

    assertNull(cursor.accept(replay))
    assertEquals(11, cursor.accept(next)?.sequence)
    assertNull(cursor.accept(next))
    assertEquals(11, cursor.sequence)
  }

  @Test
  fun shell_snapshot_exposes_thread_ids_for_atomic_retry_recovery() {
    val snapshot = json.parseToJsonElement(
      """{"kind":"snapshot","snapshot":{"snapshotSequence":12,"projects":[],"threads":[{"id":"thread-1"}]}}""",
    ).jsonObject.toShellSnapshot()

    assertEquals(setOf("thread-1"), snapshot.threadIds)
    assertEquals(12, snapshot.sequence)
  }

  private fun item(sequence: Long) = json.parseToJsonElement(
    """{"kind":"event","event":{"sequence":$sequence}}""",
  ).jsonObject
}
