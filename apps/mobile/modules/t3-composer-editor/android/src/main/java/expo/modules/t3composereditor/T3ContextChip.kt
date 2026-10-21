package expo.modules.t3composereditor

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import kotlin.math.ceil
import kotlin.math.min

class T3ContextChip(
  content: Content,
  fontSize: Float,
  private val color: Int,
  maximumWidth: Float,
  density: Float
) {
  /** What the chip says: its name, the size beside it, and the glyph that leads it. */
  data class Content(
    val label: String,
    val detail: String = "",
    val iconUri: String = "",
    val tintsIcon: Boolean = false
  )

  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = fontSize
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    color = this@T3ContextChip.color
  }
  private val em = fontSize

  // The size reads as metadata beside the name, so it draws a step down from the label the
  // way the web chip does.
  private val detailPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = fontSize * 0.84f
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    color = this@T3ContextChip.color
  }
  private val detailText = if (content.detail.isEmpty()) "" else " ${content.detail}"
  private val detailWidth = if (detailText.isEmpty()) 0f else detailPaint.measureText(detailText)

  val iconUri = content.iconUri
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
    if (content.tintsIcon) {
      colorFilter =
        PorterDuffColorFilter(this@T3ContextChip.color, PorterDuff.Mode.SRC_IN)
    }
  }
  private val padding = density * 5
  private val iconSlot = if (iconUri.isEmpty()) 0f else em * 1.25f
  val width = ceil(
    min(
      maximumWidth.coerceAtLeast(em * 3),
      paint.measureText(content.label) + detailWidth + iconSlot + padding * 2
    )
  )
  val height = ceil(paint.fontMetrics.descent - paint.fontMetrics.ascent)
  private val text = TextUtils.ellipsize(
    content.label,
    paint,
    (width - iconSlot - padding * 2 - detailWidth).coerceAtLeast(0f),
    TextUtils.TruncateAt.MIDDLE
  ).toString()

  fun draw(canvas: Canvas, x: Float, y: Float) {
    canvas.save()
    canvas.translate(x, y)
    T3ChipIcons.cached(iconUri)?.let {
      val top = (height - em) / 2
      canvas.drawBitmap(it, null, RectF(padding, top, padding + em, top + em), iconPaint)
    }
    val baseline = -paint.fontMetrics.ascent
    canvas.drawText(text, padding + iconSlot, baseline, paint)
    if (detailText.isNotEmpty()) {
      canvas.drawText(
        detailText,
        padding + iconSlot + paint.measureText(text),
        baseline,
        detailPaint
      )
    }
    canvas.restore()
  }

  companion object {
    fun color(
      value: String,
      fallback: Int
    ): Int = runCatching {
      // React Native hex colors put alpha last; Android's parser puts it first.
      val androidColor = if (value.length == 9 && value.startsWith("#")) {
        "#${value.takeLast(2)}${value.substring(1, 7)}"
      } else {
        value
      }
      Color.parseColor(androidColor)
    }.getOrDefault(fallback)
  }
}
