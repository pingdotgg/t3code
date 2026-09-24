package expo.modules.t3reviewdiff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReviewDiffWindowTest {
  @Test
  fun findsRowsAtBoundariesAndClampsOutsideTheViewport() {
    val rows = listOf(row("line", "one", 0), row("line", "two", 1))
    val viewport = DiffSourceViewport(rows, intArrayOf(0, 20, 80), 20)
    assertEquals(0, viewport.rowIndexAt(-1))
    assertEquals(0, viewport.rowIndexAt(19))
    assertEquals(1, viewport.rowIndexAt(20))
    assertEquals(1, viewport.rowIndexAt(100))
  }

  @Test
  fun loadsVisiblePlaceholderAfterCollapsedFileHeaders() {
    val rows = listOf(
      row("file", "first", 0),
      row("file", "last", 200000),
      row("placeholder", "missing", 200000, 3)
    )
    val viewport = DiffSourceViewport(rows, intArrayOf(0, 56, 112, 172), 20)
    assertEquals(200000, viewport.requestedRow(0, 2, 0))
    assertEquals(200002, viewport.requestedRow(2, 2, 152))
  }

  @Test
  fun preservesCommentInsteadOfItsPrecedingSourceLine() {
    val rows = listOf(row("line", "line", 10), row("comment", "comment", 10))
    val anchor = requireNotNull(DiffSourceViewport(rows, intArrayOf(0, 20, 120), 20).anchor(45))
    assertEquals(85, DiffSourceViewport(rows, intArrayOf(0, 60, 160), 20).offset(anchor))
  }

  @Test
  fun preservesSourcePositionWhenPlaceholdersBecomeWrappedLinesAndBack() {
    val missing =
      DiffSourceViewport(listOf(row("placeholder", "gap", 0, 1000)), intArrayOf(0, 20000), 20)
    val anchor = requireNotNull(missing.anchor(105))
    val loadedRows = listOf(row("placeholder", "prefix", 0, 5), row("line", "line5", 5))
    val loaded = DiffSourceViewport(loadedRows, intArrayOf(0, 100, 180), 20)
    assertEquals(105, loaded.offset(anchor))
    assertEquals(105, missing.offset(requireNotNull(loaded.anchor(105))))
  }

  @Test
  fun shortenedPlaceholderWithSameIdDoesNotCaptureLoadedSourceAnchor() {
    val missing =
      DiffSourceViewport(listOf(row("placeholder", "gap", 0, 1000)), intArrayOf(0, 20000), 20)
    val anchor = requireNotNull(missing.anchor(105))
    val loadedRows = listOf(
      row("placeholder", "gap", 0, 4),
      row("line", "wrapped4", 4),
      row("line", "line5", 5)
    )
    val loaded = DiffSourceViewport(loadedRows, intArrayOf(0, 80, 160, 180), 20)
    assertEquals(165, loaded.offset(anchor))
  }

  @Test
  fun emptyViewportDoesNotRequestOrRestoreRows() {
    val viewport = DiffSourceViewport(emptyList(), intArrayOf(0), 20)
    assertNull(viewport.anchor(0))
    assertNull(viewport.requestedRow(0, 0, 0))
    assertNull(viewport.offset(DiffSourceAnchor("old", 0, 0)))
  }

  private fun row(kind: String, id: String, source: Int, count: Int = 1) = DiffRow(
    sourceRow = source, rowCount = count, kind = kind, id = id, fileId = "file",
    filePath = "file.ts", previousPath = null, changeType = "change", additions = 0,
    deletions = 0, text = "", content = "", change = "add", oldLineNumber = null,
    newLineNumber = source + 1, wordDiffRanges = emptyList(), commentText = "",
    commentRangeLabel = "", commentSectionTitle = "",
  )
}
