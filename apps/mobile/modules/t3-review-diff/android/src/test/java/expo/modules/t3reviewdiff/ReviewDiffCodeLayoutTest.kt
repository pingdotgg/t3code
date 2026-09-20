package expo.modules.t3reviewdiff

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffCodeLayoutTest {
  private val paint = TextPaint().apply {
    color = Color.WHITE
    textSize = 24f
    typeface = Typeface.MONOSPACE
  }

  @Test
  fun unicodeAndTabsFitWithoutSplittingClusters() {
    val fixtures = listOf("漢字表示", "e\u0301", "👨‍👩‍👧‍👦", "مرحبا بالعالم ", "\tvalue ")
    for (fixture in fixtures) {
      val text = fixture.repeat(40)
      for (width in listOf(180, 280, 420)) {
        val layout = requireNotNull(createCodeLines(text, paint, width).nativeLayout)
        assertInkFits(layout, width, fixture)
        assertLinesFit(layout, fixture, width)
      }
    }
  }

  private fun assertLinesFit(layout: android.text.StaticLayout, fixture: String, width: Int) {
    val text = layout.text
    for (line in 0 until layout.lineCount) {
      if (!fixture.contains('\t')) {
        assertTrue("$fixture line $line at $width", layout.getLineMax(line) <= width + 1)
      }
      val start = layout.getLineStart(line)
      assertTrue(start == 0 || !Character.isLowSurrogate(text[start]))
      if (fixture == "👨‍👩‍👧‍👦" || fixture == "e\u0301") {
        assertEquals(0, start % fixture.length)
      }
    }
  }

  private fun assertInkFits(layout: android.text.StaticLayout, width: Int, fixture: String) {
    val bitmap = Bitmap.createBitmap(width + 40, layout.height, Bitmap.Config.ARGB_8888)
    layout.draw(Canvas(bitmap))
    for (x in width + 1 until bitmap.width) {
      for (y in 0 until bitmap.height) {
        assertEquals("$fixture ink outside width $width", 0, Color.alpha(bitmap.getPixel(x, y)))
      }
    }
    bitmap.recycle()
  }

  @Test
  fun asciiSegmentsCoverTheWholeLineAndFit() {
    val text = "const value = 123; ".repeat(100)
    val lines = createCodeLines(text, paint, 280)
    val pieces = lines.starts.indices.map {
      text.substring(lines.starts[it], lines.end(it, text.length))
    }
    assertEquals(text, pieces.joinToString(""))
    assertTrue(pieces.all { paint.measureText(it) <= 280 })
  }

  @Test
  fun changingCommentHeightReusesCodeButWidthAndContentInvalidateIt() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(100))
    val comment = row.copy(kind = "comment", id = "comment", content = "", commentText = "Before")
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val first = cache.layout(
      listOf(row, comment),
      emptyMap(),
      paint,
      style,
      theme,
      280
    ).lines(row.id)
    val second = cache.layout(
      listOf(row, comment.copy(commentText = "After")),
      emptyMap(),
      paint,
      style,
      theme,
      280,
    ).lines(row.id)
    assertSame(first, second)
    val narrow = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180).lines(row.id)
    assertNotSame(first, narrow)
    assertTrue(narrow.extraHeight > first.extraHeight)
    val edited = cache.layout(
      listOf(row.copy(content = "短い")),
      emptyMap(),
      paint,
      style,
      theme,
      180
    ).lines(row.id)
    assertTrue(edited.extraHeight < narrow.extraHeight)
    assertEquals(
      0,
      cache.layout(
        listOf(row),
        emptyMap(),
        paint,
        style.copy(wordWrap = false),
        theme,
        180
      ).extraHeight(row.id)
    )
  }

  @Test
  fun highlightsUseNativeTextRangesAndSurviveSyntaxArrival() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(30)).copy(wordDiffRanges = listOf(DiffWordDiffRange(3, 21)))
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val initial = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180).lines(row.id)
    val tokens = mapOf(row.id to listOf(DiffToken(row.content, 0xff008800.toInt(), 2)))
    val highlighted = cache.layout(listOf(row), tokens, paint, style, theme, 180).lines(row.id)
    assertNotSame(initial, highlighted)
    val text = requireNotNull(highlighted.nativeLayout).text as Spanned
    val span = text.getSpans(0, text.length, BackgroundColorSpan::class.java).single()
    assertEquals(3, text.getSpanStart(span))
    assertEquals(21, text.getSpanEnd(span))
  }

  private fun row(content: String) = DiffRow(
    kind = "line", id = "line", fileId = "file", filePath = "test.ts", previousPath = null,
    changeType = "modified", additions = 1, deletions = 0, text = "", content = content,
    change = "add", oldLineNumber = null, newLineNumber = 1, wordDiffRanges = emptyList(),
    commentText = "", commentRangeLabel = "", commentSectionTitle = "",
  )
}
