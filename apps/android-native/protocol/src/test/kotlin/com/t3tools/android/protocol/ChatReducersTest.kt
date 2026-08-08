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

  private fun threadSnapshot(activities: String = "[]") = json(
    """
    {
      "kind":"snapshot",
      "snapshot":{
        "snapshotSequence":20,
        "thread":{
          ${threadSummaryJson("Thread").removePrefix("{").removeSuffix("}")},
          "messages":[],
          "activities":$activities
        }
      }
    }
    """,
  )

  private fun messageEvent(sequence: Long, text: String, streaming: Boolean) = json(
    """
    {
      "kind":"event",
      "event":{
        "sequence":$sequence,
        "type":"thread.message-sent",
        "payload":{
          "messageId":"message-1","role":"assistant","text":"$text",
          "turnId":"turn-1","streaming":$streaming,
          "createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:01Z"
        }
      }
    }
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
