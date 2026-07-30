package expo.modules.t3terminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.widget.doAfterTextChanged
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import kotlin.math.max
import kotlin.math.min

class T3TerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val container = LinearLayout(context)
  private val scrollView = ScrollView(context)
  private val textView = TextView(context)
  private val inputView = EditText(context)
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()
  private var lastWidth = 0
  private var lastHeight = 0
  private var clearingInput = false
  private var backgroundColorValue = Color.parseColor("#24292E")
  private var foregroundColorValue = Color.parseColor("#D1D5DA")
  private var mutedForegroundColorValue = Color.parseColor("#959DA5")

  var terminalKey: String = ""
    set(value) {
      field = value
      contentDescription = "t3-terminal-$value"
    }

  var initialBuffer: String = ""
    set(value) {
      field = value
      textView.text = value.ifEmpty { "$ " }
      scrollView.post {
        scrollView.fullScroll(View.FOCUS_DOWN)
      }
    }

  var fontSize: Float = 10f
    set(value) {
      field = value
      textView.textSize = value
      inputView.textSize = max(value, 13f)
      emitResize()
    }

  var appearanceScheme: String = "dark"
    set(value) {
      field = value
    }

  var themeConfig: String = ""

  var backgroundColorHex: String = "#24292E"
    set(value) {
      field = value
      backgroundColorValue = parseColor(value, backgroundColorValue)
      applyTheme()
    }

  var foregroundColorHex: String = "#D1D5DA"
    set(value) {
      field = value
      foregroundColorValue = parseColor(value, foregroundColorValue)
      applyTheme()
    }

  var mutedForegroundColorHex: String = "#959DA5"
    set(value) {
      field = value
      mutedForegroundColorValue = parseColor(value, mutedForegroundColorValue)
      applyTheme()
    }

  init {
    applyTheme()
    container.orientation = LinearLayout.VERTICAL
    textView.typeface = Typeface.MONOSPACE
    textView.textSize = fontSize
    textView.setPadding(8, 8, 8, 8)
    textView.text = "$ "

    inputView.setSingleLine(true)
    inputView.setTextColor(Color.TRANSPARENT)
    inputView.setHintTextColor(Color.TRANSPARENT)
    inputView.setBackgroundColor(Color.TRANSPARENT)
    inputView.typeface = Typeface.MONOSPACE
    inputView.textSize = max(fontSize, 13f)
    inputView.hint = ""
    inputView.alpha = 0.02f
    inputView.imeOptions = EditorInfo.IME_ACTION_SEND
    inputView.setPadding(0, 0, 0, 0)
    inputView.setOnFocusChangeListener { _, hasFocus ->
      if (hasFocus) {
        showKeyboard()
      }
    }
    inputView.setOnEditorActionListener { view, actionId, _ ->
      if (actionId != EditorInfo.IME_ACTION_SEND) return@setOnEditorActionListener false
      onInput(mapOf("data" to "\n"))
      true
    }
    inputView.setOnKeyListener { _, keyCode, event ->
      if (event.action != android.view.KeyEvent.ACTION_DOWN) return@setOnKeyListener false
      when (keyCode) {
        android.view.KeyEvent.KEYCODE_DEL -> {
          onInput(mapOf("data" to "\u007F"))
          true
        }
        else -> false
      }
    }
    inputView.doAfterTextChanged { editable ->
      if (clearingInput) return@doAfterTextChanged
      val text = editable?.toString().orEmpty()
      if (text.isEmpty()) return@doAfterTextChanged
      onInput(mapOf("data" to text))
      clearingInput = true
      inputView.text?.clear()
      clearingInput = false
    }

    textView.setOnClickListener { requestKeyboardFocus() }
    scrollView.setOnClickListener { requestKeyboardFocus() }
    container.setOnClickListener { requestKeyboardFocus() }
    isClickable = true
    setOnClickListener { requestKeyboardFocus() }

    scrollView.addView(
      textView,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    container.addView(
      scrollView,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1f,
      ),
    )
    container.addView(
      inputView,
      LinearLayout.LayoutParams(1, 1),
    )
    addView(
      container,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    post {
      requestKeyboardFocus()
    }
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width == lastWidth && height == lastHeight) return
    lastWidth = width
    lastHeight = height
    emitResize()
  }

  private fun emitResize() {
    if (width <= 0 || height <= 0) return
    val density = resources.displayMetrics.scaledDensity
    val fontPx = max(fontSize * density, 1f)
    val cols = max(20, min(400, (width / (fontPx * 0.62f)).toInt()))
    val terminalHeight = max(height - inputView.height, 0)
    val rows = max(5, min(200, (terminalHeight / (fontPx * 1.35f)).toInt()))
    onResize(mapOf("cols" to cols, "rows" to rows))
  }

  private fun requestKeyboardFocus() {
    inputView.requestFocus()
    showKeyboard()
  }

  private fun applyTheme() {
    setBackgroundColor(backgroundColorValue)
    container.setBackgroundColor(backgroundColorValue)
    scrollView.setBackgroundColor(backgroundColorValue)
    textView.setTextColor(foregroundColorValue)
    textView.setBackgroundColor(backgroundColorValue)
    inputView.setTextColor(Color.TRANSPARENT)
    inputView.setHintTextColor(mutedForegroundColorValue)
    inputView.setBackgroundColor(Color.TRANSPARENT)
  }

  private fun parseColor(value: String, fallback: Int): Int =
    try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      fallback
    }

  private fun showKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(inputView, InputMethodManager.SHOW_IMPLICIT)
  }
}
