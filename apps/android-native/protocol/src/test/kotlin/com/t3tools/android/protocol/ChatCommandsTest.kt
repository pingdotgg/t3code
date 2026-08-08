package com.t3tools.android.protocol

import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ChatCommandsTest {
  private val now = Instant.parse("2026-08-08T00:00:00Z")
  private val model = JsonObject(
    mapOf(
      "instanceId" to JsonPrimitive("codex"),
      "model" to JsonPrimitive("gpt-5.6-sol"),
    ),
  )

  @Test
  fun `existing turn preserves stable retry ids`() {
    val start = turnStartCommand(
      threadId = "thread-1",
      modelSelection = model,
      prompt = "Continue",
      runtimeMode = "full-access",
      interactionMode = "default",
      commandId = "command-1",
      messageId = "message-1",
      now = now,
    )

    assertEquals("command-1", start.commandId)
    assertEquals("command-1", start.command.required("commandId").jsonPrimitive.content)
    assertEquals(
      "message-1",
      start.command.required("message").jsonObject.required("messageId").jsonPrimitive.content,
    )
  }

  @Test
  fun `atomic worktree start emits one bootstrap command`() {
    val start = atomicStartCommand(
      project = ProjectChoice("project-1", "T3", "/repo", model),
      modelSelection = model,
      prompt = "Implement it",
      worktree = WorktreeBootstrap("/repo", "main", branch = "feat/native"),
      commandId = "command-1",
      messageId = "message-1",
      threadId = "thread-1",
      now = now,
    )

    val bootstrap = start.command.required("bootstrap").jsonObject
    assertEquals("project-1", bootstrap.required("createThread").jsonObject.required("projectId").jsonPrimitive.content)
    assertEquals("main", bootstrap.required("prepareWorktree").jsonObject.required("baseBranch").jsonPrimitive.content)
    assertEquals(false, bootstrap.required("runSetupScript").jsonPrimitive.content.toBoolean())
  }

  @Test
  fun `approval command rejects unknown decisions`() {
    assertFailsWith<IllegalArgumentException> {
      approvalResponseCommand("thread-1", "request-1", "always", now)
    }
  }

  @Test
  fun `user input response requires an answer`() {
    assertFailsWith<IllegalArgumentException> {
      userInputResponseCommand("thread-1", "request-1", emptyMap(), now)
    }
  }
}
