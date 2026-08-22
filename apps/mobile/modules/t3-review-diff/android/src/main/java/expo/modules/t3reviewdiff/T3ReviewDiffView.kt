package expo.modules.t3reviewdiff

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3ReviewDiffView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val surface = ReviewDiffSurfaceView(context)
  private val onDebug by EventDispatcher()
  private val onVisibleFileChange by EventDispatcher()
  private val onToggleFile by EventDispatcher()
  private val onToggleViewedFile by EventDispatcher()
  private val onPressLine by EventDispatcher()
  private val onToggleComment by EventDispatcher()

  init {
    surface.onDebug = onDebug::invoke
    surface.onVisibleFileChange = onVisibleFileChange::invoke
    surface.onToggleFile = onToggleFile::invoke
    surface.onToggleViewedFile = onToggleViewedFile::invoke
    surface.onPressLine = onPressLine::invoke
    surface.onToggleComment = onToggleComment::invoke
    addView(
      surface,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  fun setTokensResetKey(value: String) = surface.setTokensResetKey(value)
  fun setContentResetKey(value: String) = surface.setContentResetKey(value)
  fun setCollapsedFileIdsJson(value: String) = surface.setCollapsedFileIdsJson(value)
  fun setViewedFileIdsJson(value: String) = surface.setViewedFileIdsJson(value)
  fun setSelectedRowIdsJson(value: String) = surface.setSelectedRowIdsJson(value)
  fun setCollapsedCommentIdsJson(value: String) = surface.setCollapsedCommentIdsJson(value)
  fun setAppearanceScheme(value: String) = surface.setAppearanceScheme(value)
  fun setThemeJson(value: String) = surface.setThemeJson(value)
  fun setStyleJson(value: String) = surface.setStyleJson(value)
  fun setRowHeight(value: Float) = surface.setRowHeight(value)
  fun setContentWidth(value: Float) = surface.setContentWidth(value)
  fun setInitialRowIndex(value: Double) = surface.setInitialRowIndex(value)
  fun setRowsJson(value: String) = surface.setRowsJson(value)
  fun setTokensJson(value: String) = surface.setTokensJson(value)
  fun setTokensPatchJson(value: String) = surface.setTokensPatchJson(value)
  fun scrollToFile(fileId: String, animated: Boolean) = surface.scrollToFile(fileId, animated)
  fun scrollToTop(animated: Boolean) = surface.scrollToTop(animated)
  fun cleanup() = surface.cleanup()
}
