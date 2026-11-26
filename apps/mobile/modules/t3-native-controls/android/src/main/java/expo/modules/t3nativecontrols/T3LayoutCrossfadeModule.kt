package expo.modules.t3nativecontrols

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.animation.PathInterpolator
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3LayoutCrossfadeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3LayoutCrossfade")

    View(T3LayoutCrossfadeView::class) {
      Events("onSnapshot")
      Prop("snapshotRequest") { view: T3LayoutCrossfadeView, request: Int ->
        view.requestSnapshot(request)
      }
      Prop("fadeRequest") { view: T3LayoutCrossfadeView, request: Int ->
        view.requestFade(request)
      }
      Prop("fadeDuration") { view: T3LayoutCrossfadeView, duration: Int ->
        view.fadeDuration = duration.toLong()
      }
      Prop("backdropColor") { view: T3LayoutCrossfadeView, color: Int ->
        view.backdropColor = color
      }
    }
  }
}

/**
 * Cross-dissolves its content from one layout to the next, like UIKit's column animations. A
 * snapshot request draws the children into a bitmap shown on top, then reports back so the new
 * layout can be committed together with a fade request, which fades the bitmap out.
 */
class T3LayoutCrossfadeView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onSnapshot by EventDispatcher()
  var fadeDuration = 260L
  /** What shows behind the content; the snapshot is opaque so no layout shows through it. */
  var backdropColor = 0
  private var snapshotRequest = 0
  private var fadeRequest = 0
  private var snapshot: Bitmap? = null
  private var snapshotAlpha = 1f
  private var capturing = false
  private var fade: ValueAnimator? = null
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  // A snapshot whose layout change never commits must not cover the content for good.
  private val abandon = Runnable { requestFade(fadeRequest + 1) }

  fun requestSnapshot(request: Int) {
    if (request == snapshotRequest) return
    snapshotRequest = request
    // The first value is the mount's, not a request.
    if (request == 0 || !isAttachedToWindow) return
    capture()
    onSnapshot(mapOf("request" to request))
  }

  fun requestFade(request: Int) {
    if (request == fadeRequest) return
    fadeRequest = request
    removeCallbacks(abandon)
    val bitmap = snapshot ?: return
    fade?.cancel()
    fade = ValueAnimator.ofFloat(snapshotAlpha, 0f).apply {
      duration = fadeDuration
      // CSS ease-in-out cubic, the curve of WORKSPACE_PANE_TIMING.
      interpolator = PathInterpolator(0.65f, 0f, 0.35f, 1f)
      addUpdateListener {
        snapshotAlpha = it.animatedValue as Float
        invalidate()
      }
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          if (fade !== animation) return
          fade = null
          if (snapshot === bitmap) clear()
        }
      })
      start()
    }
  }

  private fun capture() {
    fade?.cancel()
    fade = null
    clear()
    if (width <= 0 || height <= 0) return
    val bitmap = try {
      Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    } catch (_: OutOfMemoryError) {
      return
    }
    capturing = true
    try {
      val canvas = Canvas(bitmap)
      // Anything less than opaque would let the new layout show through the old one.
      canvas.drawColor(backdropColor or OPAQUE)
      draw(canvas)
    } finally {
      capturing = false
    }
    snapshot = bitmap
    snapshotAlpha = 1f
    invalidate()
    postDelayed(abandon, ABANDON_AFTER_MS)
  }

  private fun clear() {
    removeCallbacks(abandon)
    snapshot?.recycle()
    snapshot = null
    invalidate()
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (capturing) return
    val bitmap = snapshot ?: return
    paint.alpha = (snapshotAlpha * 255).toInt()
    canvas.drawBitmap(bitmap, 0f, 0f, paint)
  }

  override fun onDetachedFromWindow() {
    fade?.cancel()
    fade = null
    clear()
    super.onDetachedFromWindow()
  }

  private companion object {
    const val ABANDON_AFTER_MS = 1_000L
    const val OPAQUE = 0xFF000000.toInt()
  }
}
