package expo.modules.t3reviewdiff

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF

internal fun ReviewDiffCanvasDrawing.drawCommentRow(
  canvas: Canvas,
  row: DiffRow,
  rect: RectF,
  style: DiffStyle,
  collapsed: Boolean
) {
  val top = rect.top.toInt()
  val bottom = rect.bottom.toInt()
  val width = rect.width().toInt()
  backgroundPaint.color = theme.background
  canvas.drawRect(rect, backgroundPaint)
  val cardRect = RectF(
    8f * density,
    top + 5f * density,
    width - 8f * density,
    bottom - 5f * density,
  )
  backgroundPaint.color = theme.headerBackground
  canvas.drawRoundRect(cardRect, 10f * density, 10f * density, backgroundPaint)
  borderPaint.style = Paint.Style.STROKE
  borderPaint.color = commentColorAlpha(theme.border, 217)
  borderPaint.strokeWidth = density
  canvas.drawRoundRect(cardRect, 10f * density, 10f * density, borderPaint)
  borderPaint.style = Paint.Style.FILL

  val chevronRect = RectF(
    cardRect.left + 10f * density,
    cardRect.top + 11f * density,
    cardRect.left + 26f * density,
    cardRect.top + 27f * density,
  )
  drawDisclosureChevron(canvas, chevronRect, theme.mutedText, collapsed)
  configureUiPaint(
    paint = textPaint,
    color = theme.mutedText,
    size = style.fileHeaderSubtextFontSizePx,
    weight = style.fileHeaderSubtextFontWeight,
  )
  val title =
    row.commentResolvedSummary ?: "Comment on ${row.commentRangeLabel.ifEmpty { "line" }}"
  val titleRight = cardRect.right - (if (row.commentPending) 98f else 20f) * density
  canvas.drawText(
    ellipsizeDiffText(title, textPaint, titleRight - chevronRect.right),
    chevronRect.right + 10f * density,
    cardRect.top + 22f * density,
    textPaint,
  )
  if (row.commentPending) drawCommentPendingBadge(canvas, cardRect)
  if (!collapsed) {
    textPaint.color = theme.text
    val bodyX = cardRect.left + 18f * density
    canvas.drawText(
      ellipsizeDiffText(
        row.commentText.ifEmpty { "Comment" },
        textPaint,
        cardRect.right - bodyX - 18f * density
      ),
      bodyX,
      cardRect.top + 58f * density,
      textPaint,
    )
  }
}

private fun ReviewDiffCanvasDrawing.drawCommentPendingBadge(canvas: Canvas, cardRect: RectF) {
  val badge = RectF(
    cardRect.right - 88f * density,
    cardRect.top + 7f * density,
    cardRect.right - 10f * density,
    cardRect.top + 31f * density
  )
  val amber = Color.rgb(217, 119, 6)
  backgroundPaint.color = commentColorAlpha(amber, 35)
  canvas.drawRoundRect(badge, 5f * density, 5f * density, backgroundPaint)
  borderPaint.color = amber
  borderPaint.style = Paint.Style.STROKE
  borderPaint.strokeWidth = density
  val cx = badge.left + 12f * density
  val cy = badge.top + 12f * density
  canvas.drawCircle(cx, cy, 6f * density, borderPaint)
  canvas.drawLine(cx, cy - 3f * density, cx, cy, borderPaint)
  canvas.drawLine(cx, cy, cx + 3f * density, cy + density, borderPaint)
  borderPaint.style = Paint.Style.FILL
  textPaint.color = amber
  canvas.drawText("Pending", badge.left + 23f * density, badge.top + 17f * density, textPaint)
}

private fun commentColorAlpha(color: Int, alpha: Int): Int =
  Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
