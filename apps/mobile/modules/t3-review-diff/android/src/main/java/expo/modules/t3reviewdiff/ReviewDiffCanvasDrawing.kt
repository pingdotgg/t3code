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
  val density = context.resources.displayMetrics.density
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

  fun drawFileHeader(
    canvas: Canvas,
    row: DiffRow,
    rect: RectF,
    style: DiffStyle,
    state: FileHeaderDrawingState
  ) {
    val top = rect.top.toInt()
    val bottom = rect.bottom.toInt()
    val width = rect.width().toInt()
    backgroundPaint.color = theme.headerBackground
    canvas.drawRect(rect, backgroundPaint)

    val chevronRect = fileHeaderChevronRect(top, bottom, style)
    val iconRect = fileHeaderIconRect(top, bottom, style)
    val checkboxRect = fileHeaderCheckboxRect(top, bottom, width, style)
    drawDisclosureChevron(
      canvas,
      chevronRect,
      theme.mutedText,
      collapsed = state.collapsed,
    )
    drawFileIcon(canvas, iconRect, row.changeType)
    if (state.showViewedCheckbox) {
      val saved = canvas.saveLayerAlpha(checkboxRect, if (state.viewedCheckboxEnabled) 255 else 102)
      drawViewedCheckbox(
        canvas,
        checkboxRect,
        state.viewed,
      )
      canvas.restoreToCount(saved)
    }

    configureUiPaint(
      paint = uiPaint,
      color = theme.deleteText,
      size = style.fileHeaderMetaFontSizePx,
      weight = style.fileHeaderMetaFontWeight,
    )
    val deleteText = "-${row.deletions}"
    val deleteWidth = uiPaint.measureText(deleteText)
    val addText = "+${row.additions}"
    val addWidth = uiPaint.measureText(addText)
    val countGap = 4f * density
    val countsRight = if (row.fileAction != null) {
      width - 110f * density
    } else if (state.showViewedCheckbox) {
      checkboxRect.left - 10f * density
    } else {
      width - 16f * density
    }
    val countsX = countsRight - deleteWidth - countGap - addWidth
    val baseline = centeredBaseline(top, bottom, uiPaint)
    canvas.drawText(deleteText, countsX, baseline, uiPaint)
    uiPaint.color = theme.addText
    canvas.drawText(addText, countsX + deleteWidth + countGap, baseline, uiPaint)

    val pathLayout = fileHeaderPathLayout(row, iconRect, countsX, style)
    val maxPathOffset = maxHeaderPathOffset(pathLayout)
    val pathOffset = state.pathOffset
      .coerceIn(0, maxPathOffset)
    drawFileHeaderPath(canvas, row, pathLayout, pathOffset, maxPathOffset)
    drawFileHeaderAction(canvas, row, rect)
    borderPaint.color = theme.border
    borderPaint.strokeWidth = density
    canvas.drawLine(0f, bottom - density / 2f, width.toFloat(), bottom - density / 2f, borderPaint)
  }

  private fun drawFileHeaderPath(
    canvas: Canvas,
    row: DiffRow,
    pathLayout: FileHeaderPathLayout,
    pathOffset: Int,
    maxPathOffset: Int
  ) {
    canvas.save()
    canvas.clipRect(pathLayout.rect)
    val metrics = uiPaint.fontMetrics
    val baseline = pathLayout.rect.centerY() - (metrics.ascent + metrics.descent) / 2f
    if (row.renameSegments.isNotEmpty()) {
      drawRenamePath(canvas, row, pathLayout, pathOffset, baseline)
    } else {
      canvas.drawText(pathLayout.displayPath, pathLayout.rect.left - pathOffset, baseline, uiPaint)
    }
    canvas.restore()
    drawFileHeaderPathScrollFades(canvas, pathLayout.rect, pathOffset, maxPathOffset)
  }

  private fun drawRenamePath(
    canvas: Canvas,
    row: DiffRow,
    pathLayout: FileHeaderPathLayout,
    pathOffset: Int,
    baseline: Float
  ) {
    var x = pathLayout.rect.left - pathOffset
    for (segment in row.renameSegments) {
      val segmentWidth = uiPaint.measureText(segment.text)
      if (segment.kind == "removed" || segment.kind == "added") {
        backgroundPaint.color =
          if (segment.kind == "removed") theme.deleteBackground else theme.addBackground
        canvas.drawRect(
          x,
          pathLayout.rect.top,
          x + segmentWidth,
          pathLayout.rect.bottom,
          backgroundPaint
        )
      }
      uiPaint.color = if (segment.kind == "context") theme.mutedText else theme.text
      canvas.drawText(segment.text, x, baseline, uiPaint)
      x += segmentWidth
    }
  }

  private fun drawFileHeaderAction(canvas: Canvas, row: DiffRow, rect: RectF) {
    val top = rect.top.toInt()
    val bottom = rect.bottom.toInt()
    val width = rect.width().toInt()
    row.fileAction?.let { label ->
      val rect = RectF(
        width - 96 * density,
        top + 7 * density,
        width - 10 * density,
        bottom - 7 * density
      )
      backgroundPaint.color = theme.border
      backgroundPaint.style = Paint.Style.STROKE
      backgroundPaint.strokeWidth = density
      canvas.drawRoundRect(rect, 6 * density, 6 * density, backgroundPaint)
      backgroundPaint.style = Paint.Style.FILL
      configureUiPaint(
        uiPaint,
        if (row.fileActionDisabled) theme.mutedText else theme.hunkText,
        12 * density,
        "semibold"
      )
      canvas.drawText(
        label,
        rect.centerX() - uiPaint.measureText(label) / 2,
        centeredBaseline(top, bottom, uiPaint),
        uiPaint
      )
    }
  }

  fun fileHeaderPathLayout(
    row: DiffRow,
    iconRect: RectF,
    countsX: Float,
    style: DiffStyle
  ): FileHeaderPathLayout {
    configureUiPaint(
      paint = uiPaint,
      color = theme.text,
      size = style.fileHeaderFontSizePx,
      weight = style.fileHeaderFontWeight,
    )
    val pathX = iconRect.right + 10f * density
    val pathWidth = max(24f * density, countsX - pathX - 12f * density)
    val centerY = iconRect.centerY()
    val displayPath = if (row.renameSegments.isNotEmpty()) {
      row.renameSegments.joinToString("") { it.text }
    } else {
      row.filePath
    }
    return FileHeaderPathLayout(
      displayPath = displayPath,
      rect = RectF(pathX, centerY - 10f * density, pathX + pathWidth, centerY + 10f * density),
    )
  }

  private fun maxHeaderPathOffset(layout: FileHeaderPathLayout): Int = max(
    0,
    ceil(uiPaint.measureText(layout.displayPath) - layout.rect.width()).toInt(),
  )

  private fun centeredBaseline(top: Int, bottom: Int, paint: Paint): Float {
    val metrics = paint.fontMetrics
    return (top + bottom) / 2f - (metrics.ascent + metrics.descent) / 2f
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
    width: Int
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
      cache.apply { layout(rows, tokens, paint, style, colors, availableWidth) }
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
      if (widthStyle != style) widthEntries = emptyMap()
      val next = HashMap<String, WidthEntry>()
      var widest = 0f
      for (row in rows) {
        if (row.kind != "line" && row.kind != "hunk") continue
        val rowTokens = if (row.kind == "line") tokens[row.id] else null
        val cached = widthEntries[row.id]
        val entry = if (cached?.row == row && cached.tokens == rowTokens) {
          cached
        } else {
          WidthEntry(row, rowTokens, measureRowWidth(row, rowTokens, style))
        }
        next[row.id] = entry
        widest = max(widest, entry.width)
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

internal data class FileHeaderDrawingState(
  val collapsed: Boolean,
  val viewed: Boolean,
  val showViewedCheckbox: Boolean,
  val viewedCheckboxEnabled: Boolean,
  val pathOffset: Int
)

internal data class FileHeaderPathLayout(
  val displayPath: String,
  val rect: RectF
)
