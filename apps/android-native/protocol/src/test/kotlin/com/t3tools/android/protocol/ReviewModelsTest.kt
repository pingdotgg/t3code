package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

class ReviewModelsTest {
  @Test
  fun builds_review_preview_file_and_turn_payloads() {
    val preview = reviewDiffPreviewPayload("/repo", baseRef = "main")
    val file = reviewDiffFileContentsPayload(
      cwd = "/repo",
      sourceKind = ReviewSourceKind.WorkingTree,
      changeType = "change",
      baseRef = null,
      headRef = null,
      oldPath = "a.kt",
      newPath = "a.kt",
    )
    val turn = reviewTurnDiffPayload("thread-1", 2, 3)

    assertEquals(JsonPrimitive("main"), preview["baseRef"])
    assertEquals(JsonPrimitive(false), preview["ignoreWhitespace"])
    assertEquals(JsonNull, file["baseRef"])
    assertEquals(JsonPrimitive("working-tree"), file["sourceKind"])
    assertEquals(JsonPrimitive(2), turn["fromTurnCount"])
    assertEquals(JsonPrimitive(3), turn["toTurnCount"])
  }

  @Test
  fun decodes_preview_file_contents_and_turn_diff() {
    val preview = Json.parseToJsonElement(
      """{"cwd":"/repo","generatedAt":"2026-08-09T00:00:00Z","sources":[{"id":"working-tree","kind":"working-tree","title":"Working tree","baseRef":null,"headRef":null,"diff":"diff","diffHash":"hash","truncated":true}]}""",
    ).toReviewDiffPreview()
    val contents = Json.parseToJsonElement(
      """{"oldContents":"old","newContents":"new"}""",
    ).toReviewDiffFileContents()
    val turn = Json.parseToJsonElement(
      """{"threadId":"thread-1","fromTurnCount":0,"toTurnCount":1,"diff":"patch"}""",
    ).toReviewTurnDiff()

    assertEquals(ReviewSourceKind.WorkingTree, preview.sources.single().kind)
    assertNull(preview.sources.single().baseRef)
    assertTrue(preview.sources.single().truncated)
    assertEquals("new", contents.newContents)
    assertEquals("patch", turn.diff)
  }

  @Test
  fun thread_reducer_tracks_ready_checkpoints_without_missing_regression() {
    val state = ThreadState().reduce(
      Json.parseToJsonElement(
        """{"kind":"snapshot","snapshot":{"snapshotSequence":1,"thread":{"id":"thread-1","projectId":"project-1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"latestTurn":null,"session":null,"updatedAt":"","archivedAt":null,"hasPendingApprovals":false,"hasPendingUserInput":false,"messages":[],"activities":[],"checkpoints":[{"turnId":"turn-1","checkpointTurnCount":1,"checkpointRef":"ref-1","status":"ready","files":[{"path":"a.kt","kind":"change","additions":2,"deletions":1}],"assistantMessageId":null,"completedAt":"now"}]}}}""",
      ).jsonObject,
    ).reduce(
      Json.parseToJsonElement(
        """{"kind":"event","event":{"sequence":2,"type":"thread.turn-diff-completed","payload":{"turnId":"turn-1","checkpointTurnCount":1,"checkpointRef":"ref-1","status":"missing","files":[],"assistantMessageId":null,"completedAt":"later"}}}""",
      ).jsonObject,
    )

    assertEquals("ready", state.detail?.checkpoints?.single()?.status)
    assertEquals(2, state.detail?.checkpoints?.single()?.files?.single()?.additions)
    assertFalse(state.detail?.checkpoints.isNullOrEmpty())
  }
}
