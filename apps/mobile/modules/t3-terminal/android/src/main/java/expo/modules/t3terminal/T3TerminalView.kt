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

  /**
   * Everything fed to the current terminal, replayed whenever the terminal is
   * recreated (key change, resize-driven creation). Bounded to the same
   * retention window the JS side keeps.
   *
   * 当前终端已喂入的全部内容，终端重建时（key 变化、尺寸触发的创建）用它重放。
   * 上限与 JS 侧的保留窗口一致。
   */
  private val replayBuffer = StringBuilder()
  private var replayBufferBytes = 0
  private var appliedWriteSeq = 0
  private var hasReplayedIntoTerminal = false
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
      // A different terminal shares none of this one's history or write
      // sequence. JS remounts on identity, so this only backstops reuse.
      //
      // 换了终端就不共享历史和写入序号。JS 侧会按身份重挂载，
      // 这里只是复用场景的兜底。
      replayBuffer.setLength(0)
      replayBufferBytes = 0
      appliedWriteSeq = 0
      recreateTerminal()
    }

  var bufferWrite: TerminalBufferWriteRecord = TerminalBufferWriteRecord()
    set(value) {
      field = value
      applyBufferWrite(value)
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

  var autoFocus: Boolean = true
    set(value) {
      field = value
      if (value) {
        requestKeyboardFocus()
      } else {
        inputView.clearFocus()
        hideKeyboard()
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

      override fun selectionText(): String? =
        if (terminalHandle == 0L) {
          null
        } else {
          GhosttyBridge.nativeGetSelectionText(terminalHandle)?.let { String(it, Charsets.UTF_8) }
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
    replayIntoTerminal()
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
    hasReplayedIntoTerminal = false
  }

  private fun recreateTerminal() {
    if (terminalHandle == 0L) return
    destroyTerminal()
    createTerminal()
    replayIntoTerminal()
    renderSnapshot()
  }

  private fun destroyTerminal() {
    if (terminalHandle == 0L) return
    GhosttyBridge.nativeDestroy(terminalHandle)
    terminalHandle = 0L
    hasReplayedIntoTerminal = false
    terminalCanvas.resetSelectionState()
  }

  /**
   * Apply one incremental write from JS. Sequence numbers are monotonic, so a
   * prop update the view has already consumed is ignored rather than replayed.
   *
   * 应用 JS 侧的一次增量写入。序号单调递增，已消费过的 prop 更新直接忽略，
   * 不会重放。
   */
  private fun applyBufferWrite(write: TerminalBufferWriteRecord) {
    if (write.seq <= appliedWriteSeq) return
    appliedWriteSeq = write.seq

    if (write.reset) {
      replayBuffer.setLength(0)
      replayBufferBytes = 0
      // Clearing the live terminal is cheaper than recreating it, and it keeps
      // the keyboard and scroll position intact.
      //
      // 清屏比重建终端便宜得多，而且能保住键盘和滚动位置。
      if (terminalHandle != 0L) {
        feedIntoTerminal(CLEAR_SCREEN_SEQUENCE)
      }
    }

    appendToReplayBuffer(write.data)

    // No terminal yet (still unmeasured): the replay buffer carries the write
    // into the terminal once a resize creates it.
    //
    // 终端还没建（尚未测量完成）：写入先留在 replay buffer 里，
    // 等 resize 创建终端时一并喂入。
    if (terminalHandle == 0L) return

    // A reset carries retained history, not live output: its device-query
    // replies must not reach the shell either.
    //
    // reset 带的是保留历史而不是实时输出，它触发的设备查询回复同样不能发回 shell。
    feedIntoTerminal(write.data, emitReplies = !write.reset)
    renderSnapshot()
  }

  /**
   * Rebuild the visible grid from retained output. Device queries inside the
   * replayed bytes must not reach the live shell — they would land at the
   * prompt as junk — so the terminal's replies are dropped for the replay.
   *
   * 用保留的输出重建可见网格。重放数据里的设备查询不能发回正在运行的 shell，
   * 否则会在提示符处变成乱码，所以重放期间丢弃终端的回复。
   */
  private fun replayIntoTerminal() {
    if (terminalHandle == 0L || hasReplayedIntoTerminal) return
    hasReplayedIntoTerminal = true
    feedIntoTerminal(replayBuffer.toString(), emitReplies = false)
    renderSnapshot()
  }

  private fun feedIntoTerminal(data: String, emitReplies: Boolean = true) {
    if (terminalHandle == 0L || data.isEmpty()) return
    val response = GhosttyBridge.nativeFeed(terminalHandle, data.toByteArray(Charsets.UTF_8))
    if (emitReplies) emitResponse(response)
    // New output invalidates an active selection (matches the web drawer);
    // otherwise the copy toolbar drifts out of sync with the grid.
    if (terminalCanvas.hasActiveSelection()) {
      GhosttyBridge.nativeClearSelection(terminalHandle)
      terminalCanvas.resetSelectionState()
    }
  }

  private fun appendToReplayBuffer(data: String) {
    if (data.isEmpty()) return
    // StringBuilder, not `replayBuffer += data`: the latter copies the whole
    // retained window on every write, putting the cost this change removed
    // from JS straight back onto the UI thread.
    //
    // 用 StringBuilder 而不是 `replayBuffer += data`：后者每次写入都要拷贝整个
    // 保留窗口，等于把本次从 JS 侧去掉的开销原样搬到 UI 线程上。
    replayBuffer.append(data)
    replayBufferBytes += data.toByteArray(Charsets.UTF_8).size

    if (replayBufferBytes <= MAX_REPLAY_BUFFER_BYTES + REPLAY_BUFFER_TRIM_SLACK_BYTES) return

    // Drop from the front on a UTF-8 boundary. Only replay depth is lost; the
    // scrollback the user sees lives in the terminal itself.
    //
    // 从头部按 UTF-8 边界裁剪。只损失重放深度，用户看到的滚动历史
    // 由终端自己持有。
    val bytes = replayBuffer.toString().toByteArray(Charsets.UTF_8)
    var start = bytes.size - MAX_REPLAY_BUFFER_BYTES
    while (start < bytes.size && (bytes[start].toInt() and 0xC0) == 0x80) {
      start += 1
    }
    replayBuffer.setLength(0)
    replayBuffer.append(String(bytes, start, bytes.size - start, Charsets.UTF_8))
    replayBufferBytes = bytes.size - start
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

  private fun hideKeyboard() {
    val inputMethodManager = context.getSystemService(
      Context.INPUT_METHOD_SERVICE
    ) as? InputMethodManager
    inputMethodManager?.hideSoftInputFromWindow(windowToken, 0)
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

  private companion object {
    /**
     * Matches `DEFAULT_MAX_TERMINAL_BUFFER_BYTES` on the client runtime, so a
     * replay never holds more history than JS would have sent.
     *
     * 与 client runtime 的 `DEFAULT_MAX_TERMINAL_BUFFER_BYTES` 一致，
     * 重放持有的历史不会超过 JS 会发送的量。
     */
    const val MAX_REPLAY_BUFFER_BYTES = 512 * 1024

    /**
     * Trim only once the buffer runs this far past the cap, so a rolling window
     * costs one copy per slack window instead of one per write.
     *
     * 只有超出上限这么多才裁剪，滚动窗口的代价变成每个余量窗口一次拷贝，
     * 而不是每次写入一次。
     */
    const val REPLAY_BUFFER_TRIM_SLACK_BYTES = 64 * 1024

    /**
     * Erase scrollback, home the cursor, erase the screen.
     *
     * 清除滚动历史、光标归位、清屏。
     */
    const val CLEAR_SCREEN_SEQUENCE = "\u001B[3J\u001B[H\u001B[2J"
  }
}
