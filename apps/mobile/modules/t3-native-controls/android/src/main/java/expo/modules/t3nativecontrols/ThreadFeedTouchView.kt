package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import com.facebook.react.uimanager.PointerEvents
import com.facebook.react.uimanager.ReactPointerEventsView
import com.facebook.react.uimanager.events.NativeGestureUtil
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

class ThreadFeedTouchView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private enum class Axis { PENDING, HORIZONTAL, VERTICAL }

  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val gutter = (24 * resources.displayMetrics.density).roundToInt()
  private val bounds = Rect()
  private val screenLocation = IntArray(2)
  private val targetLocation = IntArray(2)
  private val pointerProperties = arrayOf(MotionEvent.PointerProperties())
  private val pointerCoords = arrayOf(MotionEvent.PointerCoords())
  private var feed: ReactScrollView? = null
  private var gutterTarget: HorizontalScrollView? = null
  private var gutterTargetLost = false
  private var gutterDistance = Int.MAX_VALUE
  private var pointerId = 0
  private var downX = 0f
  private var downY = 0f
  private var axis = Axis.PENDING
  private var pointerChanged = false
  private var lockingFeed = false

  // A descendant, such as a text selection drag, asked its parents not to intercept.
  private var childLocked = false

  override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
    val activeFeed = feed
    if (activeFeed != null && !lockingFeed) childLocked = disallowIntercept
    if (!disallowIntercept && activeFeed != null && axis != Axis.VERTICAL) {
      // A link may release the table's interceptor while the feed still needs to stay locked.
      lockFeed(activeFeed)
    } else {
      super.requestDisallowInterceptTouchEvent(disallowIntercept)
    }
  }

  private fun lockFeed(activeFeed: ReactScrollView) {
    lockingFeed = true
    try {
      activeFeed.requestDisallowInterceptTouchEvent(true)
    } finally {
      lockingFeed = false
    }
  }

  /** Hands the gesture to the feed unless a descendant still holds its own lock. */
  private fun releaseFeed(activeFeed: ReactScrollView, event: MotionEvent) {
    axis = Axis.VERTICAL
    if (childLocked) return
    activeFeed.requestDisallowInterceptTouchEvent(false)
    if (pointerChanged && !event.endsGesture()) {
      // The feed skipped intercept callbacks while the gesture was undecided.
      withDownEvent(event, activeFeed) { activeFeed.onInterceptTouchEvent(it) }
    }
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean =
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      handleDown(event)
    } else {
      feed?.let { dispatchGesture(it, event) } ?: super.dispatchTouchEvent(event)
    }

  private fun dispatchGesture(activeFeed: ReactScrollView, event: MotionEvent): Boolean {
    val target = gutterTarget
    if (target != null && !isGutterTargetAvailable(target)) {
      gutterTarget = null
      if (axis == Axis.HORIZONTAL) {
        gutterTargetLost = true
        if (target.isAttachedToWindow) {
          withCancelEvent(event) { dispatchToGutterTarget(target, it) }
        }
      } else {
        releaseFeed(activeFeed, event)
        clearGesture()
        return super.dispatchTouchEvent(event)
      }
    }

    val currentAxis = axis
    val targetLost = gutterTargetLost
    if (event.endsGesture()) finishGesture(event)
    return when {
      currentAxis == Axis.PENDING -> dispatchPending(activeFeed, target, event)
      currentAxis == Axis.HORIZONTAL && targetLost -> true
      currentAxis == Axis.HORIZONTAL && target != null -> dispatchToGutterTarget(target, event)
      else -> super.dispatchTouchEvent(event)
    }
  }

  override fun onDetachedFromWindow() {
    if (axis == Axis.HORIZONTAL) {
      val now = SystemClock.uptimeMillis()
      val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
      try {
        finishGesture(cancel)
      } finally {
        cancel.recycle()
      }
    } else {
      clearGesture()
    }
    super.onDetachedFromWindow()
  }

  private fun MotionEvent.endsGesture() =
    actionMasked == MotionEvent.ACTION_UP || actionMasked == MotionEvent.ACTION_CANCEL

  private fun clearGesture() {
    feed = null
    gutterTarget = null
    gutterTargetLost = false
    gutterDistance = Int.MAX_VALUE
    axis = Axis.PENDING
    pointerChanged = false
    childLocked = false
  }

  private fun finishGesture(event: MotionEvent) {
    if (axis == Axis.HORIZONTAL) NativeGestureUtil.notifyNativeGestureEnded(this, event)
    clearGesture()
  }

  private fun handleDown(event: MotionEvent): Boolean {
    finishGesture(event)
    rootView.getLocationOnScreen(screenLocation)
    val x = (event.rawX - screenLocation[0]).toInt()
    val y = (event.rawY - screenLocation[1]).toInt()
    findScroller(this, null, x, y, true)
    val activeFeed = feed ?: return super.dispatchTouchEvent(event)

    // A flinging ScrollView can intercept DOWN before the table receives it.
    activeFeed.abortAnimation()
    val handled = super.dispatchTouchEvent(event)
    if (handled) {
      updatePointer(event, 0)
      lockFeed(activeFeed)
    } else {
      clearGesture()
    }
    return handled
  }

  private fun updatePointer(event: MotionEvent, index: Int) {
    pointerId = event.getPointerId(index)
    downX = event.getX(index)
    downY = event.getY(index)
  }

  private fun dispatchPending(
    activeFeed: ReactScrollView,
    target: HorizontalScrollView?,
    event: MotionEvent
  ): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_POINTER_UP -> {
        if (event.getPointerId(event.actionIndex) == pointerId) {
          updatePointer(event, if (event.actionIndex == 0) 1 else 0)
          pointerChanged = true
        }
      }
      MotionEvent.ACTION_MOVE -> return resolveMove(activeFeed, target, event)
    }
    return super.dispatchTouchEvent(event)
  }

  private fun resolveMove(
    activeFeed: ReactScrollView,
    target: HorizontalScrollView?,
    event: MotionEvent
  ): Boolean {
    val index = event.findPointerIndex(pointerId)
    if (index < 0) return super.dispatchTouchEvent(event)
    val dx = event.getX(index) - downX
    val dy = event.getY(index) - downY
    val direction = if (dx > 0) -1 else 1
    val canScroll = target?.canScrollHorizontally(direction) != false
    return when {
      max(abs(dx), abs(dy)) <= touchSlop -> target != null || super.dispatchTouchEvent(event)
      abs(dy) >= abs(dx) || !canScroll || childLocked -> {
        releaseFeed(activeFeed, event)
        super.dispatchTouchEvent(event)
      }
      else -> startHorizontal(target, event)
    }
  }

  private fun startHorizontal(target: HorizontalScrollView?, event: MotionEvent): Boolean {
    axis = Axis.HORIZONTAL
    NativeGestureUtil.notifyNativeGestureStarted(this, event)
    if (target == null) return super.dispatchTouchEvent(event)

    withCancelEvent(event) { super.dispatchTouchEvent(it) }
    withDownEvent(event, target) { target.onTouchEvent(it) }
    return dispatchToGutterTarget(target, event)
  }

  private inline fun withCancelEvent(event: MotionEvent, dispatch: (MotionEvent) -> Unit) {
    val cancel = MotionEvent.obtain(event)
    try {
      cancel.action = MotionEvent.ACTION_CANCEL
      dispatch(cancel)
    } finally {
      cancel.recycle()
    }
  }

  private inline fun withDownEvent(
    event: MotionEvent,
    target: View,
    dispatch: (MotionEvent) -> Unit
  ) {
    val index = event.findPointerIndex(pointerId)
    event.getPointerProperties(index, pointerProperties[0])
    event.getPointerCoords(index, pointerCoords[0])
    pointerCoords[0].x = downX
    pointerCoords[0].y = downY
    val down = MotionEvent.obtain(
      event.downTime,
      event.eventTime,
      MotionEvent.ACTION_DOWN,
      1,
      pointerProperties,
      pointerCoords,
      event.metaState,
      event.buttonState,
      event.xPrecision,
      event.yPrecision,
      event.deviceId,
      event.edgeFlags,
      event.source,
      event.flags,
    )
    try {
      offsetToTarget(down, target)
      dispatch(down)
    } finally {
      down.recycle()
    }
  }

  private fun dispatchToGutterTarget(target: HorizontalScrollView, event: MotionEvent): Boolean {
    val copy = MotionEvent.obtain(event)
    try {
      offsetToTarget(copy, target)
      return target.onTouchEvent(copy)
    } finally {
      copy.recycle()
    }
  }

  private fun offsetToTarget(event: MotionEvent, target: View) {
    getLocationOnScreen(screenLocation)
    target.getLocationOnScreen(targetLocation)
    event.offsetLocation(
      (screenLocation[0] - targetLocation[0]).toFloat(),
      (screenLocation[1] - targetLocation[1]).toFloat(),
    )
  }

  private fun isTouchableAtY(view: View, y: Int): Boolean {
    val pointerEvents = (view as? ReactPointerEventsView)?.pointerEvents ?: PointerEvents.AUTO
    return view.visibility == View.VISIBLE && view.alpha > 0 &&
      PointerEvents.canChildrenBeTouchTarget(pointerEvents) &&
      view.getGlobalVisibleRect(bounds) && y >= bounds.top && y < bounds.bottom
  }

  private fun isGutterTargetAvailable(target: HorizontalScrollView): Boolean {
    if (!target.isAttachedToWindow || !target.isShown) return false
    var view: View? = target
    while (view != null && view !== this && view.alpha > 0) {
      view = view.parent as? View
    }
    return view === this && alpha > 0
  }

  private fun findScroller(
    view: ViewGroup,
    parentFeed: ReactScrollView?,
    x: Int,
    y: Int,
    direct: Boolean
  ): Boolean {
    if (!isTouchableAtY(view, y)) return false
    val directHit = direct && x in bounds.left until bounds.right
    val activeFeed = if (parentFeed == null) view as? ReactScrollView else parentFeed
    return when {
      parentFeed == null && !directHit -> false
      view is ReactScrollView && parentFeed != null -> false
      view is ReactHorizontalScrollView -> false
      view is HorizontalScrollView ->
        activeFeed != null &&
          considerScroller(activeFeed, view, x, directHit)
      else -> findChildScroller(view, activeFeed, x, y, directHit)
    }
  }

  private fun findChildScroller(
    view: ViewGroup,
    activeFeed: ReactScrollView?,
    x: Int,
    y: Int,
    direct: Boolean
  ): Boolean {
    for (index in view.childCount - 1 downTo 0) {
      val child = view.getChildAt(index)
      if (child is ViewGroup && findScroller(child, activeFeed, x, y, direct)) return true
    }
    return false
  }

  private fun considerScroller(
    activeFeed: ReactScrollView,
    target: HorizontalScrollView,
    x: Int,
    directHit: Boolean
  ): Boolean {
    if (!target.canScrollHorizontally(-1) && !target.canScrollHorizontally(1)) return false
    val distance = horizontalEdgeDistance(x, bounds.left, bounds.right)
    if (directHit || (distance in 0..gutter && distance < gutterDistance)) {
      feed = activeFeed
      gutterTarget = if (directHit) null else target
      gutterDistance = distance
    }
    return directHit
  }
}

private fun horizontalEdgeDistance(x: Int, left: Int, right: Int): Int = maxOf(
  left - x,
  x - right + 1,
  0
)
