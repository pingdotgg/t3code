package expo.modules.t3terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.util.Log
import android.view.ActionMode
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.widget.OverScroller
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Bundled terminal font with Nerd Font glyphs (powerline, file icons).
 * MesloLGS NF is the powerlevel10k-tuned Meslo Nerd Font patch.
 */
internal object TerminalTypefaces {
  private var loaded = false
  var regular: Typeface = Typeface.MONOSPACE
    private set
  var bold: Typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    private set

  fun ensureLoaded(context: Context) {
    if (loaded) return
    loaded = true
    try {
      regular = Typeface.createFromAsset(context.assets, "fonts/MesloLGS-NF-Regular.ttf")
      bold = Typeface.createFromAsset(context.assets, "fonts/MesloLGS-NF-Bold.ttf")
    } catch (error: RuntimeException) {
      Log.w("TerminalCanvasView", "bundled terminal font unavailable, using monospace", error)
    }
  }
}

/**
 * Selection operations backed by the native terminal. The terminal owns the
 * selection state; the canvas only drives gestures and renders the result.
 */
internal interface TerminalSelectionDelegate {
  fun selectWordAt(col: Int, row: Int): Boolean

  fun extendSelection(anchorCol: Int, anchorRow: Int, col: Int, row: Int)

  fun selectAll(): Boolean

  fun clearSelection()

  fun selectionText(): String?
}

internal class TerminalCanvasView(context: Context) : View(context) {
  companion object {
    const val FLAG_BOLD = 1 shl 0
    const val FLAG_ITALIC = 1 shl 1
    const val FLAG_INVISIBLE = 1 shl 4
    const val FLAG_STRIKETHROUGH = 1 shl 5
    const val FLAG_OVERLINE = 1 shl 6
    const val FLAG_UNDERLINE = 1 shl 7
    const val FLAG_SELECTED = 1 shl 8

    private const val MENU_COPY = 1
    private const val MENU_SELECT_ALL = 2
    private const val HANDLE_COLOR = 0xFF7AA2F7.toInt()
  }

  private val density = resources.displayMetrics.density
  private val scaledDensity = density * resources.configuration.fontScale
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)

  init {
    TerminalTypefaces.ensureLoaded(context)
  }

  private val regularTypeface = TerminalTypefaces.regular
  private val boldTypeface = TerminalTypefaces.bold
  private val italicTypeface = Typeface.create(TerminalTypefaces.regular, Typeface.ITALIC)
  private val boldItalicTypeface = Typeface.create(TerminalTypefaces.bold, Typeface.ITALIC)
  private val gestureDetector = GestureDetector(context, TerminalGestureListener())
  private val contentPadding = 8f * density
  private var frame: TerminalFrame? = null
  private var scrollRemainder = 0f
  private val scroller = OverScroller(context)
  private var flingLastY = 0
  private val flingRunnable = object : Runnable {
    override fun run() {
      if (!scroller.computeScrollOffset()) return
      val currentY = scroller.currY
      val deltaPx = (currentY - flingLastY).toFloat()
      flingLastY = currentY
      scrollRemainder += -deltaPx / cellHeightPx
      val rows = scrollRemainder.toInt()
      if (rows != 0) {
        scrollRemainder -= rows
        onScrollRows?.invoke(rows)
      }
      postOnAnimation(this)
    }
  }
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
  var selectionDelegate: TerminalSelectionDelegate? = null

  private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var selectionActive = false
  private var dragSelecting = false
  private var draggingHandle = false
  private var anchorCol = 0
  private var anchorRow = 0
  private var extentCol = 0
  private var extentRow = 0

  // Word-snapped span from the initial long-press; extending anchors to the
  // far word edge so the word never shrinks mid-drag.
  private var wordStartCol = 0
  private var wordStartRow = 0
  private var wordEndCol = 0
  private var wordEndRow = 0
  private var actionMode: ActionMode? = null

  // Actual selection endpoints in viewport cells, derived from the decoded
  // frame (word-snap can extend past the pressed cell). Drive handle
  // placement and hit testing.
  private var selectionEndpointsValid = false
  private var selectionStartCol = 0
  private var selectionStartRow = 0
  private var selectionEndCol = 0
  private var selectionEndRow = 0

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
    updateSelectionEndpoints()
    removeCallbacks(cursorBlink)
    if (value.cursorBlinking && value.cursorVisible) postDelayed(cursorBlink, 500)
    invalidate()
  }

  fun resetSelectionState() {
    selectionActive = false
    dragSelecting = false
    draggingHandle = false
    selectionEndpointsValid = false
    actionMode?.finish()
  }

  fun hasActiveSelection(): Boolean = selectionActive

  fun usableWidth(): Float = max(width - contentPadding * 2f, 1f)
  fun usableHeight(): Float = max(height - contentPadding * 2f, 1f)

  @Suppress("NestedBlockDepth", "ComplexCondition")
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
    drawSelectionHandles(canvas)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      parent?.requestDisallowInterceptTouchEvent(true)
    } else if (event.actionMasked == MotionEvent.ACTION_UP ||
      event.actionMasked == MotionEvent.ACTION_CANCEL
    ) {
      parent?.requestDisallowInterceptTouchEvent(false)
    }
    if (dragSelecting) {
      when (event.actionMasked) {
        MotionEvent.ACTION_MOVE -> extendSelectionTo(event.x, event.y)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          dragSelecting = false
          showSelectionActions()
        }
      }
      return true
    }
    if (event.actionMasked == MotionEvent.ACTION_DOWN && grabHandleAt(event.x, event.y)) {
      return true
    }
    return gestureDetector.onTouchEvent(event) || super.onTouchEvent(event)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(cursorBlink)
    removeCallbacks(flingRunnable)
    actionMode?.finish()
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

  private fun columnAt(px: Float): Int {
    val cols = frame?.cols ?: return 0
    return ((px - contentPadding) / cellWidthPx).toInt().coerceIn(0, max(cols - 1, 0))
  }

  private fun rowAt(py: Float): Int {
    val rows = frame?.rows ?: return 0
    return ((py - contentPadding) / cellHeightPx).toInt().coerceIn(0, max(rows - 1, 0))
  }

  private fun startWordSelection(px: Float, py: Float) {
    val delegate = selectionDelegate ?: return
    val col = columnAt(px)
    val row = rowAt(py)
    // Set before selectWordAt: the delegate re-renders synchronously and
    // updateSelectionEndpoints only scans while a selection is active.
    selectionActive = true
    if (!delegate.selectWordAt(col, row)) {
      selectionActive = false
      return
    }
    dragSelecting = true
    draggingHandle = false
    if (selectionEndpointsValid) {
      wordStartCol = selectionStartCol
      wordStartRow = selectionStartRow
      wordEndCol = selectionEndCol
      wordEndRow = selectionEndRow
    } else {
      wordStartCol = col
      wordStartRow = row
      wordEndCol = col
      wordEndRow = row
    }
    anchorCol = wordStartCol
    anchorRow = wordStartRow
    extentCol = col
    extentRow = row
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
  }

  private fun extendSelectionTo(px: Float, py: Float) {
    if (!selectionActive) return
    val col = columnAt(px)
    val row = rowAt(py)
    if (col == extentCol && row == extentRow) return
    extentCol = col
    extentRow = row
    if (!draggingHandle) {
      val beforeWord = row < wordStartRow || (row == wordStartRow && col < wordStartCol)
      if (beforeWord) {
        anchorCol = wordEndCol
        anchorRow = wordEndRow
      } else {
        anchorCol = wordStartCol
        anchorRow = wordStartRow
      }
    }
    selectionDelegate?.extendSelection(anchorCol, anchorRow, col, row)
  }

  private fun clearSelection() {
    if (!selectionActive) return
    selectionActive = false
    dragSelecting = false
    draggingHandle = false
    selectionEndpointsValid = false
    actionMode?.finish()
    selectionDelegate?.clearSelection()
  }

  private fun copySelection() {
    val text = selectionDelegate?.selectionText() ?: return
    if (text.isEmpty()) return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    clipboard?.setPrimaryClip(ClipData.newPlainText("Terminal", text))
  }

  private fun handleCenterX(col: Int, leadingEdge: Boolean): Float =
    contentPadding + (col + if (leadingEdge) 0 else 1) * cellWidthPx

  private fun handleCenterY(row: Int): Float =
    contentPadding + (row + 1) * cellHeightPx + handleRadius()

  private fun handleRadius(): Float = max(cellHeightPx * 0.45f, 12f)

  /**
   * Begin dragging when the touch lands on a selection handle. The opposite
   * endpoint becomes the drag anchor so the grabbed end follows the finger.
   */
  private fun grabHandleAt(px: Float, py: Float): Boolean {
    if (!selectionActive || !selectionEndpointsValid) return false
    val slop = max(handleRadius() * 2f, 24 * density)

    fun near(cx: Float, cy: Float): Boolean {
      val dx = px - cx
      val dy = py - cy
      return dx * dx + dy * dy <= slop * slop
    }

    val startGrabbed =
      near(handleCenterX(selectionStartCol, true), handleCenterY(selectionStartRow))
    val endGrabbed =
      !startGrabbed && near(handleCenterX(selectionEndCol, false), handleCenterY(selectionEndRow))
    if (!startGrabbed && !endGrabbed) return false

    if (startGrabbed) {
      anchorCol = selectionEndCol
      anchorRow = selectionEndRow
      extentCol = selectionStartCol
      extentRow = selectionStartRow
    } else {
      anchorCol = selectionStartCol
      anchorRow = selectionStartRow
      extentCol = selectionEndCol
      extentRow = selectionEndRow
    }
    dragSelecting = true
    draggingHandle = true
    actionMode?.finish()
    return true
  }

  /** Scan the decoded frame for the first/last selected cells. */
  private fun updateSelectionEndpoints() {
    selectionEndpointsValid = false
    if (!selectionActive) return
    val currentFrame = frame ?: return
    val totalCells = currentFrame.cols * currentFrame.rows
    var first = -1
    var last = -1
    for (index in 0 until totalCells) {
      if (currentFrame.cellFlags[index] and FLAG_SELECTED != 0) {
        if (first < 0) first = index
        last = index
      }
    }
    if (first < 0 || currentFrame.cols == 0) return
    selectionStartCol = first % currentFrame.cols
    selectionStartRow = first / currentFrame.cols
    selectionEndCol = last % currentFrame.cols
    selectionEndRow = last / currentFrame.cols
    selectionEndpointsValid = true
  }

  // Anchor the toolbar to the actual word-snapped endpoints when known;
  // gesture cells can lag behind what the terminal selected.
  private fun selectionBounds(): Rect {
    val startCol = if (selectionEndpointsValid) selectionStartCol else min(anchorCol, extentCol)
    val endCol = if (selectionEndpointsValid) selectionEndCol else max(anchorCol, extentCol)
    val startRow = if (selectionEndpointsValid) selectionStartRow else min(anchorRow, extentRow)
    val endRow = if (selectionEndpointsValid) selectionEndRow else max(anchorRow, extentRow)
    val left = contentPadding + min(startCol, endCol) * cellWidthPx
    val right = contentPadding + (max(startCol, endCol) + 1) * cellWidthPx
    val top = contentPadding + startRow * cellHeightPx
    val bottom = contentPadding + (endRow + 1) * cellHeightPx
    return Rect(left.toInt(), top.toInt(), right.toInt(), bottom.toInt())
  }

  private fun showSelectionActions() {
    if (actionMode != null || !selectionActive) return
    actionMode = startActionMode(
      object : ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
          menu.add(Menu.NONE, MENU_COPY, 0, android.R.string.copy)
          menu.add(Menu.NONE, MENU_SELECT_ALL, 1, android.R.string.selectAll)
          return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean =
          when (item.itemId) {
            MENU_COPY -> {
              copySelection()
              clearSelection()
              true
            }
            MENU_SELECT_ALL -> {
              val currentFrame = frame
              if (currentFrame != null && selectionDelegate?.selectAll() == true) {
                anchorCol = 0
                anchorRow = 0
                extentCol = max(currentFrame.cols - 1, 0)
                extentRow = max(currentFrame.rows - 1, 0)
              }
              true
            }
            else -> false
          }

        override fun onDestroyActionMode(mode: ActionMode) {
          actionMode = null
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
          outRect.set(selectionBounds())
        }
      },
      ActionMode.TYPE_FLOATING,
    )
  }

  private fun drawSelectionHandles(canvas: Canvas) {
    if (!selectionActive || !selectionEndpointsValid) return
    val radius = handleRadius()
    handlePaint.color = HANDLE_COLOR
    val stemWidth = max(radius / 4f, 2f)

    fun drawHandle(cx: Float, row: Int) {
      val cornerY = contentPadding + (row + 1) * cellHeightPx
      val cy = handleCenterY(row)
      canvas.drawRect(cx - stemWidth / 2f, cornerY, cx + stemWidth / 2f, cy, handlePaint)
      canvas.drawCircle(cx, cy, radius, handlePaint)
    }

    drawHandle(handleCenterX(selectionStartCol, true), selectionStartRow)
    drawHandle(handleCenterX(selectionEndCol, false), selectionEndRow)
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
      scroller.forceFinished(true)
      removeCallbacks(flingRunnable)
      onRequestKeyboard?.invoke()
      return true
    }

    override fun onSingleTapUp(event: MotionEvent): Boolean {
      if (selectionActive) {
        clearSelection()
      } else {
        performClick()
      }
      return true
    }

    override fun onLongPress(event: MotionEvent) {
      startWordSelection(event.x, event.y)
    }

    override fun onScroll(
      first: MotionEvent?,
      current: MotionEvent,
      distanceX: Float,
      distanceY: Float
    ): Boolean {
      scrollRemainder += distanceY / cellHeightPx
      val rows = scrollRemainder.toInt()
      if (rows != 0) {
        scrollRemainder -= rows
        onScrollRows?.invoke(rows)
      }
      return true
    }

    override fun onFling(
      first: MotionEvent?,
      current: MotionEvent,
      velocityX: Float,
      velocityY: Float
    ): Boolean {
      flingLastY = 0
      scroller.fling(0, 0, 0, velocityY.toInt(), 0, 0, Int.MIN_VALUE / 2, Int.MAX_VALUE / 2)
      postOnAnimation(flingRunnable)
      return true
    }
  }
}
