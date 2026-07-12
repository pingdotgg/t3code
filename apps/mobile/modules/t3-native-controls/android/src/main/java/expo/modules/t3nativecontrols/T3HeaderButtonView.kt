package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3HeaderButtonView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val iconView = HeaderIconView(context)
  private val onTriggered by EventDispatcher()

  init {
    isClickable = true
    isFocusable = true
    setOnClickListener {
      onTriggered(emptyMap<String, Any>())
    }
    addView(iconView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setLabel(label: String) {
    contentDescription = label
  }

  fun setSystemImage(systemImage: String) {
    iconView.systemImage = systemImage
  }
}

private class HeaderIconView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.parseColor("#6B7280")
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    strokeWidth = 3f * resources.displayMetrics.density
    style = Paint.Style.STROKE
  }

  var systemImage: String = "gearshape"
    set(value) {
      field = value
      invalidate()
    }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val cx = width / 2f
    val cy = height / 2f
    val size = minOf(width, height).toFloat()
    if (systemImage == "square.and.pencil") {
      drawNewTask(canvas, cx, cy, size)
    } else {
      drawSettings(canvas, cx, cy, size)
    }
  }

  private fun drawSettings(canvas: Canvas, cx: Float, cy: Float, size: Float) {
    val radius = size * 0.12f
    canvas.drawCircle(cx, cy, radius, paint)
    for (index in 0 until 8) {
      val angle = Math.PI * index / 4.0
      val inner = size * 0.19f
      val outer = size * 0.27f
      val sx = cx + kotlin.math.cos(angle).toFloat() * inner
      val sy = cy + kotlin.math.sin(angle).toFloat() * inner
      val ex = cx + kotlin.math.cos(angle).toFloat() * outer
      val ey = cy + kotlin.math.sin(angle).toFloat() * outer
      canvas.drawLine(sx, sy, ex, ey, paint)
    }
  }

  private fun drawNewTask(canvas: Canvas, cx: Float, cy: Float, size: Float) {
    val left = cx - size * 0.2f
    val top = cy - size * 0.16f
    val right = cx + size * 0.14f
    val bottom = cy + size * 0.2f
    canvas.drawRoundRect(left, top, right, bottom, size * 0.04f, size * 0.04f, paint)
    canvas.drawLine(
      cx - size * 0.02f,
      cy + size * 0.13f,
      cx + size * 0.24f,
      cy - size * 0.13f,
      paint
    )
    canvas.drawLine(
      cx + size * 0.17f,
      cy - size * 0.2f,
      cx + size * 0.24f,
      cy - size * 0.13f,
      paint
    )
  }
}
