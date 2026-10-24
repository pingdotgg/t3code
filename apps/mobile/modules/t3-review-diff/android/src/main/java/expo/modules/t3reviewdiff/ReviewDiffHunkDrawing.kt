package expo.modules.t3reviewdiff

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import kotlin.math.max

internal fun ReviewDiffCanvasDrawing.drawHunkRow(
  canvas: Canvas,
  row: DiffRow,
  rect: RectF,
  style: DiffStyle,
  horizontalOffset: Int
) {
  val top = rect.top.toInt()
  val bottom = rect.bottom.toInt()
  val width = rect.width().toInt()
  backgroundPaint.color = theme.hunkBackground
  canvas.drawRect(rect, backgroundPaint)
  configureMonospacePaint(
    color = theme.hunkText,
    size = style.hunkFontSizePx,
    weight = style.hunkFontWeight,
  )
  canvas.save()
  if (row.hunkAction != null) {
    canvas.clipRect(
      0f,
      top.toFloat(),
      width - (if (row.hunkRevertAction) 224 else 112) * density,
      bottom.toFloat()
    )
  }
  val gutterEnd = style.changeBarWidthPx + style.gutterWidthPx
  val codeX = gutterEnd + style.codePaddingPx - horizontalOffset
  canvas.save()
  canvas.clipRect(gutterEnd, top.toFloat(), width.toFloat(), bottom.toFloat())
  canvas.drawText(
    row.text.ifEmpty { row.content },
    codeX,
    centeredBaseline(top, bottom, textPaint),
    textPaint,
  )
  canvas.restore()
  canvas.restore()
  row.hunkAction?.let { label ->
    drawHunkActionButton(
      canvas,
      label,
      RectF(width - 106 * density, top + 6 * density, width - 6 * density, bottom - 6 * density),
      if (row.hunkActionDisabled) theme.mutedText else theme.hunkText,
    )
  }
  if (row.hunkRevertAction) {
    drawHunkActionButton(
      canvas,
      "Revert hunk",
      RectF(
        width - 218 * density,
        top + 6 * density,
        width - 118 * density,
        bottom - 6 * density
      ),
      if (row.hunkRevertActionDisabled) theme.mutedText else theme.deleteText,
    )
  }
}

internal fun ReviewDiffCanvasDrawing.drawNoticeRow(
  canvas: Canvas,
  row: DiffRow,
  rect: RectF,
  style: DiffStyle
) {
  val top = rect.top.toInt()
  val bottom = rect.bottom.toInt()
  val width = rect.width().toInt()
  backgroundPaint.color = theme.background
  canvas.drawRect(rect, backgroundPaint)
  val iconSize = 16f * density
  val iconRect = RectF(
    style.fileHeaderHorizontalPaddingPx + 2f * density,
    (top + bottom - iconSize) / 2f,
    style.fileHeaderHorizontalPaddingPx + 2f * density + iconSize,
    (top + bottom + iconSize) / 2f,
  )
  drawNoticeIcon(canvas, iconRect, theme.mutedText)
  configureUiPaint(
    paint = textPaint,
    color = theme.mutedText,
    size = style.fileHeaderSubtextFontSizePx,
    weight = style.fileHeaderSubtextFontWeight,
  )
  val textX = iconRect.right + 10f * density
  canvas.drawText(
    ellipsizeDiffText(row.text, textPaint, width - textX - style.fileHeaderHorizontalPaddingPx),
    textX,
    centeredBaseline(top, bottom, textPaint),
    textPaint,
  )
  borderPaint.color = theme.border
  borderPaint.strokeWidth = density
  canvas.drawLine(0f, bottom - density / 2f, width.toFloat(), bottom - density / 2f, borderPaint)
}

private fun ReviewDiffCanvasDrawing.drawHunkActionButton(
  canvas: Canvas,
  label: String,
  rect: RectF,
  color: Int
) {
  backgroundPaint.color = theme.headerBackground
  canvas.drawRoundRect(rect, 6 * density, 6 * density, backgroundPaint)
  configureUiPaint(uiPaint, color, 13 * density, "semibold")
  val metrics = uiPaint.fontMetrics
  canvas.drawText(
    label,
    rect.centerX() - uiPaint.measureText(label) / 2,
    rect.centerY() - (metrics.ascent + metrics.descent) / 2f,
    uiPaint
  )
}

private fun centeredBaseline(top: Int, bottom: Int, paint: Paint): Float {
  val metrics = paint.fontMetrics
  return (top + bottom) / 2f - (metrics.ascent + metrics.descent) / 2f
}

internal fun ellipsizeDiffText(value: String, paint: Paint, width: Float): String {
  if (paint.measureText(value) <= width) return value
  val suffix = "..."
  val available = max(0f, width - paint.measureText(suffix))
  var end = value.length
  while (end > 0 && paint.measureText(value, 0, end) > available) end -= 1
  return value.substring(0, end) + suffix
}
