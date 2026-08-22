package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ReviewCheckpoint
import com.t3tools.android.protocol.ReviewCheckpointFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewStateTest {
  private val patch = """
    diff --git a/src/a.kt b/src/a.kt
    index 111..222 100644
    --- a/src/a.kt
    +++ b/src/a.kt
    @@ -1,2 +1,2 @@ fun main()
    -old value
    +new value
     context
  """.trimIndent()

  @Test
  fun parses_unified_diff_into_stable_render_rows() {
    val result = parseReviewDiff(patch)
    assertTrue(result is ParsedReviewDiff.Files)
    val parsed = result as ParsedReviewDiff.Files
    val file = parsed.files.single()

    assertEquals("src/a.kt", file.path)
    assertEquals(1, parsed.additions)
    assertEquals(1, parsed.deletions)
    assertEquals(listOf("delete", "add", "context"), file.lines.map(ReviewLine::change))
    assertTrue(buildReviewRowsJson(parsed, setOf(file.id), emptySet()).contains("new value"))
  }

  @Test
  fun orders_ready_turn_sections_newest_first() {
    val checkpoints = listOf(1, 2).map { turn ->
      ReviewCheckpoint(
        turnId = "turn-$turn",
        checkpointTurnCount = turn,
        checkpointRef = "ref-$turn",
        status = "ready",
        files = listOf(ReviewCheckpointFile("a.kt", "change", 1, 0)),
        assistantMessageId = null,
        completedAt = "now",
      )
    }

    assertEquals(listOf("Turn 2", "Turn 1"), buildReviewSections(checkpoints, emptyList(), emptyMap()).map(ReviewSection::title))
  }

  @Test
  fun identifies_binary_patches_without_relying_on_the_extension() {
    val result = parseReviewDiff(
      """
        diff --git a/assets/blob.data b/assets/blob.data
        index 111..222 100644
        Binary files a/assets/blob.data and b/assets/blob.data differ
      """.trimIndent(),
    ) as ParsedReviewDiff.Files
    val file = result.files.single()

    assertTrue(file.binary)
    assertTrue(
      buildReviewRowsJson(result, setOf(file.id), emptySet())
        .contains("Binary or non-text file"),
    )
  }

  @Test
  fun round_trips_escaped_contextual_comment() {
    val result = parseReviewDiff(patch)
    assertTrue(result is ParsedReviewDiff.Files)
    val file = (result as ParsedReviewDiff.Files).files.single()
    val section = ReviewSection("turn:1", ReviewSectionKind.Turn, "Turn 1", null, patch)
    val selection = updateReviewSelection(null, section, file, 0, extend = false)
    val extended = updateReviewSelection(selection, section, file, 1, extend = true)
    val formatted = formatReviewComment(extended, "Use <new> & safe")
    val parsed = parseReviewComments(formatted).single()

    assertEquals("src/a.kt", parsed.filePath)
    assertEquals("Use <new> & safe", parsed.text)
    assertEquals(0, parsed.startIndex)
    assertEquals(1, parsed.endIndex)
    assertTrue(parseReviewMessageSegments(formatted).single() is ReviewMessageSegment.Comment)

    val edited = replacePlainReviewMessageText("$formatted\n\nOld prompt", "Updated prompt")
    assertTrue(edited.startsWith("Updated prompt\n\n<review_comment"))
    assertEquals(parsed, parseReviewComments(edited).single())
  }
}
