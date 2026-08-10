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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        activity(
          "plan",
          "turn.plan.updated",
          "Plan updated",
          "turn-1",
          "2026-08-09T00:00:04Z",
          json("""{"plan":[{"step":"Read files","status":"completed"}]}"""),
        ),
        activity("tool", "tool.completed", "Read files", "turn-1", "2026-08-09T00:00:05Z"),
      ),
    )
    val feed = buildThreadFeed(detail)

    val collapsed = presentThreadFeed(feed, turn, emptySet())
    assertEquals(listOf("turn-fold:turn-1", "turn-plan:turn-1", "final"), collapsed.map { it.id })
    assertEquals("Worked for 17s", (collapsed.first() as ThreadFeedItem.TurnFold).label)

    assertEquals(
      listOf("turn-fold:turn-1", "commentary", "turn-plan:turn-1", "tool", "final"),
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

  @Test
  fun keeps_one_latest_plan_per_turn_at_its_first_timeline_position() {
    val activities = listOf(
      activity(
        "plan-1",
        "turn.plan.updated",
        "Plan updated",
        "turn-1",
        "2026-08-09T00:00:02Z",
        json("""{"explanation":"Initial","plan":[{"step":"Inspect code","status":"inProgress"},{"step":"Implement UI","status":"pending"}]}"""),
      ),
      activity(
        "plan-2",
        "turn.plan.updated",
        "Plan updated",
        "turn-1",
        "2026-08-09T00:00:05Z",
        json("""{"plan":[{"step":"Inspect code","status":"completed"},{"step":"Implement UI","status":"inProgress"}]}"""),
      ),
    )

    val plan = buildThreadFeed(detail(activities = activities)).single() as ThreadFeedItem.Plan
    assertEquals("turn-plan:turn-1", plan.id)
    assertEquals("2026-08-09T00:00:02Z", plan.createdAt)
    assertEquals(
      listOf(ThreadPlanStepStatus.Completed, ThreadPlanStepStatus.InProgress),
      plan.steps.map { it.status },
    )
    assertEquals("Implement UI", plan.currentStepLabel)
  }

  @Test
  fun removes_a_turn_plan_when_a_later_snapshot_clears_it() {
    val activities = listOf(
      activity(
        "plan-1",
        "turn.plan.updated",
        "Plan updated",
        "turn-1",
        "2026-08-09T00:00:02Z",
        json("""{"plan":[{"step":"Inspect code","status":"inProgress"}]}"""),
      ),
      activity(
        "plan-2",
        "turn.plan.updated",
        "Plan updated",
        "turn-1",
        "2026-08-09T00:00:03Z",
        json("""{"plan":[]}"""),
      ),
    )

    assertTrue(buildThreadFeed(detail(activities = activities)).isEmpty())
  }

  @Test
  fun shows_the_running_turns_current_plan_step_in_the_working_row() {
    val turn = LatestTurn("turn-1", "running", startedAt = "2026-08-09T00:00:01Z")
    val feed = buildThreadFeed(
      detail(
        latestTurn = turn,
        activities = listOf(
          activity(
            "plan-1",
            "turn.plan.updated",
            "Plan updated",
            "turn-1",
            "2026-08-09T00:00:02Z",
            json("""{"plan":[{"step":"Inspect code","status":"completed"},{"step":"Implement UI","status":"inProgress"}]}"""),
          ),
        ),
      ),
    )

    val working = presentThreadFeed(
      feed,
      turn,
      expandedTurnIds = emptySet(),
      activeWorkStartedAt = "2026-08-09T00:00:01Z",
    ).last() as ThreadFeedItem.Working

    assertEquals("Implement UI", working.stepLabel)
  }

  @Test
  fun starts_working_without_reusing_the_previous_turn() {
    val previousTurn = LatestTurn(
      id = "turn-1",
      state = "completed",
      completedAt = "2026-08-09T00:00:20Z",
      startedAt = "2026-08-09T00:00:01Z",
    )

    val active = deriveActiveWorkPresentation(
      previousTurn,
      ThreadSession("starting", null, null, "2026-08-09T00:01:00Z"),
    )

    assertEquals("2026-08-09T00:01:00Z", active?.startedAt)
    assertNull(active?.turn)
  }

  @Test
  fun adopts_only_the_turn_matching_the_running_session() {
    val runningTurn = LatestTurn("turn-2", "running", startedAt = "2026-08-09T00:01:01Z")

    val mismatched = deriveActiveWorkPresentation(
      runningTurn,
      ThreadSession("running", "turn-3", null, "2026-08-09T00:02:00Z"),
    )
    val matched = deriveActiveWorkPresentation(
      runningTurn,
      ThreadSession("running", "turn-2", null, "2026-08-09T00:01:00Z"),
    )

    assertEquals("2026-08-09T00:02:00Z", mismatched?.startedAt)
    assertNull(mismatched?.turn)
    assertEquals("2026-08-09T00:01:01Z", matched?.startedAt)
    assertEquals(runningTurn, matched?.turn)
  }

  @Test
  fun labels_collapsed_tool_history_like_the_web_client() {
    val feed = buildThreadFeed(
      detail(
        activities = listOf(
          activity("tool-1", "tool.completed", "Read files", "turn-1", "2026-08-09T00:00:01Z"),
          activity("tool-2", "tool.completed", "Run tests", "turn-1", "2026-08-09T00:00:02Z"),
          activity("tool-3", "tool.completed", "Check status", "turn-1", "2026-08-09T00:00:03Z"),
        ),
      ),
    )

    val collapsed = presentThreadFeed(
      feed,
      latestTurn = LatestTurn("turn-1", "running", startedAt = "2026-08-09T00:00:00Z"),
      expandedTurnIds = emptySet(),
    )
      .filterIsInstance<ThreadFeedItem.WorkToggle>()
      .single()
    assertEquals("+2 previous tool calls", workToggleLabel(collapsed))
    assertEquals("Show fewer tool calls", workToggleLabel(collapsed.copy(expanded = true)))
  }

  @Test
  fun formats_the_live_working_timer() {
    assertEquals("0s", formatWorkingTimer("2026-08-09T00:00:00Z", "2026-08-09T00:00:00.900Z"))
    assertEquals("12s", formatWorkingTimer("2026-08-09T00:00:00Z", "2026-08-09T00:00:12Z"))
    assertEquals("1m 5s", formatWorkingTimer("2026-08-09T00:00:00Z", "2026-08-09T00:01:05Z"))
  }

  @Test
  fun keeps_only_the_latest_plan_outside_settled_turn_folds() {
    val latestTurn = LatestTurn(
      id = "turn-2",
      state = "completed",
      completedAt = "2026-08-09T00:00:08Z",
      startedAt = "2026-08-09T00:00:05Z",
    )
    val feed = buildThreadFeed(
      detail(
        latestTurn = latestTurn,
        messages = listOf(
          message("commentary-1", "assistant", "First work", "turn-1", "2026-08-09T00:00:01Z"),
          message("final-1", "assistant", "First done", "turn-1", "2026-08-09T00:00:04Z"),
          message("commentary-2", "assistant", "Second work", "turn-2", "2026-08-09T00:00:05Z"),
          message("final-2", "assistant", "Second done", "turn-2", "2026-08-09T00:00:08Z"),
        ),
        activities = listOf(
          activity(
            "plan-1",
            "turn.plan.updated",
            "Plan updated",
            "turn-1",
            "2026-08-09T00:00:02Z",
            json("""{"plan":[{"step":"First plan","status":"completed"}]}"""),
          ),
          activity(
            "plan-2",
            "turn.plan.updated",
            "Plan updated",
            "turn-2",
            "2026-08-09T00:00:06Z",
            json("""{"plan":[{"step":"Second plan","status":"completed"}]}"""),
          ),
        ),
      ),
    )

    assertEquals(
      listOf("turn-fold:turn-1", "final-1", "turn-fold:turn-2", "turn-plan:turn-2", "final-2"),
      presentThreadFeed(feed, latestTurn, emptySet()).map { it.id },
    )
    assertEquals(
      listOf("turn-fold:turn-1", "commentary-1", "turn-plan:turn-1", "final-1"),
      presentThreadFeed(feed, latestTurn, setOf("turn-1")).take(4).map { it.id },
    )
  }

  @Test
  fun formats_command_tools_without_exposing_the_transport_payload() {
    val group = buildThreadFeed(
      detail(
        activities = listOf(
          activity(
            "command",
            "tool.completed",
            "Ran command",
            "turn-1",
            "2026-08-09T00:00:01Z",
            json(
              """{"itemType":"command_execution","title":"bash","detail":"Tests passed <exited with exit code 0>","data":{"item":{"command":["bun","test"]}}}""",
            ),
          ),
        ),
      ),
    ).single() as ThreadFeedItem.ActivityGroup
    val command = group.activities.single()

    assertEquals(ThreadFeedActivityIcon.Command, command.icon)
    assertEquals("bun test", command.detail)
    assertEquals("bun test\n\nTests passed", command.expandedBody)
  }

  @Test
  fun formats_file_changes_as_a_path_preview_and_readable_file_list() {
    val group = buildThreadFeed(
      detail(
        activities = listOf(
          activity(
            "files",
            "tool.completed",
            "File change",
            "turn-1",
            "2026-08-09T00:00:01Z",
            json(
              """{"itemType":"file_change","data":{"item":{"changes":[{"path":"apps/a.kt"},{"filename":"apps/b.kt"}]}}}""",
            ),
          ),
        ),
      ),
    ).single() as ThreadFeedItem.ActivityGroup
    val files = group.activities.single()

    assertEquals(ThreadFeedActivityIcon.Edit, files.icon)
    assertEquals("apps/a.kt +1 more", files.detail)
    assertEquals("apps/a.kt\napps/b.kt", files.expandedBody)
  }

  @Test
  fun formats_only_the_relevant_mcp_item_as_pretty_json() {
    val group = buildThreadFeed(
      detail(
        activities = listOf(
          activity(
            "mcp",
            "tool.completed",
            "preview_status",
            "turn-1",
            "2026-08-09T00:00:01Z",
            json(
              """{"itemType":"mcp_tool_call","title":"t3-code · preview_status","data":{"toolCallId":"call-1","item":{"server":"t3-code","tool":"preview_status","arguments":{},"status":"completed"}}}""",
            ),
          ),
        ),
      ),
    ).single() as ThreadFeedItem.ActivityGroup
    val mcp = group.activities.single()

    assertEquals(ThreadFeedActivityIcon.Wrench, mcp.icon)
    assertTrue(mcp.expandedBody?.startsWith("MCP call\n{") == true)
    assertFalse(mcp.expandedBody.orEmpty().contains("itemType"))
    assertFalse(mcp.expandedBody.orEmpty().contains("toolCallId"))
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
      createdAt = "2026-08-09T00:00:00Z",
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

  private fun json(value: String) = Json.parseToJsonElement(value)
}
