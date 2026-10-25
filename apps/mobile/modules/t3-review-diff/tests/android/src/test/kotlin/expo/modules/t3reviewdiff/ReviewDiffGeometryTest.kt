package expo.modules.t3reviewdiff

import android.graphics.Color
import android.view.View
import kotlin.math.ceil
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffGeometryTest {
  @Test
  fun geometryChangesKeepTheVisibleRowAndClampWithinShortenedRows() {
    val parent = T3ReviewDiffView(RuntimeEnvironment.getApplication(), AppContext())
    val canvas = parent.getChildAt(0)
    val spec = View.MeasureSpec.makeMeasureSpec(390, View.MeasureSpec.EXACTLY)
    canvas.measure(spec, spec)
    canvas.layout(0, 0, 390, 600)
    try {
      val rows = listOf("highlights.c", "simd128.h").flatMap { file ->
        listOf(row("$file:header", "").copy(kind = "file", fileId = file)) +
          List(100) { line ->
            row("$file:line:$line", "long native code ".repeat(line % 9 + 1)).copy(fileId = file)
          }
      }
      call(canvas, "setRows", rows)
      val index = 130
      fun position(intra: Int) {
        call(canvas, "setVerticalOffset", (call(canvas, "rowTop", index) as Int) + intra)
      }
      fun assertPosition(intra: Int, reason: String) {
        val top = call(canvas, "verticalOffset") as Int
        assertEquals("$reason: visible row/file changed", index, call(canvas, "rowIndexAt", top))
        assertEquals(
          "$reason: intra-row position changed",
          intra,
          top - (call(canvas, "rowTop", index) as Int)
        )
      }
      position(7)
      call(parent, "scrollToY", 0, true)
      val scroller = field(parent, "verticalScroller") as android.widget.OverScroller
      assertTrue(!scroller.isFinished)
      parent.setStyleJson("{\"wordWrap\":true}")
      assertPosition(7, "wrap on")
      assertTrue(
        "Geometry correction must stop the old absolute scroll trajectory",
        scroller.isFinished
      )
      parent.computeScroll()
      assertPosition(7, "after interrupted animation")
      parent.setStyleJson("{\"wordWrap\":true,\"codeFontSize\":22}")
      assertPosition(7, "font change")
      canvas.layout(0, 0, 280, 600)
      assertPosition(7, "wrapped width change")
      val height =
        (call(canvas, "rowTop", index + 1) as Int) - (call(canvas, "rowTop", index) as Int)
      position(height - 2)
      parent.setStyleJson("{\"wordWrap\":false,\"rowHeight\":24}")
      val shorterHeight =
        (call(canvas, "rowTop", index + 1) as Int) - (call(canvas, "rowTop", index) as Int)
      assertPosition(shorterHeight - 1, "unwrap clamps inside shortened row")
      parent.setContentResetKey("new-content")
      parent.setStyleJson("{\"wordWrap\":true}")
      assertEquals(0, call(canvas, "verticalOffset"))
    } finally {
      parent.cleanup()
    }
  }

  @Test
  fun stickyHeadersUseTheHeaderIndexAndKeepPushOffAndHitTesting() {
    val parent = T3ReviewDiffView(RuntimeEnvironment.getApplication(), AppContext())
    val canvas = parent.getChildAt(0)
    val spec = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(spec, spec)
    canvas.layout(0, 0, 320, 320)
    try {
      val rows = CountingRows(
        List(10000) { index ->
          row("row:$index", "const value = $index").copy(
            kind = if (index == 100 || index == 9000) "file" else "line",
            fileId = if (index < 9000) "first" else "second",
          )
        }
      )
      call(canvas, "setRows", rows)
      assertEquals(null, call(canvas, "stickyFileHeader", 0))
      val nextTop = call(canvas, "rowTop", 9000) as Int
      call(canvas, "setVerticalOffset", nextTop - 10)
      rows.reads = 0
      val sticky = requireNotNull(call(canvas, "stickyFileHeader", 8999))
      assertEquals(100, field(sticky, "index"))
      assertEquals(10, field(sticky, "bottom"))
      assertTrue("sticky lookup must not scan code rows: ${rows.reads}", rows.reads < 10)
      val hit = requireNotNull(call(canvas, "rowHitAt", 5f))
      assertEquals("row:100", (field(hit, "row") as DiffRow).id)
      val second = requireNotNull(call(canvas, "stickyFileHeader", 9000))
      assertEquals(9000, field(second, "index"))
      call(canvas, "setRows", listOf(row("only", "value")))
      assertEquals(null, call(canvas, "stickyFileHeader", 0))
    } finally {
      parent.cleanup()
    }
  }

  @Test
  fun asciiSyntaxArrivalDoesNotRebuildWrappedOffsetsOrRetainPerRowLayouts() {
    val parent = T3ReviewDiffView(RuntimeEnvironment.getApplication(), AppContext())
    val canvas = parent.getChildAt(0)
    val spec = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(spec, spec)
    canvas.layout(0, 0, 320, 320)
    try {
      call(canvas, "setStyle", DiffStyle.defaults(1f).copy(wordWrap = true))
      val rows = List(10000) { row("row:$it", "const value = 123; ".repeat(10)) }
      call(canvas, "setRows", rows)
      val offsets = field(canvas, "rowOffsets")
      call(
        canvas,
        "setTokensByRowId",
        mapOf(rows[0].id to listOf(DiffToken(rows[0].content, 0xff008800.toInt(), 2)))
      )
      assertSame("ASCII syntax must only repaint", offsets, field(canvas, "rowOffsets"))
      val drawing = requireNotNull(field(canvas, "drawing"))
      val cache = requireNotNull(field(drawing, "codeLayouts"))
      assertEquals(
        "offscreen ASCII must not retain layout objects",
        0,
        (field(cache, "entries") as Map<*, *>).size
      )
    } finally {
      parent.cleanup()
    }
  }

  @Test
  fun asciiWidthCacheDoesNotRetainPerRowMeasurementObjects() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val rows = List(10000) { row("row:$it", "const value = $it") }
    drawing.contentWidth(rows, emptyMap(), DiffStyle.defaults(1f))
    assertEquals(0, (field(drawing, "widthEntries") as Map<*, *>).size)
  }

  @Test
  fun asciiWidthMatchesPaintForEverySyntaxFontAndWeight() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val content = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
      "[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
    val row = row("ascii", content)
    for (weight in listOf("regular", "medium", "bold")) {
      val style = DiffStyle.defaults(1f).copy(codeFontWeight = weight, codeFontSizePx = 17f)
      for (fontStyle in 0..7) {
        drawing.configureCodePaint(Color.RED, fontStyle, style)
        val expected = ceil(
          style.changeBarWidthPx + style.gutterWidthPx + style.codePaddingPx * 2f +
            drawing.textPaint.measureText(content),
        ).toInt()
        val tokens = mapOf(row.id to listOf(DiffToken(content, Color.RED, fontStyle)))
        assertEquals(
          "weight=$weight style=$fontStyle",
          expected,
          drawing.contentWidth(listOf(row), tokens, style)
        )
        val recolored = mapOf(row.id to listOf(DiffToken(content, Color.BLUE, fontStyle xor 4)))
        assertEquals(false, drawing.tokensChangeWidth(tokens, recolored, style))
      }
    }
  }

  @Test
  fun lazyAsciiHeightAndLineStartsMatchTheExistingLayoutAtEveryBoundary() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val style = DiffStyle.defaults(1f).copy(wordWrap = true, codeFontSizePx = 17f)
    drawing.configureCodePaint(Color.BLACK, 0, style)
    val paint = android.text.TextPaint(drawing.textPaint)
    val cache = CodeLayoutCache()
    for (width in listOf(120, 180, 280, 420)) {
      for (length in listOf(0, 1, 13, 14, 15, 1000)) {
        val row = row("ascii", "a".repeat(length))
        val expected = createCodeLines(row.content, paint, width)
        val wrapped = cache.layout(
          listOf(row),
          emptyMap(),
          paint,
          style,
          DiffTheme.fallback("light"),
          width
        )
        assertTrue(expected.starts.contentEquals(wrapped.lines(row).starts))
        assertEquals(expected.firstHeight(24) + expected.extraHeight, wrapped.rowHeight(row, 24))
      }
    }
  }

  @Test
  fun unwrappedColorAndUnderlinePatchesDoNotReadOffscreenRows() {
    val parent = T3ReviewDiffView(RuntimeEnvironment.getApplication(), AppContext())
    val canvas = parent.getChildAt(0)
    try {
      val rows = CountingRows(List(10000) { row("row:$it", "const value = $it") })
      call(canvas, "setRows", rows)
      val content = rows[0].content
      rows.reads = 0
      call(canvas, "setTokensByRowId", mapOf("row:0" to listOf(DiffToken(content, Color.RED, 0))))
      call(canvas, "setTokensByRowId", mapOf("row:0" to listOf(DiffToken(content, Color.BLUE, 4))))
      assertEquals(0, rows.reads)
    } finally {
      parent.cleanup()
    }
  }

  private fun call(target: Any, name: String, vararg args: Any): Any? = target.javaClass
    .declaredMethods.single { it.name == name && it.parameterCount == args.size }
    .apply { isAccessible = true }.invoke(target, *args)

  private fun field(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name)
    .apply { isAccessible = true }.get(target)

  private fun row(id: String, content: String) = DiffRow(
    kind = "line", id = id, fileId = "file", filePath = "test.ts", previousPath = null,
    changeType = "modified", additions = 1, deletions = 0, text = "", content = content,
    change = "add", oldLineNumber = null, newLineNumber = 1, wordDiffRanges = emptyList(),
    commentText = "", commentRangeLabel = "", commentSectionTitle = "",
  )

  private class CountingRows(private val rows: List<DiffRow>) : AbstractList<DiffRow>() {
    var reads = 0
    override val size: Int get() = rows.size
    override fun get(index: Int): DiffRow {
      reads += 1
      return rows[index]
    }
  }
}
