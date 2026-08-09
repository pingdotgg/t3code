package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ChatMessage
import com.t3tools.android.protocol.LatestTurn
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.ThreadActivity
import com.t3tools.android.protocol.ThreadDetail
import com.t3tools.android.protocol.ThreadSession
import com.t3tools.android.protocol.ThreadSummary
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadFeedModelTest {
  @Test
  fun merges_messages_and_work_in_chronological_order() {
    val detail = detail(
      messages = listOf(
        message("commentary", "assistant", "Checking", "turn-1", "2026-08-09T00:00:02Z"),
        message("final", "assistant", "Done", "turn-1", "2026-08-09T00:00:05Z"),
      ),
      activities = listOf(
        activity("tool", "tool.completed", "Read files", "turn-1", "2026-08-09T00:00:03Z"),
      ),
    )

    assertEquals(listOf("commentary", "tool", "final"), buildThreadFeed(detail).map { it.id })
  }

  @Test
  fun folds_settled_work_but_keeps_the_final_answer_visible() {
    val turn = LatestTurn(
      id = "turn-1",
      state = "completed",
      startedAt = "2026-08-09T00:00:01Z",
      completedAt = "2026-08-09T00:00:18Z",
    )
    val detail = detail(
      latestTurn = turn,
      messages = listOf(
        message("commentary", "assistant", "Checking", "turn-1", "2026-08-09T00:00:02Z"),
        message("final", "assistant", "Done", "turn-1", "2026-08-09T00:00:17Z"),
      ),
      activities = listOf(
        activity("tool", "tool.completed", "Read files", "turn-1", "2026-08-09T00:00:05Z"),
      ),
    )
    val feed = buildThreadFeed(detail)

    val collapsed = presentThreadFeed(feed, turn, emptySet())
    assertEquals(listOf("turn-fold:turn-1", "final"), collapsed.map { it.id })
    assertEquals("Worked for 17s", (collapsed.first() as ThreadFeedItem.TurnFold).label)

    assertEquals(
      listOf("turn-fold:turn-1", "commentary", "tool", "final"),
      presentThreadFeed(feed, turn, setOf("turn-1")).map { it.id },
    )
  }

  @Test
  fun keeps_an_active_turn_expanded() {
    val turn = LatestTurn(
      id = "turn-1",
      state = "running",
      startedAt = "2026-08-09T00:00:01Z",
    )
    val detail = detail(
      latestTurn = turn,
      session = ThreadSession("running", "turn-1", null, "2026-08-09T00:00:01Z"),
      messages = listOf(message("commentary", "assistant", "Checking", "turn-1", "2026-08-09T00:00:02Z")),
      activities = listOf(activity("tool", "tool.completed", "Read files", "turn-1", "2026-08-09T00:00:03Z")),
    )
    val feed = buildThreadFeed(detail)

    assertEquals(feed, presentThreadFeed(feed, turn, emptySet()))
  }

  @Test
  fun filters_noise_and_collapses_tool_lifecycle_rows() {
    val activities = listOf(
      activity("started", "tool.started", "Read files", "turn-1", "2026-08-09T00:00:01Z"),
      activity("updated", "tool.updated", "Read files", "turn-1", "2026-08-09T00:00:02Z", payload("title" to "Read files", "itemType" to "file_read")),
      activity("progress", "tool.progress", "Reading", "turn-1", "2026-08-09T00:00:03Z"),
      activity("completed", "tool.completed", "Read files completed", "turn-1", "2026-08-09T00:00:04Z", payload("title" to "Read files", "itemType" to "file_read")),
      activity("context", "context-window.updated", "Context updated", "turn-1", "2026-08-09T00:00:05Z"),
      activity("checkpoint", "checkpoint.created", "Checkpoint captured", "turn-1", "2026-08-09T00:00:06Z"),
    )

    val group = buildThreadFeed(detail(activities = activities)).single() as ThreadFeedItem.ActivityGroup
    assertEquals(listOf("completed"), group.activities.map { it.id })
    assertEquals("Read files", group.activities.single().summary)
    assertTrue(group.activities.single().toolLike)
  }

  private fun detail(
    messages: List<ChatMessage> = emptyList(),
    activities: List<ThreadActivity> = emptyList(),
    latestTurn: LatestTurn? = null,
    session: ThreadSession? = null,
  ) = ThreadDetail(
    summary = ThreadSummary(
      id = "thread-1",
      projectId = "project-1",
      title = "Thread",
      modelSelection = ModelSelection("codex", "gpt-5.6-sol"),
      runtimeMode = "full-access",
      interactionMode = "default",
      branch = null,
      worktreePath = null,
      latestTurn = latestTurn,
      session = session,
      updatedAt = "2026-08-09T00:00:00Z",
      archivedAt = null,
      hasPendingApprovals = false,
      hasPendingUserInput = false,
    ),
    messages = messages,
    activities = activities,
  )

  private fun message(id: String, role: String, text: String, turnId: String?, createdAt: String) = ChatMessage(
    id = id,
    role = role,
    text = text,
    turnId = turnId,
    streaming = false,
    createdAt = createdAt,
    updatedAt = createdAt,
  )

  private fun activity(
    id: String,
    kind: String,
    summary: String,
    turnId: String?,
    createdAt: String,
    payload: kotlinx.serialization.json.JsonElement = payload(),
  ) = ThreadActivity(
    id = id,
    tone = "tool",
    kind = kind,
    summary = summary,
    payload = payload,
    turnId = turnId,
    createdAt = createdAt,
  )

  private fun payload(vararg values: Pair<String, String>) = Json.parseToJsonElement(
    values.joinToString(prefix = "{", postfix = "}") { (key, value) -> "\"$key\":\"$value\"" },
  )
}
