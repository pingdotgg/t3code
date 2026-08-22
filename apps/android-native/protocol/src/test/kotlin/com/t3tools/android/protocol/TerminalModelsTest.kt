package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

class TerminalModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun decodes_attach_and_metadata_wire_events() {
    val snapshot = json.parseToJsonElement(
      """{"type":"snapshot","snapshot":{"threadId":"thread-1","terminalId":"term-1","cwd":"/repo","worktreePath":null,"status":"running","pid":42,"history":"ready\r\n","exitCode":null,"exitSignal":null,"label":"zsh","updatedAt":"2026-08-09T00:00:00.000Z","sequence":3}}""",
    ).toTerminalAttachEvent()
    val metadata = json.parseToJsonElement(
      """{"type":"upsert","terminal":{"threadId":"thread-1","terminalId":"term-1","cwd":"/repo","worktreePath":null,"status":"running","pid":42,"exitCode":null,"exitSignal":null,"hasRunningSubprocess":true,"label":"bun dev","updatedAt":"2026-08-09T00:00:01.000Z"}}""",
    ).toTerminalMetadataEvent()

    val attached = assertIs<TerminalAttachEvent.Snapshot>(snapshot)
    assertEquals("ready\r\n", attached.snapshot.history)
    assertEquals(3, attached.snapshot.sequence)
    val upsert = assertIs<TerminalMetadataEvent.Upsert>(metadata)
    assertTrue(upsert.terminal.hasRunningSubprocess)
    assertNull(upsert.terminal.worktreePath)
  }

  @Test
  fun reduces_history_output_clear_and_exit_with_utf8_safe_limit() {
    val initial = reduceTerminalBuffer(
      TerminalBufferState(),
      TerminalAttachEvent.Snapshot(
        TerminalSnapshot(
          threadId = "thread-1",
          terminalId = "term-1",
          cwd = "/repo",
          worktreePath = null,
          status = TerminalStatus.Running,
          pid = 42,
          history = "1234🙂",
          exitCode = null,
          exitSignal = null,
          label = "zsh",
          updatedAt = "now",
          sequence = 1,
        ),
      ),
      maxBufferBytes = 5,
    )
    val output = reduceTerminalBuffer(initial, TerminalAttachEvent.Output("é"), 5)
    val cleared = reduceTerminalBuffer(output, TerminalAttachEvent.Cleared, 5)
    val exited = reduceTerminalBuffer(cleared, TerminalAttachEvent.Exited(0, null), 5)

    assertEquals("4🙂", initial.buffer)
    assertEquals("é", output.buffer)
    assertEquals("", cleared.buffer)
    assertEquals(TerminalStatus.Exited, exited.status)
  }

  @Test
  fun allocates_first_available_terminal_id_and_builds_nullable_worktree_payload() {
    assertEquals("term-2", nextTerminalId(listOf("term-1", "term-3", "custom")))
    val payload = terminalOpenPayload("thread-1", "term-2", "/repo", null, 80, 24)

    assertEquals(JsonPrimitive("term-2"), payload["terminalId"])
    assertEquals(JsonNull, payload["worktreePath"])
    assertEquals(JsonPrimitive(80), payload["cols"])
  }
}
