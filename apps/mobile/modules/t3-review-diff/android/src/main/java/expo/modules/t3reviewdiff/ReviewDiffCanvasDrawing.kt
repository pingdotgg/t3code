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

  fun drawWordDiffRanges(
    canvas: Canvas,
    row: DiffRow,
    codeX: Float,
    top: Int,
    bottom: Int
  ) {
    if (row.wordDiffRanges.isEmpty() || (row.change != "add" && row.change != "delete")) return
    val color = if (row.change == "add") theme.addBar else theme.deleteBar
    backgroundPaint.color = withAlpha(color, 71)
    val characterWidth = textPaint.measureText("M")
    val fontHeight = textPaint.fontMetrics.run { descent - ascent }
    val highlightHeight = max(4f * density, min(bottom - top - 4f * density, fontHeight))
    val highlightTop = (top + bottom - highlightHeight) / 2f
    row.wordDiffRanges.forEach { range ->
      val left = codeX + range.start * characterWidth
      val right = max(left + 2f * density, codeX + range.end * characterWidth)
      canvas.drawRoundRect(
        RectF(left, highlightTop, right, highlightTop + highlightHeight),
        3f * density,
        3f * density,
        backgroundPaint,
      )
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
