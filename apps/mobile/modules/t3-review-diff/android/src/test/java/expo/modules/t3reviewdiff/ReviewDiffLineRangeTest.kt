package expo.modules.t3reviewdiff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewDiffLineRangeTest {
  private val rows = listOf(
    row("first", "a"),
    row("hunk", "a", kind = "hunk"),
    row("last", "a"),
    row("other", "b"),
  )

  @Test
  fun selectsLinesAcrossHunksInEitherDirection() {
    val range = ReviewDiffLineRange()
    assertTrue(range.begin(0, rows))
    assertEquals("first" to "last", range.update(0, 2, rows))
    assertEquals(setOf("first", "last"), range.selectedRowIds)
    assertNull(range.update(0, 2, rows))
    assertEquals("first" to "last", range.update(2, 0, rows))
    assertEquals(setOf("first", "last"), range.selectedRowIds)
  }

  @Test
  fun refusesOtherFilesAndNonLineEndpointsWithoutLosingTheSelection() {
    val range = ReviewDiffLineRange()
    range.begin(0, rows)
    range.update(0, 2, rows)
    assertNull(range.update(0, 3, rows))
    assertNull(range.update(0, 1, rows))
    assertNull(range.update(-1, 2, rows))
    assertEquals(0, range.startIndex)
    assertEquals(2, range.endIndex)
    assertEquals(setOf("first", "last"), range.selectedRowIds)
  }

  @Test
  fun draggingTheStartHandleAnchorsTheOtherEndAndSkipsHeaders() {
    val range = ReviewDiffLineRange()
    range.begin(0, rows)
    range.update(0, 2, rows)
    range.isDragging = false
    assertTrue(range.dragHandle(movingStart = true))
    assertEquals(2, range.startIndex)
    assertEquals(0, range.endIndex)
    assertEquals(2, range.nearestLine(1))
    assertEquals(2, range.nearestLine(99))
    assertEquals(0, range.nearestLine(-1))
    assertTrue(range.dragHandle(movingStart = false))
    assertEquals(0, range.startIndex)
    assertEquals(2, range.endIndex)
  }

  @Test
  fun handleHitAreasFollowScrolledGeometryAndPreferTheStartWhenTheyOverlap() {
    val range = ReviewDiffLineRange()
    range.begin(0, rows)
    range.update(0, 2, rows)
    val centers = range.centers(rows, intArrayOf(0, 20, 40, 60, 80), 10, 12f)
    assertEquals(Pair(12f, -10f) to Pair(12f, 50f), centers)
    assertEquals(true, range.handleAt(12f, -10f, 22f, centers))
    assertEquals(false, range.handleAt(12f, 50f, 22f, centers))
    assertNull(range.handleAt(100f, 100f, 22f, centers))
    range.update(0, 0, rows)
    val overlapping = range.centers(rows, intArrayOf(0, 20, 40, 60, 80), 0, 12f)
    assertEquals(true, range.handleAt(12f, 10f, 22f, overlapping))
  }

  @Test
  fun clearingRowsRetiresTheRangeAndItsDragHandles() {
    val range = ReviewDiffLineRange()
    range.begin(0, rows)
    range.update(0, 2, rows)
    range.clear()
    assertNull(range.startIndex)
    assertNull(range.endIndex)
    assertTrue(range.selectedRowIds.isEmpty())
    assertFalse(range.isDragging)
    assertFalse(range.dragHandle(movingStart = true))
    assertNull(range.centers(rows, intArrayOf(0, 20, 40, 60, 80), 0, 12f))
  }

  private fun row(id: String, fileId: String, kind: String = "line") = DiffRow(
    kind = kind,
    id = id,
    fileId = fileId,
    filePath = "$fileId.ts",
    previousPath = null,
    changeType = "modified",
    additions = 0,
    deletions = 0,
    text = "",
    content = "",
    change = "context",
    oldLineNumber = null,
    newLineNumber = null,
    wordDiffRanges = emptyList(),
    commentText = "",
    commentRangeLabel = "",
    commentSectionTitle = "",
  )
}
