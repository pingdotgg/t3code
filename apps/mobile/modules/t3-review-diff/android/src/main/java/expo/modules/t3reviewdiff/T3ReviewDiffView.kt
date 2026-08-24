package expo.modules.t3reviewdiff

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.widget.OverScroller
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

class T3ReviewDiffView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val canvasView = DiffCanvasView(context)
  private val onDebug by EventDispatcher()
  private val onVisibleFileChange by EventDispatcher()
  private val onToggleFile by EventDispatcher()
  private val onToggleViewedFile by EventDispatcher()
  private val onPressLine by EventDispatcher()
  private val onToggleComment by EventDispatcher()
  private var rows: List<DiffRow> = emptyList()
  private var visibleRows: List<DiffRow> = emptyList()
  private var collapsedFileIds: Set<String> = emptySet()
  private var viewedFileIds: Set<String> = emptySet()
  private var selectedRowIds: Set<String> = emptySet()
  private var collapsedCommentIds: Set<String> = emptySet()
  private var initialRowIndex = 0
  private var pendingInitialScroll = false
  private var lastVisibleFileId: String? = null
  private var tokensResetKey = ""
  private var contentResetKey = ""
  private var rowsDecodeGeneration = 0
  private var tokensDecodeGeneration = 0
  private val payloadDecodeExecutor = Executors.newSingleThreadExecutor()
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private val verticalScroller = OverScroller(context)
  private val horizontalScroller = OverScroller(context)
  private var dragAxis: DragAxis? = null
  private var horizontalDragTarget: HorizontalPanTarget? = null
  private var lastTouchX = 0f
  private var lastTouchY = 0f
  private var velocityTracker: VelocityTracker? = null

  init {
    canvasView.onRowTap = { row, gesture, target -> handleRowTap(row, gesture, target) }
    canvasView.onVisibleRowsChanged = { first, last ->
      onDebug(
        mapOf(
          "message" to "visible-range",
          "firstRowIndex" to first,
          "lastRowIndex" to last,
        ),
      )
      emitVisibleFile(first)
    }

    addView(
      canvasView,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  fun setTokensResetKey(value: String) {
    if (tokensResetKey == value) return
    tokensResetKey = value
    canvasView.tokensByRowId = emptyMap()
  }

  fun setContentResetKey(value: String) {
    if (contentResetKey == value) return
    contentResetKey = value
    tokensDecodeGeneration += 1
    canvasView.tokensByRowId = emptyMap()
    lastVisibleFileId = null
    pendingInitialScroll = true
    canvasView.setVerticalOffset(0)
    canvasView.resetHorizontalOffsets()
    applyPendingInitialScroll()
  }

  fun setCollapsedFileIdsJson(value: String) {
    collapsedFileIds = parseStringSet(value)
    canvasView.collapsedFileIds = collapsedFileIds
    rebuildVisibleRows()
  }

  fun setViewedFileIdsJson(value: String) {
    viewedFileIds = parseStringSet(value)
    canvasView.viewedFileIds = viewedFileIds
  }

  fun setSelectedRowIdsJson(value: String) {
    selectedRowIds = parseStringSet(value)
    canvasView.selectedRowIds = selectedRowIds
  }

  fun setCollapsedCommentIdsJson(value: String) {
    collapsedCommentIds = parseStringSet(value)
    canvasView.collapsedCommentIds = collapsedCommentIds
    rebuildVisibleRows()
  }

  fun setAppearanceScheme(value: String) {
    canvasView.theme = DiffTheme.fallback(value)
  }

  fun setThemeJson(value: String) {
    canvasView.theme = DiffTheme.fromJson(value, canvasView.theme)
  }

  fun setStyleJson(value: String) {
    canvasView.style = DiffStyle.fromJson(value, canvasView.style, resources.displayMetrics.density)
  }

  fun setRowHeight(value: Float) {
    canvasView.style = canvasView.style.copy(rowHeightPx = dp(value))
  }

  fun setContentWidth(value: Float) {
    canvasView.contentWidthPx = max(width, dp(value).toInt())
  }

  fun setInitialRowIndex(value: Double) {
    initialRowIndex = value.toInt().coerceAtLeast(0)
    pendingInitialScroll = true
    applyPendingInitialScroll()
  }

  fun setRowsJson(value: String) {
    rowsDecodeGeneration += 1
    val generation = rowsDecodeGeneration
    payloadDecodeExecutor.execute {
      val decodedRows = parseRows(value)
      post {
        if (generation != rowsDecodeGeneration) return@post
        rows = decodedRows
        lastVisibleFileId = null
        rebuildVisibleRows()
      }
    }
  }

  fun setTokensJson(value: String) {
    tokensDecodeGeneration += 1
    val generation = tokensDecodeGeneration
    payloadDecodeExecutor.execute {
      val decodedTokens = parseTokensObject(value)
      post {
        if (generation != tokensDecodeGeneration) return@post
        canvasView.tokensByRowId = decodedTokens
      }
    }
  }

  fun setTokensPatchJson(value: String) {
    payloadDecodeExecutor.execute {
      try {
        val payload = JSONObject(value)
        val resetKey = payload.optString("resetKey")
        val decodedTokens = parseTokensObject(
          payload.optJSONObject("tokensByRowId") ?: JSONObject(),
        )
        post {
          if (resetKey.isNotEmpty() && resetKey != tokensResetKey) return@post
          if (decodedTokens.isNotEmpty()) {
            canvasView.tokensByRowId = canvasView.tokensByRowId + decodedTokens
          }
        }
      } catch (_: Exception) {
      }
    }
  }

  fun cleanup() {
    payloadDecodeExecutor.shutdownNow()
  }

  fun scrollToFile(fileId: String, animated: Boolean) {
    val index = visibleRows.indexOfFirst { it.kind == "file" && it.resolvedFileId == fileId }
    if (index < 0) return
    scrollToY(canvasView.rowTop(index), animated)
  }

  fun scrollToTop(animated: Boolean) {
    scrollToY(0, animated)
  }

  @Suppress("NestedBlockDepth", "ReturnCount")
  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        verticalScroller.forceFinished(true)
        horizontalScroller.forceFinished(true)
        dragAxis = null
        horizontalDragTarget = canvasView.horizontalPanTarget(event.y)
        lastTouchX = event.x
        lastTouchY = event.y
        parent?.requestDisallowInterceptTouchEvent(true)
        return false
      }
      MotionEvent.ACTION_MOVE -> {
        if (dragAxis == null) {
          val deltaX = event.x - lastTouchX
          val deltaY = event.y - lastTouchY
          if (max(abs(deltaX), abs(deltaY)) > touchSlop) {
            dragAxis = if (abs(deltaY) >= abs(deltaX)) {
              DragAxis.VERTICAL
            } else {
              horizontalDragTarget
                ?.takeIf { canvasView.maxHorizontalOffset(it) > 0 }
                ?.let { DragAxis.HORIZONTAL }
            }
          }
        }
        return dragAxis != null
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> return dragAxis != null
    }
    return false
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      velocityTracker?.recycle()
      velocityTracker = VelocityTracker.obtain()
    }
    velocityTracker?.addMovement(event)
    val handled = super.dispatchTouchEvent(event)
    if (
      (
        event.actionMasked == MotionEvent.ACTION_UP ||
          event.actionMasked == MotionEvent.ACTION_CANCEL
        ) &&
      dragAxis == null
    ) {
      velocityTracker?.recycle()
      velocityTracker = null
      horizontalDragTarget = null
      parent?.requestDisallowInterceptTouchEvent(false)
    }
    return handled
  }

  @Suppress("NestedBlockDepth")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    val axis = dragAxis ?: return false
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        val deltaX = (lastTouchX - event.x).toInt()
        val deltaY = (lastTouchY - event.y).toInt()
        if (axis == DragAxis.VERTICAL) {
          canvasView.scrollByVertical(deltaY)
        } else {
          horizontalDragTarget?.let { canvasView.scrollByHorizontal(deltaX, it) }
        }
        lastTouchX = event.x
        lastTouchY = event.y
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (event.actionMasked == MotionEvent.ACTION_UP) {
          velocityTracker?.computeCurrentVelocity(1000)
          if (axis == DragAxis.VERTICAL) {
            val velocity = -(velocityTracker?.yVelocity ?: 0f).toInt()
            if (abs(velocity) >= minimumFlingVelocity) {
              verticalScroller.fling(
                0,
                canvasView.verticalOffset(),
                0,
                velocity,
                0,
                0,
                0,
                canvasView.maxVerticalOffset(),
              )
              postInvalidateOnAnimation()
            }
          } else if (horizontalDragTarget?.kind == HorizontalPanKind.CODE) {
            val velocity = -(velocityTracker?.xVelocity ?: 0f).toInt()
            if (abs(velocity) >= minimumFlingVelocity) {
              horizontalScroller.fling(
                canvasView.horizontalOffset(),
                0,
                velocity,
                0,
                0,
                canvasView.maxHorizontalOffset(),
                0,
                0,
              )
              postInvalidateOnAnimation()
            }
          }
        }
        dragAxis = null
        horizontalDragTarget = null
        velocityTracker?.recycle()
        velocityTracker = null
        parent?.requestDisallowInterceptTouchEvent(false)
      }
    }
    return true
  }

  override fun computeScroll() {
    var animating = false
    if (verticalScroller.computeScrollOffset()) {
      canvasView.setVerticalOffset(verticalScroller.currY)
      animating = true
    }
    if (horizontalScroller.computeScrollOffset()) {
      canvasView.setHorizontalOffset(horizontalScroller.currX)
      animating = true
    }
    if (animating) {
      postInvalidateOnAnimation()
    }
  }

  private fun rebuildVisibleRows() {
    val filtered = ArrayList<DiffRow>(rows.size)
    var currentFileCollapsed = false
    rows.forEach { row ->
      if (row.kind == "file") {
        currentFileCollapsed = collapsedFileIds.contains(row.resolvedFileId)
        filtered.add(row)
      } else if (!currentFileCollapsed) {
        filtered.add(row)
      }
    }
    visibleRows = filtered
    canvasView.rows = filtered
    canvasView.viewedFileIds = viewedFileIds
    canvasView.selectedRowIds = selectedRowIds
    applyPendingInitialScroll()
  }

  private fun handleRowTap(row: DiffRow, gesture: String, target: RowTapTarget) {
    when (row.kind) {
      "file" -> {
        if (gesture != "tap") return
        if (target == RowTapTarget.VIEWED_CHECKBOX) {
          onToggleViewedFile(mapOf("fileId" to row.resolvedFileId))
        } else {
          onToggleFile(mapOf("fileId" to row.resolvedFileId))
        }
      }
      "comment" -> onToggleComment(mapOf("commentId" to row.id))
      "line" -> {
        val payload = mutableMapOf<String, Any>(
          "rowId" to row.id,
          "fileId" to row.resolvedFileId,
          "gesture" to gesture,
          "change" to row.change,
        )
        row.oldLineNumber?.let { payload["oldLineNumber"] = it }
        row.newLineNumber?.let { payload["newLineNumber"] = it }
        onPressLine(payload)
      }
    }
  }

  @Suppress("ReturnCount")
  private fun emitVisibleFile(firstVisibleIndex: Int) {
    if (visibleRows.isEmpty()) return
    val start = firstVisibleIndex.coerceIn(0, visibleRows.lastIndex)
    val fileId = (start downTo 0)
      .asSequence()
      .map { visibleRows[it].resolvedFileId }
      .firstOrNull { it.isNotEmpty() }
      ?: return
    if (fileId == lastVisibleFileId) return
    lastVisibleFileId = fileId
    onVisibleFileChange(mapOf("fileId" to fileId))
  }

  private fun applyPendingInitialScroll() {
    if (!pendingInitialScroll || visibleRows.isEmpty()) return
    pendingInitialScroll = false
    val index = initialRowIndex.coerceIn(0, visibleRows.lastIndex)
    post { canvasView.setVerticalOffset(canvasView.rowTop(index)) }
  }

  private fun scrollToY(y: Int, animated: Boolean) {
    val target = y.coerceIn(0, canvasView.maxVerticalOffset())
    if (animated) {
      verticalScroller.startScroll(
        0,
        canvasView.verticalOffset(),
        0,
        target - canvasView.verticalOffset(),
        250,
      )
      postInvalidateOnAnimation()
    } else {
      canvasView.setVerticalOffset(target)
    }
  }

  private fun dp(value: Float): Float = value * resources.displayMetrics.density

  private enum class DragAxis {
    VERTICAL,
    HORIZONTAL
  }
}

private enum class RowTapTarget {
  ROW,
  VIEWED_CHECKBOX
}

private enum class HorizontalPanKind {
  CODE,
  FILE_HEADER_PATH
}

private data class HorizontalPanTarget(
  val fileId: String,
  val kind: HorizontalPanKind
)

internal data class DiffRow(
  val kind: String,
  val id: String,
  val fileId: String,
  val filePath: String,
  val previousPath: String?,
  val changeType: String,
  val additions: Int,
  val deletions: Int,
  val text: String,
  val content: String,
  val change: String,
  val oldLineNumber: Int?,
  val newLineNumber: Int?,
  val wordDiffRanges: List<DiffWordDiffRange>,
  val commentText: String,
  val commentRangeLabel: String,
  val commentSectionTitle: String
) {
  val resolvedFileId: String get() = fileId.ifEmpty { id }
}

internal data class DiffWordDiffRange(
  val start: Int,
  val end: Int
)

private data class DiffToken(
  val content: String,
  val color: Int?,
  val fontStyle: Int
)

internal data class DiffTheme(
  val background: Int,
  val text: Int,
  val mutedText: Int,
  val headerBackground: Int,
  val border: Int,
  val hunkBackground: Int,
  val hunkText: Int,
  val addBackground: Int,
  val deleteBackground: Int,
  val addBar: Int,
  val deleteBar: Int,
  val addText: Int,
  val deleteText: Int
) {
  companion object {
    fun fallback(scheme: String): DiffTheme = if (scheme == "dark") {
      DiffTheme(
        background = Color.rgb(20, 22, 25),
        text = Color.rgb(236, 238, 240),
        mutedText = Color.rgb(153, 160, 170),
        headerBackground = Color.rgb(26, 29, 33),
        border = Color.rgb(52, 57, 64),
        hunkBackground = Color.rgb(7, 31, 40),
        hunkText = Color.rgb(0, 159, 255),
        addBackground = Color.rgb(13, 47, 40),
        deleteBackground = Color.rgb(57, 20, 21),
        addBar = Color.rgb(0, 202, 177),
        deleteBar = Color.rgb(255, 46, 63),
        addText = Color.rgb(94, 204, 113),
        deleteText = Color.rgb(255, 103, 98),
      )
    } else {
      DiffTheme(
        background = Color.WHITE,
        text = Color.rgb(7, 7, 7),
        mutedText = Color.rgb(102, 106, 115),
        headerBackground = Color.WHITE,
        border = Color.rgb(222, 224, 228),
        hunkBackground = Color.rgb(224, 242, 255),
        hunkText = Color.rgb(0, 130, 220),
        addBackground = Color.rgb(229, 248, 245),
        deleteBackground = Color.rgb(255, 230, 231),
        addBar = Color.rgb(0, 172, 151),
        deleteBar = Color.rgb(213, 44, 54),
        addText = Color.rgb(25, 130, 67),
        deleteText = Color.rgb(190, 38, 48),
      )
    }

    fun fromJson(value: String, fallback: DiffTheme): DiffTheme = try {
      val json = JSONObject(value)
      DiffTheme(
        background = color(json, "background", fallback.background),
        text = color(json, "text", fallback.text),
        mutedText = color(json, "mutedText", fallback.mutedText),
        headerBackground = color(json, "headerBackground", fallback.headerBackground),
        border = color(json, "border", fallback.border),
        hunkBackground = color(json, "hunkBackground", fallback.hunkBackground),
        hunkText = color(json, "hunkText", fallback.hunkText),
        addBackground = color(json, "addBackground", fallback.addBackground),
        deleteBackground = color(json, "deleteBackground", fallback.deleteBackground),
        addBar = color(json, "addBar", fallback.addBar),
        deleteBar = color(json, "deleteBar", fallback.deleteBar),
        addText = color(json, "addText", fallback.addText),
        deleteText = color(json, "deleteText", fallback.deleteText),
      )
    } catch (_: Exception) {
      fallback
    }

    private fun color(json: JSONObject, key: String, fallback: Int): Int =
      parseColor(json.optString(key), fallback)
  }
}

internal data class DiffStyle(
  val rowHeightPx: Float,
  val gutterWidthPx: Float,
  val codePaddingPx: Float,
  val changeBarWidthPx: Float,
  val fileHeaderHeightPx: Float,
  val fileHeaderHorizontalPaddingPx: Float,
  val codeFontSizePx: Float,
  val codeFontWeight: String,
  val lineNumberFontSizePx: Float,
  val lineNumberFontWeight: String,
  val hunkFontSizePx: Float,
  val hunkFontWeight: String,
  val fileHeaderFontSizePx: Float,
  val fileHeaderFontWeight: String,
  val fileHeaderMetaFontSizePx: Float,
  val fileHeaderMetaFontWeight: String,
  val fileHeaderSubtextFontSizePx: Float,
  val fileHeaderSubtextFontWeight: String
) {
  companion object {
    fun defaults(density: Float): DiffStyle = DiffStyle(
      rowHeightPx = 20f * density,
      gutterWidthPx = 72f * density,
      codePaddingPx = 10f * density,
      changeBarWidthPx = 3f * density,
      fileHeaderHeightPx = 44f * density,
      fileHeaderHorizontalPaddingPx = 10f * density,
      codeFontSizePx = 12f * density,
      codeFontWeight = "regular",
      lineNumberFontSizePx = 10f * density,
      lineNumberFontWeight = "regular",
      hunkFontSizePx = 11f * density,
      hunkFontWeight = "medium",
      fileHeaderFontSizePx = 11f * density,
      fileHeaderFontWeight = "semibold",
      fileHeaderMetaFontSizePx = 10f * density,
      fileHeaderMetaFontWeight = "semibold",
      fileHeaderSubtextFontSizePx = 11f * density,
      fileHeaderSubtextFontWeight = "medium",
    )

    fun fromJson(value: String, fallback: DiffStyle, density: Float): DiffStyle = try {
      val json = JSONObject(value)
      DiffStyle(
        rowHeightPx = json.floatDp("rowHeight", fallback.rowHeightPx, density),
        gutterWidthPx = json.floatDp("gutterWidth", fallback.gutterWidthPx, density),
        codePaddingPx = json.floatDp("codePadding", fallback.codePaddingPx, density),
        changeBarWidthPx = json.floatDp("changeBarWidth", fallback.changeBarWidthPx, density),
        fileHeaderHeightPx = json.floatDp("fileHeaderHeight", fallback.fileHeaderHeightPx, density),
        fileHeaderHorizontalPaddingPx = json.floatDp(
          "fileHeaderHorizontalPadding",
          fallback.fileHeaderHorizontalPaddingPx,
          density,
        ),
        codeFontSizePx = json.floatSp("codeFontSize", fallback.codeFontSizePx, density),
        codeFontWeight = json.optString("codeFontWeight", fallback.codeFontWeight),
        lineNumberFontSizePx = json.floatSp(
          "lineNumberFontSize",
          fallback.lineNumberFontSizePx,
          density,
        ),
        lineNumberFontWeight = json.optString(
          "lineNumberFontWeight",
          fallback.lineNumberFontWeight,
        ),
        hunkFontSizePx = json.floatSp("hunkFontSize", fallback.hunkFontSizePx, density),
        hunkFontWeight = json.optString("hunkFontWeight", fallback.hunkFontWeight),
        fileHeaderFontSizePx = json.floatSp(
          "fileHeaderFontSize",
          fallback.fileHeaderFontSizePx,
          density,
        ),
        fileHeaderFontWeight = json.optString(
          "fileHeaderFontWeight",
          fallback.fileHeaderFontWeight,
        ),
        fileHeaderMetaFontSizePx = json.floatSp(
          "fileHeaderMetaFontSize",
          fallback.fileHeaderMetaFontSizePx,
          density,
        ),
        fileHeaderMetaFontWeight = json.optString(
          "fileHeaderMetaFontWeight",
          fallback.fileHeaderMetaFontWeight,
        ),
        fileHeaderSubtextFontSizePx = json.floatSp(
          "fileHeaderSubtextFontSize",
          fallback.fileHeaderSubtextFontSizePx,
          density,
        ),
        fileHeaderSubtextFontWeight = json.optString(
          "fileHeaderSubtextFontWeight",
          fallback.fileHeaderSubtextFontWeight,
        ),
      )
    } catch (_: Exception) {
      fallback
    }
  }
}

private class DiffCanvasView(context: Context) : View(context) {
  private val density = resources.displayMetrics.density
  private val drawing = ReviewDiffCanvasDrawing(context)
  private val backgroundPaint = drawing.backgroundPaint
  private val borderPaint = drawing.borderPaint
  private val textPaint = drawing.textPaint
  private val boldTextPaint = drawing.uiPaint
  private val gestureDetector = GestureDetector(
    context,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(event: MotionEvent): Boolean = true

      override fun onSingleTapUp(event: MotionEvent): Boolean {
        rowHitAt(event.y)?.let { hit ->
          val target = if (
            hit.row.kind == "file" &&
            drawing.fileHeaderCheckboxRect(
              hit.top,
              hit.bottom,
              width,
              style
            ).contains(event.x, event.y)
          ) {
            RowTapTarget.VIEWED_CHECKBOX
          } else {
            RowTapTarget.ROW
          }
          onRowTap?.invoke(hit.row, "tap", target)
        }
        return true
      }

      override fun onLongPress(event: MotionEvent) {
        rowHitAt(event.y)?.row
          ?.takeIf { it.kind == "line" }
          ?.let { onRowTap?.invoke(it, "longPress", RowTapTarget.ROW) }
      }
    },
  )
  private var rowOffsets = intArrayOf(0)
  private var verticalOffset = 0
  private var horizontalOffset = 0
  private val headerPathOffsetsByFileId = mutableMapOf<String, Int>()
  private var lastVisibleRange: Pair<Int, Int>? = null
  var rows: List<DiffRow> = emptyList()
    set(value) {
      field = value
      headerPathOffsetsByFileId.keys.retainAll(
        value.asSequence().filter { it.kind == "file" }.map { it.resolvedFileId }.toSet(),
      )
      rebuildOffsets()
    }
  var tokensByRowId: Map<String, List<DiffToken>> = emptyMap()
    set(value) {
      field = value
      invalidate()
    }
  var viewedFileIds: Set<String> = emptySet()
    set(value) {
      field = value
      invalidate()
    }
  var collapsedFileIds: Set<String> = emptySet()
    set(value) {
      field = value
      invalidate()
    }
  var collapsedCommentIds: Set<String> = emptySet()
    set(value) {
      field = value
      rebuildOffsets()
    }
  var selectedRowIds: Set<String> = emptySet()
    set(value) {
      field = value
      invalidate()
    }
  var theme: DiffTheme = DiffTheme.fallback("light")
    set(value) {
      field = value
      drawing.theme = value
      invalidate()
    }
  var style: DiffStyle = DiffStyle.defaults(density)
    set(value) {
      field = value
      rebuildOffsets()
    }
  var contentWidthPx: Int = (1200 * density).toInt()
    set(value) {
      field = max(value, suggestedMinimumWidth)
      setHorizontalOffset(horizontalOffset)
      clampHeaderPathOffsets()
      invalidate()
    }
  var onRowTap: ((DiffRow, String, RowTapTarget) -> Unit)? = null
  var onVisibleRowsChanged: ((Int, Int) -> Unit)? = null

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(
      MeasureSpec.getSize(widthMeasureSpec),
      MeasureSpec.getSize(heightMeasureSpec),
    )
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    setVerticalOffset(verticalOffset)
    setHorizontalOffset(horizontalOffset)
    clampHeaderPathOffsets()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(theme.background)
    if (rows.isEmpty()) return
    val first = rowIndexAt(max(0, verticalOffset + canvas.clipBounds.top))
    val last = rowIndexAt(
      min(max(0, rowOffsets.last() - 1), verticalOffset + canvas.clipBounds.bottom),
    ).coerceAtLeast(first)
    for (index in first..last.coerceAtMost(rows.lastIndex)) {
      drawRow(
        canvas,
        rows[index],
        rowOffsets[index] - verticalOffset,
        rowOffsets[index + 1] - verticalOffset,
      )
    }
    drawStickyFileHeader(canvas, first)
    drawHorizontalScrollIndicator(canvas)
    emitVisibleRange()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean = gestureDetector.onTouchEvent(event)

  fun rowTop(index: Int): Int = rowOffsets[index.coerceIn(0, max(0, rowOffsets.size - 2))]

  fun setVerticalOffset(value: Int) {
    val maxOffset = max(0, (rowOffsets.lastOrNull() ?: 0) - height)
    val nextOffset = value.coerceIn(0, maxOffset)
    if (verticalOffset == nextOffset) return
    verticalOffset = nextOffset
    invalidate()
    emitVisibleRange()
  }

  fun scrollByVertical(delta: Int) {
    setVerticalOffset(verticalOffset + delta)
  }

  fun verticalOffset(): Int = verticalOffset

  fun maxVerticalOffset(): Int = max(0, (rowOffsets.lastOrNull() ?: 0) - height)

  fun setHorizontalOffset(value: Int) {
    val nextOffset = value.coerceIn(0, maxHorizontalOffset())
    if (horizontalOffset == nextOffset) return
    horizontalOffset = nextOffset
    invalidate()
  }

  fun scrollByHorizontal(delta: Int, target: HorizontalPanTarget) {
    if (target.kind == HorizontalPanKind.FILE_HEADER_PATH) {
      setHeaderPathOffset(
        target.fileId,
        (headerPathOffsetsByFileId[target.fileId] ?: 0) + delta,
      )
    } else {
      setHorizontalOffset(horizontalOffset + delta)
    }
  }

  fun horizontalOffset(): Int = horizontalOffset

  fun maxHorizontalOffset(): Int = max(0, contentWidthPx - width)

  fun maxHorizontalOffset(target: HorizontalPanTarget): Int =
    if (target.kind == HorizontalPanKind.FILE_HEADER_PATH) {
      maxHeaderPathOffset(target.fileId)
    } else {
      maxHorizontalOffset()
    }

  fun horizontalPanTarget(y: Float): HorizontalPanTarget? {
    val row = rowHitAt(y)?.row ?: return null
    return HorizontalPanTarget(
      fileId = row.resolvedFileId,
      kind = if (row.kind == "file") HorizontalPanKind.FILE_HEADER_PATH else HorizontalPanKind.CODE,
    )
  }

  fun resetHorizontalOffsets() {
    setHorizontalOffset(0)
    if (headerPathOffsetsByFileId.isNotEmpty()) {
      headerPathOffsetsByFileId.clear()
      invalidate()
    }
  }

  private fun rebuildOffsets() {
    rowOffsets = IntArray(rows.size + 1)
    rows.forEachIndexed { index, row ->
      rowOffsets[index + 1] = rowOffsets[index] + rowHeight(row)
    }
    setVerticalOffset(verticalOffset)
    clampHeaderPathOffsets()
    requestLayout()
    invalidate()
  }

  private fun rowHeight(row: DiffRow): Int = when (row.kind) {
    "file" -> style.fileHeaderHeightPx.toInt()
    "notice" -> max((style.rowHeightPx * 2f).toInt(), (44 * density).toInt())
    "comment" -> if (collapsedCommentIds.contains(row.id)) {
      (44 * density).toInt()
    } else {
      (124 * density).toInt()
    }
    else -> style.rowHeightPx.toInt()
  }.coerceAtLeast(1)

  @Suppress("ReturnCount")
  private fun rowIndexAt(y: Int): Int {
    if (rows.isEmpty()) return 0
    var low = 0
    var high = rows.lastIndex
    while (low <= high) {
      val middle = (low + high) ushr 1
      when {
        y < rowOffsets[middle] -> high = middle - 1
        y >= rowOffsets[middle + 1] -> low = middle + 1
        else -> return middle
      }
    }
    return low.coerceIn(0, rows.lastIndex)
  }

  private fun rowHitAt(y: Float): RowHit? {
    stickyFileHeader(firstVisibleRow())?.let { sticky ->
      if (y >= max(0, sticky.top).toFloat() && y < sticky.bottom.toFloat()) {
        return rows.getOrNull(sticky.index)?.let { RowHit(it, sticky.top, sticky.bottom) }
      }
    }
    val index = rowIndexAt(verticalOffset + y.toInt())
    return rows.getOrNull(index)?.let {
      RowHit(
        row = it,
        top = rowOffsets[index] - verticalOffset,
        bottom = rowOffsets[index + 1] - verticalOffset,
      )
    }
  }

  private fun firstVisibleRow(): Int = rowIndexAt(verticalOffset)

  private fun emitVisibleRange() {
    if (rows.isEmpty()) return
    val first = rowIndexAt(verticalOffset)
    val last = rowIndexAt(verticalOffset + max(1, height))
    val range = first to last
    if (range == lastVisibleRange) return
    lastVisibleRange = range
    onVisibleRowsChanged?.invoke(first, last)
  }

  private fun drawRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    when (row.kind) {
      "file" -> drawFileRow(canvas, row, top, bottom)
      "hunk" -> drawHunkRow(canvas, row, top, bottom)
      "notice" -> drawNoticeRow(canvas, row, top, bottom)
      "comment" -> drawCommentRow(canvas, row, top, bottom)
      else -> drawLineRow(canvas, row, top, bottom)
    }
  }

  private fun drawFileRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    fill(canvas, theme.headerBackground, 0f, top.toFloat(), width.toFloat(), bottom.toFloat())

    val chevronRect = drawing.fileHeaderChevronRect(top, bottom, style)
    val iconRect = drawing.fileHeaderIconRect(top, bottom, style)
    val checkboxRect = drawing.fileHeaderCheckboxRect(top, bottom, width, style)
    drawing.drawDisclosureChevron(
      canvas,
      chevronRect,
      theme.mutedText,
      collapsed = collapsedFileIds.contains(row.resolvedFileId),
    )
    drawing.drawFileIcon(canvas, iconRect, row.changeType)
    drawing.drawViewedCheckbox(
      canvas,
      checkboxRect,
      viewedFileIds.contains(row.resolvedFileId),
    )

    drawing.configureUiPaint(
      paint = boldTextPaint,
      color = theme.deleteText,
      size = style.fileHeaderMetaFontSizePx,
      weight = style.fileHeaderMetaFontWeight,
    )
    val deleteText = "-${row.deletions}"
    val deleteWidth = boldTextPaint.measureText(deleteText)
    val addText = "+${row.additions}"
    val addWidth = boldTextPaint.measureText(addText)
    val countGap = 4f * density
    val countsX = checkboxRect.left - 10f * density - deleteWidth - countGap - addWidth
    val baseline = centeredBaseline(top, bottom, boldTextPaint)
    canvas.drawText(deleteText, countsX, baseline, boldTextPaint)
    boldTextPaint.color = theme.addText
    canvas.drawText(addText, countsX + deleteWidth + countGap, baseline, boldTextPaint)

    val pathLayout = fileHeaderPathLayout(row, top, bottom, iconRect, countsX)
    val maxPathOffset = maxHeaderPathOffset(pathLayout)
    val pathOffset = (headerPathOffsetsByFileId[row.resolvedFileId] ?: 0)
      .coerceIn(0, maxPathOffset)
    canvas.save()
    canvas.clipRect(pathLayout.rect)
    canvas.drawText(
      pathLayout.displayPath,
      pathLayout.rect.left - pathOffset,
      centeredBaseline(top, bottom, boldTextPaint),
      boldTextPaint,
    )
    canvas.restore()
    drawing.drawFileHeaderPathScrollFades(
      canvas,
      pathLayout.rect,
      pathOffset,
      maxPathOffset,
    )
    drawBottomBorder(canvas, bottom)
  }

  private fun fileHeaderPathLayout(
    row: DiffRow,
    top: Int,
    bottom: Int,
    iconRect: RectF,
    countsX: Float
  ): FileHeaderPathLayout {
    drawing.configureUiPaint(
      paint = boldTextPaint,
      color = theme.text,
      size = style.fileHeaderFontSizePx,
      weight = style.fileHeaderFontWeight,
    )
    val pathX = iconRect.right + 10f * density
    val pathWidth = max(24f * density, countsX - pathX - 12f * density)
    val centerY = (top + bottom) / 2f
    val displayPath = if (
      !row.previousPath.isNullOrEmpty() && row.previousPath != row.filePath
    ) {
      "${row.previousPath} -> ${row.filePath}"
    } else {
      row.filePath
    }
    return FileHeaderPathLayout(
      displayPath = displayPath,
      rect = RectF(pathX, centerY - 10f * density, pathX + pathWidth, centerY + 10f * density),
    )
  }

  private fun maxHeaderPathOffset(fileId: String): Int {
    val row = rows.firstOrNull { it.kind == "file" && it.resolvedFileId == fileId } ?: return 0
    val top = 0
    val bottom = rowHeight(row)
    val iconRect = drawing.fileHeaderIconRect(top, bottom, style)
    val checkboxRect = drawing.fileHeaderCheckboxRect(top, bottom, width, style)
    drawing.configureUiPaint(
      paint = boldTextPaint,
      color = theme.deleteText,
      size = style.fileHeaderMetaFontSizePx,
      weight = style.fileHeaderMetaFontWeight,
    )
    val countsX = checkboxRect.left - 10f * density -
      boldTextPaint.measureText("-${row.deletions}") - 4f * density -
      boldTextPaint.measureText("+${row.additions}")
    return maxHeaderPathOffset(fileHeaderPathLayout(row, top, bottom, iconRect, countsX))
  }

  private fun maxHeaderPathOffset(layout: FileHeaderPathLayout): Int = max(
    0,
    ceil(boldTextPaint.measureText(layout.displayPath) - layout.rect.width()).toInt(),
  )

  private fun setHeaderPathOffset(fileId: String, value: Int) {
    val nextOffset = value.coerceIn(0, maxHeaderPathOffset(fileId))
    if ((headerPathOffsetsByFileId[fileId] ?: 0) == nextOffset) return
    headerPathOffsetsByFileId[fileId] = nextOffset
    invalidate()
  }

  private fun clampHeaderPathOffsets() {
    headerPathOffsetsByFileId.keys.toList().forEach { fileId ->
      val nextOffset = (headerPathOffsetsByFileId[fileId] ?: 0)
        .coerceIn(0, maxHeaderPathOffset(fileId))
      if (nextOffset == 0) {
        headerPathOffsetsByFileId.remove(fileId)
      } else {
        headerPathOffsetsByFileId[fileId] = nextOffset
      }
    }
  }

  private fun drawHunkRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    fill(canvas, theme.hunkBackground, 0f, top.toFloat(), width.toFloat(), bottom.toFloat())
    drawing.configureMonospacePaint(
      color = theme.hunkText,
      size = style.hunkFontSizePx,
      weight = style.hunkFontWeight,
    )
    drawScrollableCode(canvas, top, bottom) { codeX ->
      canvas.drawText(
        row.text.ifEmpty { row.content },
        codeX,
        centeredBaseline(top, bottom, textPaint),
        textPaint,
      )
    }
  }

  private fun drawNoticeRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    fill(canvas, theme.background, 0f, top.toFloat(), width.toFloat(), bottom.toFloat())
    val iconSize = 16f * density
    val iconRect = RectF(
      style.fileHeaderHorizontalPaddingPx + 2f * density,
      (top + bottom - iconSize) / 2f,
      style.fileHeaderHorizontalPaddingPx + 2f * density + iconSize,
      (top + bottom + iconSize) / 2f,
    )
    drawing.drawNoticeIcon(canvas, iconRect, theme.mutedText)
    drawing.configureUiPaint(
      paint = textPaint,
      color = theme.mutedText,
      size = style.fileHeaderSubtextFontSizePx,
      weight = style.fileHeaderSubtextFontWeight,
    )
    val textX = iconRect.right + 10f * density
    canvas.drawText(
      ellipsize(row.text, textPaint, width - textX - style.fileHeaderHorizontalPaddingPx),
      textX,
      centeredBaseline(top, bottom, textPaint),
      textPaint,
    )
    drawBottomBorder(canvas, bottom)
  }

  private fun drawCommentRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    fill(canvas, theme.background, 0f, top.toFloat(), width.toFloat(), bottom.toFloat())
    val cardRect = RectF(
      8f * density,
      top + 5f * density,
      width - 8f * density,
      bottom - 5f * density,
    )
    backgroundPaint.color = theme.headerBackground
    canvas.drawRoundRect(cardRect, 10f * density, 10f * density, backgroundPaint)
    borderPaint.style = Paint.Style.STROKE
    borderPaint.color = withAlpha(theme.border, 217)
    borderPaint.strokeWidth = density
    canvas.drawRoundRect(cardRect, 10f * density, 10f * density, borderPaint)
    borderPaint.style = Paint.Style.FILL

    val collapsed = collapsedCommentIds.contains(row.id)
    val chevronRect = RectF(
      cardRect.left + 10f * density,
      cardRect.top + 11f * density,
      cardRect.left + 26f * density,
      cardRect.top + 27f * density,
    )
    drawing.drawDisclosureChevron(canvas, chevronRect, theme.mutedText, collapsed)
    drawing.configureUiPaint(
      paint = textPaint,
      color = theme.mutedText,
      size = style.fileHeaderSubtextFontSizePx,
      weight = style.fileHeaderSubtextFontWeight,
    )
    val title = "Comment on ${row.commentRangeLabel.ifEmpty { "line" }}"
    canvas.drawText(
      ellipsize(title, textPaint, cardRect.right - chevronRect.right - 20f * density),
      chevronRect.right + 10f * density,
      cardRect.top + 22f * density,
      textPaint,
    )
    if (!collapsed) {
      textPaint.color = theme.text
      val bodyX = cardRect.left + 18f * density
      canvas.drawText(
        ellipsize(
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

  @Suppress("CyclomaticComplexMethod")
  private fun drawLineRow(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    val background = when (row.change) {
      "add" -> theme.addBackground
      "delete" -> theme.deleteBackground
      else -> theme.background
    }
    fill(canvas, background, 0f, top.toFloat(), width.toFloat(), bottom.toFloat())
    if (style.changeBarWidthPx > 0) {
      when (row.change) {
        "add" -> fill(
          canvas,
          theme.addBar,
          0f,
          top.toFloat(),
          style.changeBarWidthPx,
          bottom.toFloat()
        )
        "delete" -> drawing.drawDeleteStripes(
          canvas,
          top,
          bottom,
          style.changeBarWidthPx,
          theme.deleteBar,
        )
      }
    }
    val selected = selectedRowIds.contains(row.id)
    if (selected) {
      fill(
        canvas,
        withAlpha(theme.hunkText, 56),
        0f,
        top.toFloat(),
        width.toFloat(),
        bottom.toFloat(),
      )
      fill(
        canvas,
        withAlpha(theme.hunkText, 242),
        0f,
        top.toFloat(),
        style.changeBarWidthPx,
        bottom.toFloat()
      )
    }

    val tokens = tokensByRowId[row.id]
    drawScrollableCode(canvas, top, bottom) { codeX ->
      drawing.configureCodePaint(theme.text, 0, style)
      drawing.drawWordDiffRanges(canvas, row, codeX, top, bottom)
      if (tokens.isNullOrEmpty()) {
        canvas.drawText(row.content, codeX, centeredBaseline(top, bottom, textPaint), textPaint)
      } else {
        var x = codeX
        tokens.forEach { token ->
          drawing.configureCodePaint(token.color ?: theme.text, token.fontStyle, style)
          canvas.drawText(token.content, x, centeredBaseline(top, bottom, textPaint), textPaint)
          x += textPaint.measureText(token.content)
        }
      }
    }

    drawLineNumber(canvas, row, top, bottom)
  }

  private fun drawLineNumber(canvas: Canvas, row: DiffRow, top: Int, bottom: Int) {
    val lineNumber = row.newLineNumber ?: row.oldLineNumber ?: return
    drawing.configureMonospacePaint(
      color = drawing.lineNumberColor(row.change),
      size = style.lineNumberFontSizePx,
      weight = style.lineNumberFontWeight,
    )
    textPaint.textAlign = Paint.Align.RIGHT
    canvas.drawText(
      lineNumber.toString(),
      style.changeBarWidthPx + style.gutterWidthPx - style.codePaddingPx,
      centeredBaseline(top, bottom, textPaint),
      textPaint,
    )
    textPaint.textAlign = Paint.Align.LEFT
  }

  private fun drawScrollableCode(
    canvas: Canvas,
    top: Int,
    bottom: Int,
    draw: (Float) -> Unit
  ) {
    val gutterEnd = style.changeBarWidthPx + style.gutterWidthPx
    canvas.save()
    canvas.clipRect(gutterEnd, top.toFloat(), width.toFloat(), bottom.toFloat())
    draw(gutterEnd + style.codePaddingPx - horizontalOffset)
    canvas.restore()
  }

  private fun drawStickyFileHeader(canvas: Canvas, firstVisibleIndex: Int) {
    val sticky = stickyFileHeader(firstVisibleIndex) ?: return
    val naturalTop = rowOffsets[sticky.index] - verticalOffset
    if (naturalTop == sticky.top) return
    drawFileRow(canvas, rows[sticky.index], sticky.top, sticky.bottom)
  }

  @Suppress("ReturnCount")
  private fun stickyFileHeader(firstVisibleIndex: Int): StickyFileHeader? {
    if (rows.isEmpty()) return null
    val fileIndex = (firstVisibleIndex.coerceIn(0, rows.lastIndex) downTo 0)
      .firstOrNull { rows[it].kind == "file" }
      ?: return null
    val headerHeight = rowHeight(rows[fileIndex])
    val nextFileIndex = ((fileIndex + 1)..rows.lastIndex).firstOrNull { rows[it].kind == "file" }
    val top = nextFileIndex
      ?.let { min(0, rowOffsets[it] - verticalOffset - headerHeight) }
      ?: 0
    return StickyFileHeader(fileIndex, top, top + headerHeight)
  }

  private fun drawHorizontalScrollIndicator(canvas: Canvas) {
    val maxOffset = maxHorizontalOffset()
    if (maxOffset <= 0 || width <= 0) return
    val trackWidth = width.toFloat()
    val thumbWidth = max(24f * density, trackWidth * trackWidth / contentWidthPx)
    val thumbTravel = trackWidth - thumbWidth
    val left = thumbTravel * horizontalOffset / maxOffset
    fill(
      canvas,
      withAlpha(theme.mutedText, 110),
      left,
      height - 2f * density,
      left + thumbWidth,
      height.toFloat(),
    )
  }

  @Suppress("LongParameterList")
  private fun fill(
    canvas: Canvas,
    color: Int,
    left: Float,
    top: Float,
    right: Float,
    bottom: Float
  ) {
    backgroundPaint.color = color
    canvas.drawRect(left, top, right, bottom, backgroundPaint)
  }

  private fun drawBottomBorder(canvas: Canvas, bottom: Int) {
    borderPaint.color = theme.border
    borderPaint.strokeWidth = density
    canvas.drawLine(0f, bottom - density / 2f, width.toFloat(), bottom - density / 2f, borderPaint)
  }

  private fun centeredBaseline(top: Int, bottom: Int, paint: Paint): Float {
    val metrics = paint.fontMetrics
    return (top + bottom) / 2f - (metrics.ascent + metrics.descent) / 2f
  }

  private fun ellipsize(value: String, paint: Paint, width: Float): String {
    if (paint.measureText(value) <= width) return value
    val suffix = "..."
    val available = max(0f, width - paint.measureText(suffix))
    var end = value.length
    while (end > 0 && paint.measureText(value, 0, end) > available) end -= 1
    return value.substring(0, end) + suffix
  }

  private data class StickyFileHeader(
    val index: Int,
    val top: Int,
    val bottom: Int
  )

  private data class RowHit(
    val row: DiffRow,
    val top: Int,
    val bottom: Int
  )

  private data class FileHeaderPathLayout(
    val displayPath: String,
    val rect: RectF
  )
}

private fun withAlpha(color: Int, alpha: Int): Int =
  Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))

private fun parseRows(value: String): List<DiffRow> = try {
  val array = JSONArray(value)
  List(array.length()) { index ->
    val row = array.getJSONObject(index)
    DiffRow(
      kind = row.optString("kind"),
      id = row.optString("id"),
      fileId = row.optString("fileId"),
      filePath = row.optString("filePath"),
      previousPath = row.optNullableString("previousPath"),
      changeType = row.optString("changeType"),
      additions = row.optInt("additions"),
      deletions = row.optInt("deletions"),
      text = row.optString("text"),
      content = row.optString("content"),
      change = row.optString("change", "context"),
      oldLineNumber = row.optNullableInt("oldLineNumber"),
      newLineNumber = row.optNullableInt("newLineNumber"),
      wordDiffRanges = row.optJSONArray("wordDiffRanges")?.let(::parseWordDiffRanges).orEmpty(),
      commentText = row.optString("commentText"),
      commentRangeLabel = row.optString("commentRangeLabel"),
      commentSectionTitle = row.optString("commentSectionTitle"),
    )
  }
} catch (_: Exception) {
  emptyList()
}

private fun parseWordDiffRanges(value: JSONArray): List<DiffWordDiffRange> = buildList {
  for (index in 0 until value.length()) {
    val range = value.optJSONObject(index) ?: continue
    val start = range.optInt("start", -1)
    val end = range.optInt("end", -1)
    if (start >= 0 && end > start) {
      add(DiffWordDiffRange(start = start, end = end))
    }
  }
}

private fun parseTokensObject(value: String): Map<String, List<DiffToken>> = try {
  parseTokensObject(JSONObject(value))
} catch (_: Exception) {
  emptyMap()
}

private fun parseTokensObject(value: JSONObject): Map<String, List<DiffToken>> {
  val result = LinkedHashMap<String, List<DiffToken>>()
  val keys = value.keys()
  while (keys.hasNext()) {
    val rowId = keys.next()
    val array = value.optJSONArray(rowId) ?: continue
    result[rowId] = List(array.length()) { index ->
      val token = array.getJSONObject(index)
      DiffToken(
        content = token.optString("content"),
        color = token.optNullableString("color")?.let(::parseColorOrNull),
        fontStyle = token.optInt("fontStyle"),
      )
    }
  }
  return result
}

private fun parseStringSet(value: String): Set<String> = try {
  val array = JSONArray(value)
  buildSet {
    for (index in 0 until array.length()) add(array.getString(index))
  }
} catch (_: Exception) {
  emptySet()
}

private fun parseColor(value: String, fallback: Int): Int = try {
  Color.parseColor(value)
} catch (_: Exception) {
  fallback
}

private fun parseColorOrNull(value: String): Int? = try {
  Color.parseColor(value)
} catch (_: Exception) {
  null
}

private fun JSONObject.optNullableString(key: String): String? =
  if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

private fun JSONObject.optNullableInt(key: String): Int? =
  if (isNull(key) || !has(key)) null else optInt(key)

private fun JSONObject.floatDp(key: String, fallbackPx: Float, density: Float): Float =
  if (has(key)) optDouble(key).toFloat() * density else fallbackPx

private fun JSONObject.floatSp(key: String, fallbackPx: Float, density: Float): Float =
  if (has(key)) optDouble(key).toFloat() * density else fallbackPx
