package expo.modules.t3terminal

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3TerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val surface = TerminalSurfaceView(context)
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()

  var terminalKey: String
    get() = surface.terminalKey
    set(value) { surface.terminalKey = value }

  var initialBuffer: String
    get() = surface.initialBuffer
    set(value) { surface.initialBuffer = value }

  var fontSize: Float
    get() = surface.fontSize
    set(value) { surface.fontSize = value }

  var appearanceScheme: String = "dark"

  var themeConfig: String
    get() = surface.themeConfig
    set(value) { surface.themeConfig = value }

  var focusRequest: Double = 0.0
    set(value) {
      val previous = field
      field = value
      if (value != previous && value > 0) surface.requestKeyboardFocus()
    }

  var autoFocus: Boolean
    get() = surface.autoFocus
    set(value) { surface.autoFocus = value }

  var backgroundColorHex: String
    get() = surface.backgroundColorHex
    set(value) { surface.backgroundColorHex = value }

  var foregroundColorHex: String
    get() = surface.foregroundColorHex
    set(value) { surface.foregroundColorHex = value }

  var mutedForegroundColorHex: String = "#959DA5"

  init {
    surface.onInput = { onInput(mapOf("data" to it)) }
    surface.onResize = { cols, rows -> onResize(mapOf("cols" to cols, "rows" to rows)) }
    addView(
      surface,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    surface.measure(
      MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    surface.layout(0, 0, right - left, bottom - top)
  }

  fun cleanup() = surface.cleanup()
}
