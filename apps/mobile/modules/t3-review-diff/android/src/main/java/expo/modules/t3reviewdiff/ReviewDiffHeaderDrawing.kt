package expo.modules.t3reviewdiff

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

internal fun ReviewDiffCanvasDrawing.drawDisclosureChevron(
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

internal fun ReviewDiffCanvasDrawing.drawFileIcon(canvas: Canvas, rect: RectF, changeType: String) {
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

internal fun ReviewDiffCanvasDrawing.drawViewedCheckbox(
  canvas: Canvas,
  rect: RectF,
  checked: Boolean
) {
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

internal fun ReviewDiffCanvasDrawing.drawNoticeIcon(canvas: Canvas, rect: RectF, color: Int) {
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

private fun ReviewDiffCanvasDrawing.drawRenameChevronIcon(canvas: Canvas, rect: RectF, color: Int) {
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
