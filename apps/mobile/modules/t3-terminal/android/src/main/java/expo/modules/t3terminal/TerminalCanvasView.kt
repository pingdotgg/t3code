package expo.modules.t3terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import kotlin.math.ceil
import kotlin.math.max

internal class TerminalCanvasView(context: Context) : View(context) {
  companion object {
    const val FLAG_BOLD = 1 shl 0
    const val FLAG_ITALIC = 1 shl 1
    const val FLAG_INVISIBLE = 1 shl 4
    const val FLAG_STRIKETHROUGH = 1 shl 5
    const val FLAG_OVERLINE = 1 shl 6
    const val FLAG_UNDERLINE = 1 shl 7
    const val FLAG_SELECTED = 1 shl 8
  }

  private val density = resources.displayMetrics.density
  private val scaledDensity = density * resources.configuration.fontScale
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
  private val regularTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
  private val boldTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
  private val italicTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.ITALIC)
  private val boldItalicTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD_ITALIC)
  private val gestureDetector = GestureDetector(context, TerminalGestureListener())
  private val contentPadding = 8f * density
  private var frame: TerminalFrame? = null
  private var scrollRemainder = 0f
  private var cursorOn = true
  private val cursorBlink = object : Runnable {
    override fun run() {
      val currentFrame = frame ?: return
      if (!currentFrame.cursorBlinking || !currentFrame.cursorVisible) return
      cursorOn = !cursorOn
      invalidate()
      postDelayed(this, 500)
    }
  }

  var onScrollRows: ((Int) -> Unit)? = null
  var onRequestKeyboard: (() -> Unit)? = null
  var onCellMetricsChanged: (() -> Unit)? = null

  var fontSizeSp: Float = 10f
    set(value) {
      if (field == value) return
      field = value
      updateCellMetrics()
    }

  var cellWidthPx: Float = 1f
    private set
  var cellHeightPx: Float = 1f
    private set
  private var baselineOffsetPx: Float = 1f

  init {
    isClickable = true
    isFocusable = true
    isFocusableInTouchMode = true
    paint.typeface = regularTypeface
    updateCellMetrics()
  }

  fun setFrame(value: TerminalFrame) {
    frame = value
    cursorOn = true
    removeCallbacks(cursorBlink)
    if (value.cursorBlinking && value.cursorVisible) postDelayed(cursorBlink, 500)
    invalidate()
  }

  fun usableWidth(): Float = max(width - contentPadding * 2f, 1f)
  fun usableHeight(): Float = max(height - contentPadding * 2f, 1f)

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val currentFrame = frame
    if (currentFrame == null) {
      canvas.drawColor(Color.TRANSPARENT)
      return
    }
    canvas.drawColor(currentFrame.background)
    canvas.save()
    canvas.clipRect(
      contentPadding,
      contentPadding,
      width - contentPadding,
      height - contentPadding,
    )

    for (row in 0 until currentFrame.rows) {
      val top = contentPadding + row * cellHeightPx
      val bottom = top + cellHeightPx
      for (column in 0 until currentFrame.cols) {
        val index = row * currentFrame.cols + column
        val left = contentPadding + column * cellWidthPx
        val right = left + cellWidthPx
        val background = currentFrame.cellBackgrounds[index]
        val flags = currentFrame.cellFlags[index]
        paint.style = Paint.Style.FILL
        paint.color = if (flags and FLAG_SELECTED != 0) {
          blend(currentFrame.cursorColor, background, 0.32f)
        } else {
          background
        }
        if (paint.color != currentFrame.background || flags and FLAG_SELECTED != 0) {
          canvas.drawRect(left, top, right + 0.5f, bottom + 0.5f, paint)
        }

        val text = currentFrame.cellText[index]
        if (text.isNotEmpty() && flags and FLAG_INVISIBLE == 0) {
          configureTextPaint(flags, currentFrame.cellForegrounds[index])
          canvas.drawText(text, left, top + baselineOffsetPx, paint)
          if (flags and FLAG_OVERLINE != 0) {
            canvas.drawRect(left, top + 1f, right, top + max(2f, density), paint)
          }
        }
      }
    }

    if (currentFrame.cursorVisible && cursorOn &&
      currentFrame.cursorX in 0 until currentFrame.cols &&
      currentFrame.cursorY in 0 until currentFrame.rows
    ) {
      drawCursor(canvas, currentFrame)
    }
    canvas.restore()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      parent?.requestDisallowInterceptTouchEvent(true)
    } else if (event.actionMasked == MotionEvent.ACTION_UP ||
      event.actionMasked == MotionEvent.ACTION_CANCEL
    ) {
      parent?.requestDisallowInterceptTouchEvent(false)
    }
    return gestureDetector.onTouchEvent(event) || super.onTouchEvent(event)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(cursorBlink)
    super.onDetachedFromWindow()
  }

  private fun updateCellMetrics() {
    paint.textSize = fontSizeSp * scaledDensity
    paint.typeface = regularTypeface
    cellWidthPx = ceil(paint.measureText("M").toDouble()).toFloat().coerceAtLeast(1f)
    val metrics = paint.fontMetrics
    val glyphHeight = metrics.descent - metrics.ascent
    cellHeightPx = ceil((glyphHeight * 1.12f).toDouble()).toFloat().coerceAtLeast(1f)
    baselineOffsetPx = (cellHeightPx - glyphHeight) / 2f - metrics.ascent
    onCellMetricsChanged?.invoke()
    invalidate()
  }

  private fun configureTextPaint(flags: Int, color: Int) {
    val bold = flags and FLAG_BOLD != 0
    val italic = flags and FLAG_ITALIC != 0
    paint.typeface = when {
      bold && italic -> boldItalicTypeface
      bold -> boldTypeface
      italic -> italicTypeface
      else -> regularTypeface
    }
    paint.textSize = fontSizeSp * scaledDensity
    paint.color = color
    paint.style = Paint.Style.FILL
    paint.isUnderlineText = flags and FLAG_UNDERLINE != 0
    paint.isStrikeThruText = flags and FLAG_STRIKETHROUGH != 0
  }

  private fun drawCursor(canvas: Canvas, currentFrame: TerminalFrame) {
    val left = contentPadding + currentFrame.cursorX * cellWidthPx
    val top = contentPadding + currentFrame.cursorY * cellHeightPx
    val right = left + cellWidthPx
    val bottom = top + cellHeightPx
    paint.color = currentFrame.cursorColor
    paint.isUnderlineText = false
    paint.isStrikeThruText = false
    when (currentFrame.cursorStyle) {
      0 -> canvas.drawRect(left, top, left + max(2f * density, 2f), bottom, paint)
      2 -> canvas.drawRect(left, bottom - max(2f * density, 2f), right, bottom, paint)
      3 -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(density, 1f)
        canvas.drawRect(left, top, right, bottom, paint)
      }
      else -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top, right, bottom, paint)
        val index = currentFrame.cursorY * currentFrame.cols + currentFrame.cursorX
        val text = currentFrame.cellText[index]
        if (text.isNotEmpty()) {
          configureTextPaint(currentFrame.cellFlags[index], currentFrame.background)
          canvas.drawText(text, left, top + baselineOffsetPx, paint)
        }
      }
    }
  }

  private fun blend(foreground: Int, background: Int, amount: Float): Int {
    val inverseAmount = 1f - amount
    return Color.rgb(
      (Color.red(foreground) * amount + Color.red(background) * inverseAmount).toInt(),
      (Color.green(foreground) * amount + Color.green(background) * inverseAmount).toInt(),
      (Color.blue(foreground) * amount + Color.blue(background) * inverseAmount).toInt(),
    )
  }

  private inner class TerminalGestureListener : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(event: MotionEvent): Boolean {
      onRequestKeyboard?.invoke()
      return true
    }

    override fun onSingleTapUp(event: MotionEvent): Boolean {
      performClick()
      return true
    }

    override fun onScroll(
      first: MotionEvent?,
      current: MotionEvent,
      distanceX: Float,
      distanceY: Float,
    ): Boolean {
      scrollRemainder += distanceY / cellHeightPx
      val rows = scrollRemainder.toInt()
      if (rows != 0) {
        scrollRemainder -= rows
        onScrollRows?.invoke(rows)
      }
      return true
    }
  }
}
