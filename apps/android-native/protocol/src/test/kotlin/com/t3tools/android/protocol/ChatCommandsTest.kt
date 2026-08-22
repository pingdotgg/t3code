package com.t3tools.android.protocol

import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
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
  fun `atomic start can reuse an existing worktree without preparing another`() {
    val start = atomicStartCommand(
      project = ProjectChoice("project-1", "T3", "/repo", model),
      modelSelection = model,
      prompt = "Continue here",
      branch = "feat/native",
      worktreePath = "/repo-native",
      now = now,
    )

    val bootstrap = start.command.required("bootstrap").jsonObject
    val createThread = bootstrap.required("createThread").jsonObject
    assertEquals("feat/native", createThread.required("branch").jsonPrimitive.content)
    assertEquals("/repo-native", createThread.required("worktreePath").jsonPrimitive.content)
    assertEquals(null, bootstrap["prepareWorktree"])
  }

  @Test
  fun `temporary worktree branches match the web format`() {
    assertEquals("t3code/deadbeef", temporaryWorktreeBranchName("DEADBEEF-0000"))
  }

  @Test
  fun `failed atomic start can be retried with fresh ids`() {
    val original = atomicStartCommand(
      project = ProjectChoice("project-1", "T3", "/repo", model),
      modelSelection = model,
      prompt = "Implement it",
      commandId = "command-1",
      messageId = "message-1",
      threadId = "thread-1",
      now = now,
    )
    val retried = rekeyAtomicStartCommand(
      original.command,
      commandId = "command-2",
      messageId = "message-2",
      threadId = "thread-2",
    )

    assertEquals("command-2", retried.command.required("commandId").jsonPrimitive.content)
    assertEquals("thread-2", retried.command.required("threadId").jsonPrimitive.content)
    assertEquals(
      "message-2",
      retried.command.required("message").jsonObject.required("messageId").jsonPrimitive.content,
    )
  }

  @Test
  fun `attachment-only turn emits upload without requiring text`() {
    val start = turnStartCommand(
      threadId = "thread-1",
      modelSelection = model,
      prompt = "",
      attachments = listOf(
        UploadChatImageAttachment("photo.png", "image/png", 3, "data:image/png;base64,AQID"),
      ),
      runtimeMode = "full-access",
      interactionMode = "default",
      now = now,
    )

    val attachment = start.command.required("message").jsonObject
      .required("attachments").jsonArray.single().jsonObject
    assertEquals("image/png", attachment.required("mimeType").jsonPrimitive.content)
    assertEquals("data:image/png;base64,AQID", attachment.required("dataUrl").jsonPrimitive.content)
  }

  @Test
  fun `pending attachment-only turn can be edited before upload materialization`() {
    val start = turnStartCommand(
      threadId = "thread-1",
      modelSelection = model,
      prompt = "",
      pendingAttachmentNames = listOf("photo.png"),
      runtimeMode = "full-access",
      interactionMode = "default",
      now = now,
    )

    val edited = editStartCommand(start.command, "", hasAttachments = true)
    val materialized = withStartCommandAttachments(
      edited,
      listOf(UploadChatImageAttachment("photo.png", "image/png", 3, "data:image/png;base64,AQID")),
    )

    assertEquals(
      "data:image/png;base64,AQID",
      materialized.required("message").jsonObject.required("attachments")
        .jsonArray.single().jsonObject.required("dataUrl").jsonPrimitive.content,
    )
  }

  @Test
  fun `approval command rejects unknown decisions`() {
    assertFailsWith<IllegalArgumentException> {
      approvalResponseCommand("thread-1", "request-1", "always", now)
    }
  }

  @Test
  fun `rename and regenerate use thread metadata updates`() {
    val rename = updateThreadTitleCommand("thread-1", title = "Renamed", commandId = "rename-1")
    val regenerate = updateThreadTitleCommand("thread-1", regenerate = true, commandId = "regen-1")

    assertEquals("thread.meta.update", rename.required("type").jsonPrimitive.content)
    assertEquals("Renamed", rename.required("title").jsonPrimitive.content)
    assertEquals("thread.meta.update", regenerate.required("type").jsonPrimitive.content)
    assertEquals(true, regenerate.required("regenerateTitle").jsonPrimitive.content.toBoolean())
  }

  @Test
  fun `user input response requires an answer`() {
    assertFailsWith<IllegalArgumentException> {
      userInputResponseCommand("thread-1", "request-1", emptyMap(), now)
    }
  }
}
