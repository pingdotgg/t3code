package expo.modules.t3terminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max

class T3TerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val container = FrameLayout(context)
  private val terminalCanvas = TerminalCanvasView(context)
  private val inputView = EditText(context)
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()
  private var terminalHandle = 0L
  private var fedBuffer = ""
  private var cols = 0
  private var rows = 0
  private var clearingInput = false
  private var isCleanedUp = false
  private var backgroundColorValue = Color.parseColor("#24292E")
  private var foregroundColorValue = Color.parseColor("#D1D5DA")
  private var mutedForegroundColorValue = Color.parseColor("#959DA5")
  private var cursorColorValue = Color.parseColor("#009FFF")
  private var paletteColors = IntArray(0)

  var terminalKey: String = ""
    set(value) {
      if (field == value) return
      field = value
      contentDescription = "t3-terminal-$value"
      recreateTerminal()
    }

  var initialBuffer: String = ""
    set(value) {
      if (field == value) return
      field = value
      feedPendingBuffer()
    }

  var fontSize: Float = 10f
    set(value) {
      field = value
      terminalCanvas.fontSizeSp = value
      inputView.textSize = max(value, 13f)
      emitResize()
    }

  var appearanceScheme: String = "dark"

  var themeConfig: String = ""
    set(value) {
      field = value
      parseThemeConfig(value)
      applyTheme()
    }

  var focusRequest: Double = 0.0
    set(value) {
      val previous = field
      field = value
      if (value != previous && value > 0) {
        requestKeyboardFocus()
      }
    }

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
    }

  init {
    terminalCanvas.fontSizeSp = fontSize
    terminalCanvas.onRequestKeyboard = { requestKeyboardFocus() }
    terminalCanvas.onScrollRows = { delta ->
      if (terminalHandle != 0L) {
        GhosttyBridge.nativeScroll(terminalHandle, delta)
        renderSnapshot()
      }
    }
    terminalCanvas.onCellMetricsChanged = { emitResize() }
    terminalCanvas.selectionDelegate = object : TerminalSelectionDelegate {
      override fun selectWordAt(col: Int, row: Int): Boolean {
        if (terminalHandle == 0L) return false
        val selected = GhosttyBridge.nativeSelectWordAt(terminalHandle, col, row)
        if (selected) renderSnapshot()
        return selected
      }

      override fun extendSelection(anchorCol: Int, anchorRow: Int, col: Int, row: Int) {
        if (terminalHandle == 0L) return
        GhosttyBridge.nativeExtendSelection(terminalHandle, anchorCol, anchorRow, col, row)
        renderSnapshot()
      }

      override fun selectAll(): Boolean {
        if (terminalHandle == 0L) return false
        val selected = GhosttyBridge.nativeSelectAll(terminalHandle)
        if (selected) renderSnapshot()
        return selected
      }

      override fun clearSelection() {
        if (terminalHandle == 0L) return
        GhosttyBridge.nativeClearSelection(terminalHandle)
        renderSnapshot()
      }

      override fun selectionText(): String? {
        if (terminalHandle == 0L) return null
        val bytes = GhosttyBridge.nativeGetSelectionText(terminalHandle) ?: return null
        return String(bytes, Charsets.UTF_8)
      }
    }

    configureInputView()
    container.addView(
      terminalCanvas,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    container.addView(inputView, FrameLayout.LayoutParams(1, 1))
    addView(
      container,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    applyTheme()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth || height != oldHeight) emitResize()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    val childWidthSpec = MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY)
    val childHeightSpec = MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY)
    container.measure(childWidthSpec, childHeightSpec)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    container.layout(0, 0, right - left, bottom - top)
    if (changed) emitResize()
  }

  fun cleanup() {
    if (isCleanedUp) return
    isCleanedUp = true
    inputView.setOnEditorActionListener(null)
    terminalCanvas.onScrollRows = null
    terminalCanvas.onRequestKeyboard = null
    terminalCanvas.onCellMetricsChanged = null
    terminalCanvas.selectionDelegate = null
    destroyTerminal()
  }

  private fun configureInputView() {
    inputView.setSingleLine(true)
    inputView.setTextColor(Color.TRANSPARENT)
    inputView.setHintTextColor(Color.TRANSPARENT)
    inputView.setBackgroundColor(Color.TRANSPARENT)
    inputView.typeface = Typeface.MONOSPACE
    inputView.textSize = max(fontSize, 13f)
    inputView.alpha = 0.01f
    inputView.isFocusableInTouchMode = true
    inputView.imeOptions = EditorInfo.IME_ACTION_SEND or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      EditorInfo.IME_FLAG_NO_FULLSCREEN or
      EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    inputView.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    inputView.setPadding(0, 0, 0, 0)
    inputView.setOnEditorActionListener { _, actionId, event ->
      val isKeyUp = event?.action == KeyEvent.ACTION_UP
      val isImeSend = actionId == EditorInfo.IME_ACTION_SEND && !isKeyUp
      val isHardwareEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER &&
        event.action == KeyEvent.ACTION_DOWN
      val isEnter = isImeSend || isHardwareEnter
      if (isEnter) {
        // Enter must send CR: raw-mode TUIs treat LF as Ctrl+J (insert newline).
        onInput(mapOf("data" to "\r"))
        true
      } else {
        false
      }
    }
    inputView.setOnKeyListener { _, keyCode, event ->
      if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
      when {
        keyCode == KeyEvent.KEYCODE_DEL -> {
          onInput(mapOf("data" to "\u007F"))
          true
        }
        // Hardware keyboard Ctrl+A..Z -> control bytes 0x01..0x1A (Ctrl+C, Ctrl+Z, ...).
        event.isCtrlPressed && keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> {
          onInput(
            mapOf("data" to (keyCode - KeyEvent.KEYCODE_A + 1).toChar().toString()),
          )
          true
        }
        else -> false
      }
    }
    inputView.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
          if (clearingInput || s == null || count <= 0) return
          val end = (start + count).coerceAtMost(s.length)
          if (start >= end) return
          val insertedText = s.subSequence(start, end).toString()
          if (insertedText.isNotEmpty()) {
            onInput(mapOf("data" to insertedText))
          }
        }

        override fun afterTextChanged(editable: Editable?) {
          if (clearingInput || editable.isNullOrEmpty()) return
          clearingInput = true
          editable.clear()
          clearingInput = false
        }
      },
    )
  }

  @Suppress("ComplexCondition")
  private fun emitResize() {
    if (
      width <= 0 ||
      height <= 0 ||
      terminalCanvas.width <= 0 ||
      terminalCanvas.height <= 0 ||
      isCleanedUp
    ) {
      return
    }
    val nextCols = (terminalCanvas.usableWidth() / terminalCanvas.cellWidthPx)
      .toInt()
      .coerceIn(2, 400)
    val nextRows = (terminalCanvas.usableHeight() / terminalCanvas.cellHeightPx)
      .toInt()
      .coerceIn(2, 200)
    if (nextCols == cols && nextRows == rows && terminalHandle != 0L) return
    cols = nextCols
    rows = nextRows
    val response = if (terminalHandle == 0L) {
      createTerminal()
      ByteArray(0)
    } else {
      GhosttyBridge.nativeResize(
        terminalHandle,
        cols,
        rows,
        terminalCanvas.cellWidthPx.toInt(),
        terminalCanvas.cellHeightPx.toInt(),
      )
    }
    emitResponse(response)
    onResize(mapOf("cols" to cols, "rows" to rows))
    feedPendingBuffer()
    renderSnapshot()
  }

  @Suppress("ComplexCondition")
  private fun createTerminal() {
    if (terminalHandle != 0L || cols <= 0 || rows <= 0 || isCleanedUp) return
    terminalHandle = GhosttyBridge.nativeCreate(
      cols,
      rows,
      terminalCanvas.cellWidthPx.toInt(),
      terminalCanvas.cellHeightPx.toInt(),
      foregroundColorValue,
      backgroundColorValue,
      cursorColorValue,
      paletteColors,
    )
    fedBuffer = ""
  }

  private fun recreateTerminal() {
    if (terminalHandle == 0L) return
    destroyTerminal()
    createTerminal()
    feedPendingBuffer()
    renderSnapshot()
  }

  private fun destroyTerminal() {
    if (terminalHandle == 0L) return
    GhosttyBridge.nativeDestroy(terminalHandle)
    terminalHandle = 0L
    fedBuffer = ""
    terminalCanvas.resetSelectionState()
  }

  private fun feedPendingBuffer() {
    if (terminalHandle == 0L || initialBuffer == fedBuffer) return
    if (!initialBuffer.startsWith(fedBuffer)) {
      recreateTerminal()
      if (terminalHandle == 0L) return
    }
    val suffix = initialBuffer.substring(fedBuffer.length)
    if (suffix.isNotEmpty()) {
      emitResponse(GhosttyBridge.nativeFeed(terminalHandle, suffix.toByteArray(Charsets.UTF_8)))
      // New output invalidates an active selection (matches the web drawer);
      // otherwise the copy toolbar drifts out of sync with the grid.
      if (terminalCanvas.hasActiveSelection()) {
        GhosttyBridge.nativeClearSelection(terminalHandle)
        terminalCanvas.resetSelectionState()
      }
    }
    fedBuffer = initialBuffer
    renderSnapshot()
  }

  private fun renderSnapshot() {
    if (terminalHandle == 0L) return
    TerminalFrame.decode(
      GhosttyBridge.nativeSnapshot(terminalHandle)
    )?.let(terminalCanvas::setFrame)
  }

  private fun emitResponse(response: ByteArray) {
    if (response.isNotEmpty()) {
      onInput(mapOf("data" to String(response, Charsets.UTF_8)))
    }
  }

  private fun requestKeyboardFocus() {
    inputView.requestFocus()
    val inputMethodManager = context.getSystemService(
      Context.INPUT_METHOD_SERVICE
    ) as? InputMethodManager
    inputMethodManager?.showSoftInput(inputView, InputMethodManager.SHOW_IMPLICIT)
  }

  private fun applyTheme() {
    setBackgroundColor(backgroundColorValue)
    container.setBackgroundColor(backgroundColorValue)
    terminalCanvas.setBackgroundColor(backgroundColorValue)
    if (terminalHandle != 0L) {
      GhosttyBridge.nativeSetTheme(
        terminalHandle,
        foregroundColorValue,
        backgroundColorValue,
        cursorColorValue,
        paletteColors,
      )
      renderSnapshot()
    }
  }

  @Suppress("LoopWithTooManyJumpStatements")
  private fun parseThemeConfig(config: String) {
    val palette = sortedMapOf<Int, Int>()
    for (line in config.lineSequence()) {
      val parts = line.split('=', limit = 2)
      if (parts.size != 2) continue
      val key = parts[0].trim()
      val value = parts[1].trim()
      when (key) {
        "cursor-color" -> cursorColorValue = parseColor(value, cursorColorValue)
        "palette" -> {
          val paletteParts = value.split('=', limit = 2)
          val index = paletteParts.firstOrNull()?.trim()?.toIntOrNull() ?: continue
          val color = paletteParts.getOrNull(1)?.trim() ?: continue
          if (index in 0..255) palette[index] = parseColor(color, foregroundColorValue)
        }
      }
    }
    if (palette.isNotEmpty()) {
      val lastIndex = palette.lastKey()
      paletteColors = IntArray(lastIndex + 1) { index ->
        palette[index] ?: foregroundColorValue
      }
    }
  }

  private fun parseColor(value: String, fallback: Int): Int =
    try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      fallback
    }
}
