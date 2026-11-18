package expo.modules.t3nativecontrols

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.ScrollView
import androidx.core.widget.NestedScrollView
import com.facebook.react.views.scroll.ReactScrollViewHelper
import com.facebook.react.views.scroll.ScrollEventType
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max

class T3ScrollPullModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3ScrollPull")

    View(T3ScrollPullView::class) {
      Events("onPull", "onPullEnd")
    }
  }
}

/**
 * Reports how far a drag of the first descendant scroll view pulls past its end, in dp, and the
 * finger's speed in dp/ms when it lifts. Android shows that pull as a stretch and reports no
 * scroll offset for it. Touches pass through unchanged.
 */
class T3ScrollPullView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onPull by EventDispatcher()
  private val onPullEnd by EventDispatcher()
  private var scrollView: ViewGroup? = null
  private var dragging = false
  private var lastY: Int? = null
  private var pull = 0
  private var pulling = false
  private var multiTouch = false
  private var velocityTracker: VelocityTracker? = null
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private var staticDownY: Int? = null

  private val scrollListener = object : ReactScrollViewHelper.ScrollListener {
    override fun onScroll(
      scrollView: ViewGroup?,
      scrollEventType: ScrollEventType?,
      xVelocity: Float,
      yVelocity: Float
    ) {
      if (scrollView == null || scrollView !== this@T3ScrollPullView.scrollView) return
      if (scrollEventType == ScrollEventType.BEGIN_DRAG) {
        dragging = true
        lastY = null
      } else if (scrollEventType == ScrollEventType.END_DRAG) {
        dragging = false
      }
    }

    override fun onLayout(scrollView: ViewGroup?) = Unit
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ReactScrollViewHelper.addScrollListener(scrollListener)
  }

  override fun onDetachedFromWindow() {
    ReactScrollViewHelper.removeScrollListener(scrollListener)
    velocityTracker?.recycle()
    velocityTracker = null
    end(released = false)
    dragging = false
    scrollView = null
    super.onDetachedFromWindow()
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      velocityTracker = (velocityTracker ?: VelocityTracker.obtain()).apply { clear() }
      scrollView = findScrollView(this)
      // A feed shorter than its viewport never starts a ScrollView drag, so an unclaimed upward
      // drag past the touch slop pulls instead.
      staticDownY = scrollView
        ?.takeUnless { it.canScrollVertically(1) || it.canScrollVertically(-1) }
        ?.let { event.y.toInt() }
    }
    velocityTracker?.addMovement(event)
    val target = scrollView
    val scrollYBefore = target?.scrollY ?: 0
    val handled = super.dispatchTouchEvent(event)
    if (target != null) track(target, event, scrollYBefore)
    return handled
  }

  override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
    if (disallowIntercept && staticDownY != null) {
      staticDownY = null
      dragging = false
      end(released = false)
    }
    super.requestDisallowInterceptTouchEvent(disallowIntercept)
  }

  private fun track(target: ViewGroup, event: MotionEvent, scrollYBefore: Int) {
    val downY = staticDownY
    if (downY != null && !dragging && downY - event.y.toInt() > touchSlop) {
      dragging = true
      lastY = event.y.toInt()
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> if (dragging && !multiTouch) {
        val y = event.y.toInt()
        val previous = lastY ?: y
        lastY = y
        // A stretch at the end takes the travel ScrollView could not scroll, and gives it back
        // before scrolling again, so the unscrolled travel is the pull.
        val unscrolled = previous - y - (target.scrollY - scrollYBefore)
        update(if (target.canScrollVertically(1)) 0 else max(0, pull + unscrolled))
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        end(released = false)
        multiTouch = true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val atEnd = !target.canScrollVertically(1)
        end(released = event.actionMasked == MotionEvent.ACTION_UP && atEnd)
        dragging = false
        multiTouch = false
        staticDownY = null
      }
    }
  }

  private fun update(next: Int) {
    if (next == pull) return
    pull = next
    pulling = true
    onPull(mapOf("distance" to next / resources.displayMetrics.density))
  }

  private fun end(released: Boolean) {
    if (pulling) onPullEnd(mapOf("released" to released, "velocity" to fingerVelocity()))
    pulling = false
    pull = 0
    lastY = null
  }

  private fun fingerVelocity(): Float {
    val tracker = velocityTracker ?: return 0f
    tracker.computeCurrentVelocity(1)
    return tracker.yVelocity / resources.displayMetrics.density
  }

  private fun findScrollView(view: View): ViewGroup? = when (view) {
    is ScrollView, is NestedScrollView -> view as ViewGroup
    is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull {
      findScrollView(view.getChildAt(it))
    }
    else -> null
  }
}
