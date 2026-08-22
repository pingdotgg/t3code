package com.t3tools.android.nativeapp

internal data class HomeListRevealSignal(
  val draftVisible: Boolean = false,
  val createdThreadRequest: Int = 0,
)

internal fun shouldRevealHomeListTop(
  previous: HomeListRevealSignal,
  current: HomeListRevealSignal,
): Boolean =
  (!previous.draftVisible && current.draftVisible) ||
    previous.createdThreadRequest != current.createdThreadRequest
