package com.t3tools.android.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ChatReducersTest {
  @Test
  fun `generated domain fixtures reduce into chat state`() {
    val fixtures = requireNotNull(javaClass.getResource("/effect-rpc.json"))
      .readText()
      .let(Json::parseToJsonElement)
      .jsonObject
      .getValue("domain")
      .jsonObject

    val shell = ShellState().reduce(fixtures.getValue("shellSnapshot").jsonObject)
    val thread = ThreadState()
      .reduce(fixtures.getValue("threadSnapshot").jsonObject)
      .reduce(fixtures.getValue("assistantDelta").jsonObject)

    assertEquals("T3 Code", shell.projects.getValue("project-1").title)
    assertEquals("Hello", thread.detail?.messages?.single()?.text)
  }

  @Test
  fun `shell snapshot and events preserve monotonic sequence`() {
    val snapshot = json(
      """
      {
        "kind":"snapshot",
        "snapshot":{
          "snapshotSequence":10,
          "projects":[{
            "id":"project-1","title":"T3","workspaceRoot":"/repo",
            "defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},
            "scripts":[]
          }],
          "threads":[${threadSummaryJson("Original")}]
        }
      }
      """,
    )
    val initial = ShellState().reduce(snapshot)
    val updated = initial.reduce(
      json(
        """
        {"kind":"thread-upserted","sequence":11,"thread":${threadSummaryJson("Updated")}}
        """,
      ),
    )
    val duplicate = updated.reduce(
      json(
        """
        {"kind":"thread-upserted","sequence":11,"thread":${threadSummaryJson("Duplicate")}}
        """,
      ),
    )

    assertEquals(10, initial.sequence)
    assertEquals("Updated", updated.threads.getValue("thread-1").title)
    assertSame(updated, duplicate)
    assertTrue(updated.reduce(json("""{"kind":"synchronized"}""")).synchronized)
  }

  @Test
  fun `new subscriptions retain cached data but await a fresh synchronization marker`() {
    val shell = ShellState(sequence = 8, synchronized = true).awaitingSynchronization()
    val thread = ThreadState(sequence = 9, synchronized = true).awaitingSynchronization()

    assertEquals(8, shell.sequence)
    assertFalse(shell.synchronized)
    assertEquals(9, thread.sequence)
    assertFalse(thread.synchronized)
  }

  @Test
  fun `thread reducer appends streaming deltas once`() {
    val initial = ThreadState().reduce(threadSnapshot())
    val first = initial.reduce(messageEvent(21, "Hi ", streaming = true))
    val duplicate = first.reduce(messageEvent(21, "Hi ", streaming = true))
    val complete = duplicate.reduce(messageEvent(22, "there", streaming = false))

    assertEquals("Hi ", first.detail?.messages?.single()?.text)
    assertSame(first, duplicate)
    assertEquals("there", complete.detail?.messages?.single()?.text)
    assertFalse(complete.detail?.messages?.single()?.streaming ?: true)
  }

  @Test
  fun `thread reducer preserves image attachments across streaming updates`() {
    val attached = ThreadState().reduce(threadSnapshot()).reduce(
      messageEvent(
        21,
        "",
        streaming = true,
        attachments = """
          [{"id":"attachment-1","type":"image","name":"photo.png","mimeType":"image/png","sizeBytes":3}]
        """.trimIndent(),
      ),
    )
    val updated = attached.reduce(messageEvent(22, "Done", streaming = false))

    assertEquals("attachment-1", updated.detail?.messages?.single()?.attachments?.single()?.id)
    assertEquals("image/png", updated.detail?.messages?.single()?.attachments?.single()?.mimeType)
  }

  @Test
  fun `thread reducer tracks the active turn until its session settles`() {
    val running = ThreadState().reduce(threadSnapshot()).reduce(
      threadEvent(
        21,
        "thread.session-set",
        """{"session":{"status":"running","activeTurnId":"turn-1","lastError":null,"updatedAt":"2026-08-08T00:00:01Z"}}""",
      ),
    )
    val commentary = running.reduce(messageEvent(22, "Checking", streaming = false))
    val completed = commentary.reduce(
      threadEvent(
        23,
        "thread.session-set",
        """{"session":{"status":"idle","activeTurnId":null,"lastError":null,"updatedAt":"2026-08-08T00:00:18Z"}}""",
      ),
    )

    assertEquals("running", commentary.detail?.summary?.latestTurn?.state)
    assertEquals("2026-08-08T00:00:01Z", commentary.detail?.summary?.latestTurn?.startedAt)
    assertEquals("completed", completed.detail?.summary?.latestTurn?.state)
    assertEquals("2026-08-08T00:00:18Z", completed.detail?.summary?.latestTurn?.completedAt)
  }

  @Test
  fun `thread snapshot preserves activity sequence`() {
    val state = ThreadState().reduce(
      threadSnapshot(
        activities = """[{"id":"activity-1","tone":"tool","kind":"tool.completed","summary":"Done","payload":{},"turnId":"turn-1","createdAt":"2026-08-08T00:00:01Z","sequence":12}]""",
      ),
    )

    assertEquals(12, state.detail?.activities?.single()?.sequence)
  }

  @Test
  fun `thread snapshot exposes older turn pagination without resetting the requested window`() {
    val state = ThreadState(loadedTurnLimit = 30).reduce(
      threadSnapshot(page = """{"beforeCursor":"cursor-1","hasMore":true,"snapshotSequence":20}"""),
    )
    val page = requireNotNull(state.page)

    assertEquals("cursor-1", page.beforeCursor)
    assertTrue(page.hasMore)
    assertFalse(page.loadingOlder)
    assertEquals(30, state.loadedTurnLimit)
  }

  @Test
  fun `unknown thread event advances sequence without changing detail`() {
    val initial = ThreadState().reduce(threadSnapshot())
    val updated = initial.reduce(
      json(
        """
        {"kind":"event","event":{"sequence":21,"type":"thread.future-event","payload":{}}}
        """,
      ),
    )

    assertEquals(21, updated.sequence)
    assertEquals(initial.detail, updated.detail)
  }

  @Test
  fun `thread lifecycle events preserve explicit settle and snooze state`() {
    val settled = ThreadState().reduce(threadSnapshot()).reduce(
      threadEvent(21, "thread.settled", """{"settledAt":"2026-08-08T01:00:00Z"}"""),
    )
    val active = settled.reduce(
      threadEvent(22, "thread.unsettled", """{"reason":"user"}"""),
    )
    val snoozed = active.reduce(
      threadEvent(
        23,
        "thread.snoozed",
        """{"snoozedAt":"2026-08-08T02:00:00Z","snoozedUntil":"2026-08-09T02:00:00Z"}""",
      ),
    )

    assertEquals("settled", settled.detail?.summary?.settledOverride)
    assertEquals("active", active.detail?.summary?.settledOverride)
    assertEquals(null, active.detail?.summary?.settledAt)
    assertEquals("2026-08-08T02:00:00Z", snoozed.detail?.summary?.snoozedAt)
  }

  @Test
  fun `activities derive open approvals and user questions`() {
    val state = ThreadState().reduce(
      threadSnapshot(
        activities = """
          [
            {"id":"a1","tone":"approval","kind":"approval.requested","summary":"Approve","payload":{"requestId":"r1","requestKind":"command","detail":"Run tests"},"turnId":"turn-1","createdAt":"2026-08-08T00:00:01Z"},
            {"id":"a2","tone":"approval","kind":"user-input.requested","summary":"Choose","payload":{"requestId":"r2","questions":[{"id":"q1","header":"Mode","question":"Which mode?","options":[{"label":"Safe","description":"Read only"}],"multiSelect":false}]},"turnId":"turn-1","createdAt":"2026-08-08T00:00:02Z"}
          ]
        """.trimIndent(),
      ),
    )

    assertEquals("Run tests", state.detail?.approvals?.single()?.detail)
    assertEquals("Which mode?", state.detail?.userInputs?.single()?.questions?.single()?.question)
  }

  private fun threadSnapshot(
    activities: String = "[]",
    page: String? = null,
  ) = json(
    """
    {
      "kind":"snapshot",
      "snapshot":{
        "snapshotSequence":20,
        "thread":{
          ${threadSummaryJson("Thread").removePrefix("{").removeSuffix("}")},
          "messages":[],
          "activities":$activities
        }${page?.let { ",\"page\":$it" }.orEmpty()}
      }
    }
    """,
  )

  private fun messageEvent(
    sequence: Long,
    text: String,
    streaming: Boolean,
    attachments: String = "[]",
  ) = json(
    """
    {
      "kind":"event",
      "event":{
        "sequence":$sequence,
        "type":"thread.message-sent",
        "payload":{
          "messageId":"message-1","role":"assistant","text":"$text",
          "attachments":$attachments,
          "turnId":"turn-1","streaming":$streaming,
          "createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:01Z"
        }
      }
    }
    """,
  )

  private fun threadEvent(sequence: Long, type: String, payload: String) = json(
    """
    {"kind":"event","event":{"sequence":$sequence,"type":"$type","payload":$payload}}
    """,
  )

  private fun threadSummaryJson(title: String) =
    """
    {
      "id":"thread-1","projectId":"project-1","title":"$title",
      "modelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},
      "runtimeMode":"full-access","interactionMode":"default",
      "branch":null,"worktreePath":null,"latestTurn":null,"session":null,
      "updatedAt":"2026-08-08T00:00:00Z",
      "archivedAt":null,
      "hasPendingApprovals":false,"hasPendingUserInput":false
    }
    """.trimIndent()

  private fun json(value: String) = Json.parseToJsonElement(value) as JsonObject
}
