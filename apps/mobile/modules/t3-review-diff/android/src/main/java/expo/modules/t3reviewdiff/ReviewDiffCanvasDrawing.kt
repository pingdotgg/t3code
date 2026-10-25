package expo.modules.t3reviewdiff

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.TextPaint
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal class ReviewDiffCanvasDrawing(context: Context) {
  private val density = context.resources.displayMetrics.density
  var theme: DiffTheme = DiffTheme.fallback("light")

  val backgroundPaint = Paint()
  val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    hinting = Paint.HINTING_ON
    isSubpixelText = false
    clearShadowLayer()
  }
  val uiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    hinting = Paint.HINTING_ON
    isSubpixelText = false
    clearShadowLayer()
  }

  private val italicCodeTypeface by lazy {
    Typeface.create(ReviewDiffTypefaces.regular, Typeface.ITALIC)
  }
  private val boldItalicCodeTypeface by lazy {
    Typeface.create(ReviewDiffTypefaces.bold, Typeface.ITALIC)
  }

  init {
    textPaint.typeface = ReviewDiffTypefaces.regular
    uiPaint.typeface = Typeface.DEFAULT_BOLD
  }

  fun fileHeaderChevronRect(top: Int, bottom: Int, style: DiffStyle): RectF {
    val centerY = (top + bottom) / 2f
    val left = style.fileHeaderHorizontalPaddingPx
    return RectF(left, centerY - 10f * density, left + 20f * density, centerY + 10f * density)
  }

  fun fileHeaderIconRect(top: Int, bottom: Int, style: DiffStyle): RectF {
    val chevron = fileHeaderChevronRect(top, bottom, style)
    return RectF(
      chevron.right + 8f * density,
      chevron.top,
      chevron.right + 28f * density,
      chevron.bottom,
    )
  }

  fun fileHeaderCheckboxRect(top: Int, bottom: Int, width: Int, style: DiffStyle): RectF {
    val centerY = (top + bottom) / 2f
    val right = width - style.fileHeaderHorizontalPaddingPx
    return RectF(
      right - 20f * density,
      centerY - 10f * density,
      right,
      centerY + 10f * density,
    )
  }

  fun drawDisclosureChevron(
    canvas: Canvas,
    rect: RectF,
    color: Int,
    collapsed: Boolean
  ) {
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = color
    borderPaint.strokeWidth = 2f * density
    borderPaint.strokeCap = Paint.Cap.ROUND
    borderPaint.strokeJoin = Paint.Join.ROUND
    val path = Path()
    if (collapsed) {
      path.moveTo(rect.left + rect.width() * 0.4f, rect.top + rect.height() * 0.28f)
      path.lineTo(rect.left + rect.width() * 0.6f, rect.centerY())
      path.lineTo(rect.left + rect.width() * 0.4f, rect.bottom - rect.height() * 0.28f)
    } else {
      path.moveTo(rect.left + rect.width() * 0.28f, rect.top + rect.height() * 0.42f)
      path.lineTo(rect.centerX(), rect.top + rect.height() * 0.62f)
      path.lineTo(rect.right - rect.width() * 0.28f, rect.top + rect.height() * 0.42f)
    }
    canvas.drawPath(path, borderPaint)
    borderPaint.style = Paint.Style.FILL
  }

  fun drawFileIcon(canvas: Canvas, rect: RectF, changeType: String) {
    val color = when (changeType) {
      "new" -> theme.addText
      "deleted" -> theme.deleteText
      else -> theme.hunkText
    }
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = color
    borderPaint.strokeWidth = 2f * density
    canvas.drawRoundRect(rect, 6f * density, 6f * density, borderPaint)

    if (changeType == "rename-pure" || changeType == "rename-changed" || changeType == "renamed") {
      drawRenameChevronIcon(canvas, rect, color)
    } else {
      backgroundPaint.color = color
      canvas.drawCircle(rect.centerX(), rect.centerY(), 3f * density, backgroundPaint)
    }
    borderPaint.style = Paint.Style.FILL
  }

  fun drawViewedCheckbox(canvas: Canvas, rect: RectF, checked: Boolean) {
    if (checked) {
      backgroundPaint.color = theme.hunkText
      canvas.drawRoundRect(rect, 6f * density, 6f * density, backgroundPaint)
    }
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = if (checked) theme.hunkText else theme.mutedText
    borderPaint.strokeWidth = 1.8f * density
    canvas.drawRoundRect(rect, 6f * density, 6f * density, borderPaint)
    if (checked) {
      borderPaint.color = theme.background
      borderPaint.strokeWidth = 2f * density
      borderPaint.strokeCap = Paint.Cap.ROUND
      borderPaint.strokeJoin = Paint.Join.ROUND
      val path = Path().apply {
        moveTo(rect.left + rect.width() * 0.28f, rect.centerY())
        lineTo(rect.left + rect.width() * 0.44f, rect.bottom - rect.height() * 0.3f)
        lineTo(rect.right - rect.width() * 0.25f, rect.top + rect.height() * 0.3f)
      }
      canvas.drawPath(path, borderPaint)
    }
    borderPaint.style = Paint.Style.FILL
  }

  fun drawNoticeIcon(canvas: Canvas, rect: RectF, color: Int) {
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = color
    borderPaint.strokeWidth = 1.7f * density
    borderPaint.strokeCap = Paint.Cap.ROUND
    canvas.drawOval(rect, borderPaint)
    canvas.drawLine(
      rect.centerX(),
      rect.top + rect.height() * 0.3f,
      rect.centerX(),
      rect.top + rect.height() * 0.58f,
      borderPaint,
    )
    borderPaint.style = Paint.Style.FILL
    canvas.drawCircle(rect.centerX(), rect.bottom - rect.height() * 0.24f, density, borderPaint)
  }

  fun configureUiPaint(paint: Paint, color: Int, size: Float, weight: String) {
    paint.typeface = if (isBoldFontWeight(weight)) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    configureTextPaint(paint, color, size)
  }

  fun configureMonospacePaint(color: Int, size: Float, weight: String) {
    textPaint.typeface = ReviewDiffTypefaces.forWeight(weight)
    configureTextPaint(textPaint, color, size)
  }

  fun configureCodePaint(color: Int, fontStyle: Int, style: DiffStyle) {
    val tokenBold = fontStyle and 2 != 0
    val italic = fontStyle and 1 != 0
    textPaint.typeface = when {
      tokenBold && italic -> boldItalicCodeTypeface
      tokenBold -> ReviewDiffTypefaces.bold
      italic -> italicCodeTypeface
      else -> ReviewDiffTypefaces.forWeight(style.codeFontWeight)
    }
    configureTextPaint(textPaint, color, style.codeFontSizePx)
    textPaint.isUnderlineText = fontStyle and 4 != 0
  }

  var codeLayouts = CodeLayoutCache()

  /** Capture paint on the UI thread; the decode worker owns the new cache until publication. */
  fun prepareRows(
    tokens: Map<String, List<DiffToken>>,
    style: DiffStyle,
    width: Int,
    isCancelled: () -> Boolean = { false }
  ): (List<DiffRow>) -> CodeLayoutCache {
    configureCodePaint(theme.text, 0, style)
    val paint = TextPaint(textPaint)
    val colors = theme
    val cache = codeLayouts.copyForPreparation()
    val availableWidth = (
      width - style.changeBarWidthPx - style.gutterWidthPx -
        style.codePaddingPx * 2f
      ).toInt()
    return { rows ->
      cache.apply { layout(rows, tokens, paint, style, colors, availableWidth, isCancelled) }
    }
  }

  fun codeWrapLayout(
    rows: List<DiffRow>,
    tokens: Map<String, List<DiffToken>>,
    style: DiffStyle,
    width: Int
  ): CodeWrapLayout {
    configureCodePaint(theme.text, 0, style)
    val availableWidth = width - style.changeBarWidthPx - style.gutterWidthPx -
      style.codePaddingPx * 2f
    return codeLayouts.layout(rows, tokens, textPaint, style, theme, availableWidth.toInt())
  }

  private data class WidthEntry(val row: DiffRow, val tokens: List<DiffToken>?, val width: Float)
  private var widthEntries = emptyMap<String, WidthEntry>()
  private var widthRows: List<DiffRow>? = null
  private var widthTokens: Map<String, List<DiffToken>>? = null
  private var widthStyle: DiffStyle? = null
  private var measuredContentWidth = 0
  private var asciiCharacterWidth = 0f
  private var asciiFixedPitch = false

  fun tokensChangeWidth(
    previous: Map<String, List<DiffToken>>,
    next: Map<String, List<DiffToken>>,
    style: DiffStyle
  ): Boolean {
    if (widthStyle != style) return true
    fun changed(id: String): Boolean {
      val before = previous[id]
      val after = next[id]
      if (before == after) return false
      return if (widthEntries.containsKey(id) ||
        before.orEmpty().any { it.fontStyle and 3 != 0 } ||
        after.orEmpty().any { it.fontStyle and 3 != 0 }
      ) {
        // Native run boundaries and fallback fonts can change advances, including ASCII italics.
        before?.size != after?.size || before.orEmpty().indices.any { index ->
          val old = before.orEmpty()[index]
          val new = after.orEmpty()[index]
          old.content != new.content || old.fontStyle and 3 != new.fontStyle and 3
        }
      } else {
        before != null && after != null &&
          before.sumOf { it.content.length } != after.sumOf { it.content.length }
      }
    }
    val changed = next.keys.any(::changed) || previous.keys.any { it !in next && changed(it) }
    // Paint-only patches must not make the next comment/viewport update remeasure rows.
    if (!changed) widthTokens = next
    return changed
  }

  fun contentWidth(
    rows: List<DiffRow>,
    tokens: Map<String, List<DiffToken>>,
    style: DiffStyle
  ): Int {
    if (style.wordWrap) {
      widthEntries = emptyMap()
      widthRows = null
      widthTokens = null
      widthStyle = null
      return 0
    }
    // Comment heights and viewport resizing do not change unwrapped text widths.
    if (widthRows !== rows || widthTokens !== tokens || widthStyle != style) {
      if (widthStyle != style) {
        widthEntries = emptyMap()
        configureCodePaint(theme.text, 0, style)
        asciiCharacterWidth = textPaint.measureText("M")
        // Some system font weights resolve to proportional fallbacks even for "monospace".
        val glyphs = CharArray(95) { (' '.code + it).toChar() }.concatToString()
        val advances = FloatArray(glyphs.length)
        textPaint.getTextWidths(glyphs, advances)
        asciiFixedPitch = advances.all { it == asciiCharacterWidth }
      }
      val next = HashMap<String, WidthEntry>()
      var widest = 0f
      for (row in rows) {
        if (row.kind != "line" && row.kind != "hunk") continue
        val rowTokens = if (row.kind == "line") tokens[row.id] else null
        val asciiWidth = asciiRowWidth(row, rowTokens)
        val measured = if (asciiWidth >= 0f) {
          asciiWidth
        } else {
          val entry = widthEntry(row, rowTokens, style)
          next[row.id] = entry
          entry.width
        }
        widest = max(widest, measured)
      }
      widthEntries = next
      widthRows = rows
      widthTokens = tokens
      widthStyle = style
      measuredContentWidth = ceil(
        style.changeBarWidthPx + style.gutterWidthPx + style.codePaddingPx * 2f + widest,
      ).toInt()
    }
    return measuredContentWidth
  }

  private fun widthEntry(row: DiffRow, tokens: List<DiffToken>?, style: DiffStyle): WidthEntry {
    val cached = widthEntries[row.id]
    return if (cached?.row == row && cached.tokens == tokens) {
      cached
    } else {
      WidthEntry(row, tokens, measureRowWidth(row, tokens, style))
    }
  }

  private fun asciiRowWidth(row: DiffRow, tokens: List<DiffToken>?): Float {
    val fixedPitch = asciiFixedPitch && row.kind == "line" && row.isPlainAscii
    if (!fixedPitch || tokens.orEmpty().any { it.fontStyle and 3 != 0 }) {
      return -1f
    }
    val length = if (tokens.isNullOrEmpty()) {
      row.content.length
    } else {
      tokens.sumOf {
        it.content.length
      }
    }
    return length * asciiCharacterWidth
  }

  private fun measureRowWidth(row: DiffRow, tokens: List<DiffToken>?, style: DiffStyle): Float {
    if (row.kind == "hunk") {
      configureMonospacePaint(theme.hunkText, style.hunkFontSizePx, style.hunkFontWeight)
      return textPaint.measureText(row.text.ifEmpty { row.content })
    }
    val runs = if (tokens.isNullOrEmpty()) listOf(DiffToken(row.content, null, 0)) else tokens
    var width = 0f
    // Match drawCode's run boundaries and fonts, including fallback glyphs and tabs.
    for (run in runs) {
      configureCodePaint(run.color ?: theme.text, run.fontStyle, style)
      width += textPaint.measureText(run.content)
    }
    return width
  }

  fun lineNumberColor(change: String): Int = when (change) {
    "add" -> theme.addText
    "delete" -> theme.deleteText
    else -> theme.mutedText
  }

  fun drawDeleteStripes(
    canvas: Canvas,
    top: Int,
    bottom: Int,
    width: Float,
    color: Int
  ) {
    backgroundPaint.color = color
    var y = top.toFloat()
    while (y < bottom) {
      canvas.drawRect(0f, y, width, min(bottom.toFloat(), y + density), backgroundPaint)
      y += 2f * density
    }
  }

  /** Highlights word diffs; [top]..[bottom] is the row's first visual line. */
  @Suppress("LongParameterList")
  fun drawWordDiffRanges(
    canvas: Canvas,
    row: DiffRow,
    codeX: Float,
    top: Int,
    bottom: Int,
    lines: CodeLines
  ) {
    if (lines.nativeLayout != null) return
    if (row.wordDiffRanges.isEmpty() || (row.change != "add" && row.change != "delete")) return
    val color = if (row.change == "add") theme.addBar else theme.deleteBar
    backgroundPaint.color = withAlpha(color, 71)
    val characterWidth = textPaint.measureText("M")
    val fontHeight = textPaint.fontMetrics.run { descent - ascent }
    val highlightHeight = max(4f * density, min(bottom - top - 4f * density, fontHeight))
    val highlightTop = (top + bottom - highlightHeight) / 2f
    row.wordDiffRanges.forEach { range ->
      // A wrapped row splits the highlight at each visual line boundary.
      lines.starts.forEachIndexed { line, lineStart ->
        val start = max(range.start, lineStart)
        val end = min(range.end, lines.end(line, Int.MAX_VALUE))
        if (end <= start) return@forEachIndexed
        val left = codeX + (start - lineStart) * characterWidth
        val right = max(left + 2f * density, left + (end - start) * characterWidth)
        val lineTop = highlightTop + line * lines.height
        canvas.drawRoundRect(
          RectF(left, lineTop, right, lineTop + highlightHeight),
          3f * density,
          3f * density,
          backgroundPaint,
        )
      }
    }
  }

  /** Draws a code row's text, or its syntax [tokens] when present, one visual line per start. */
  @Suppress("LongParameterList")
  fun drawCode(
    canvas: Canvas,
    content: String,
    tokens: List<DiffToken>?,
    codeX: Float,
    baseline: Float,
    style: DiffStyle,
    lines: CodeLines
  ) {
    val nativeLayout = lines.nativeLayout
    if (nativeLayout != null) {
      canvas.save()
      canvas.translate(codeX, baseline - nativeLayout.getLineBaseline(0))
      nativeLayout.draw(canvas)
      canvas.restore()
      return
    }
    val runs = if (tokens.isNullOrEmpty()) listOf(DiffToken(content, null, 0)) else tokens
    var line = 0
    var x = codeX
    var column = 0
    runs.forEach { run ->
      configureCodePaint(run.color ?: theme.text, run.fontStyle, style)
      var start = 0
      while (start < run.content.length) {
        while (line + 1 < lines.starts.size && lines.starts[line + 1] <= column + start) {
          line += 1
          x = codeX
        }
        val end = min(run.content.length, lines.end(line, Int.MAX_VALUE) - column)
        val lineBaseline = baseline + line * lines.height
        if (lineBaseline + textPaint.fontMetrics.descent >= canvas.clipBounds.top &&
          lineBaseline + textPaint.fontMetrics.ascent <= canvas.clipBounds.bottom
        ) {
          canvas.drawText(run.content, start, end, x, lineBaseline, textPaint)
          x += textPaint.measureText(run.content, start, end)
        }
        start = end
      }
      column += run.content.length
    }
  }

  fun drawFileHeaderPathScrollFades(
    canvas: Canvas,
    pathRect: RectF,
    horizontalOffset: Int,
    maxOffset: Int
  ) {
    if (maxOffset <= 0 || pathRect.width() <= 0f) return
    val fadeWidth = min(28f * density, pathRect.width() / 3f)
    if (horizontalOffset > 0) {
      drawHorizontalFade(
        canvas,
        RectF(pathRect.left, pathRect.top, pathRect.left + fadeWidth, pathRect.bottom),
        fadesToRight = false,
      )
    }
    if (horizontalOffset < maxOffset) {
      drawHorizontalFade(
        canvas,
        RectF(pathRect.right - fadeWidth, pathRect.top, pathRect.right, pathRect.bottom),
        fadesToRight = true,
      )
    }
  }

  private fun drawRenameChevronIcon(canvas: Canvas, rect: RectF, color: Int) {
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = color
    borderPaint.strokeWidth = 1.8f * density
    borderPaint.strokeCap = Paint.Cap.ROUND
    borderPaint.strokeJoin = Paint.Join.ROUND
    val chevronWidth = 3.6f * density
    val chevronHeight = 8f * density
    val gap = 2.4f * density
    val startX = rect.centerX() - (chevronWidth * 2f + gap) / 2f
    val path = Path()
    for (x in listOf(startX, startX + chevronWidth + gap)) {
      path.moveTo(x, rect.centerY() - chevronHeight / 2f)
      path.lineTo(x + chevronWidth, rect.centerY())
      path.lineTo(x, rect.centerY() + chevronHeight / 2f)
    }
    canvas.drawPath(path, borderPaint)
  }

  private fun configureTextPaint(paint: Paint, color: Int, size: Float) {
    paint.textSize = size
    paint.color = color
    paint.style = Paint.Style.FILL
    paint.textAlign = Paint.Align.LEFT
    paint.isUnderlineText = false
    paint.isFakeBoldText = false
    paint.clearShadowLayer()
  }

  private fun drawHorizontalFade(canvas: Canvas, rect: RectF, fadesToRight: Boolean) {
    val opaque = theme.headerBackground
    val transparent = Color.argb(0, Color.red(opaque), Color.green(opaque), Color.blue(opaque))
    backgroundPaint.shader = LinearGradient(
      rect.left,
      rect.centerY(),
      rect.right,
      rect.centerY(),
      if (fadesToRight) transparent else opaque,
      if (fadesToRight) opaque else transparent,
      Shader.TileMode.CLAMP,
    )
    canvas.drawRect(rect, backgroundPaint)
    backgroundPaint.shader = null
  }

  private fun isBoldFontWeight(weight: String): Boolean = when (weight.lowercase()) {
    "medium", "semibold", "semi-bold", "bold", "heavy", "black" -> true
    else -> false
  }

  private fun withAlpha(color: Int, alpha: Int): Int =
    Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}

private object ReviewDiffTypefaces {
  val regular: Typeface = Typeface.create("monospace", Typeface.NORMAL)
  private val medium: Typeface = Typeface.create("monospace-medium", Typeface.NORMAL)
  val bold: Typeface = Typeface.create("monospace", Typeface.BOLD)

  fun forWeight(weight: String): Typeface = when (weight.lowercase()) {
    "medium", "semibold", "semi-bold" -> medium
    "bold", "heavy", "black" -> bold
    else -> regular
  }
}
