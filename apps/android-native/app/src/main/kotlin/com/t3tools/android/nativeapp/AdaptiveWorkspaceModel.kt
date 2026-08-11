package com.t3tools.android.nativeapp

import kotlin.math.roundToInt

const val SPLIT_WORKSPACE_MIN_WIDTH = 720f
const val SPLIT_WORKSPACE_MIN_HEIGHT = 600f
const val SPLIT_SIDEBAR_MIN_WIDTH = 280f
const val SPLIT_SIDEBAR_MAX_WIDTH = 380f

data class AdaptiveWorkspaceLayout(
  val usesSplitView: Boolean,
  val sidebarWidth: Float?,
)

fun deriveAdaptiveWorkspaceLayout(width: Float, height: Float): AdaptiveWorkspaceLayout {
  if (width < SPLIT_WORKSPACE_MIN_WIDTH || height < SPLIT_WORKSPACE_MIN_HEIGHT) {
    return AdaptiveWorkspaceLayout(usesSplitView = false, sidebarWidth = null)
  }
  return AdaptiveWorkspaceLayout(
    usesSplitView = true,
    sidebarWidth = (width * 0.32f).roundToInt().toFloat()
      .coerceIn(SPLIT_SIDEBAR_MIN_WIDTH, SPLIT_SIDEBAR_MAX_WIDTH),
  )
}
