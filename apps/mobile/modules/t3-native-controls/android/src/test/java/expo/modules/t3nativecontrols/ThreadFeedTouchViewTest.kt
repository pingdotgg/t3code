package expo.modules.t3nativecontrols

import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadFeedTouchViewTest {
  @Test
  fun distanceUsesBothVisibleEdges() {
    val left = 100
    val right = 200
    assertEquals(0, horizontalEdgeDistance(left, left, right))
    assertEquals(0, horizontalEdgeDistance(right - 1, left, right))
    assertEquals(1, horizontalEdgeDistance(left - 1, left, right))
    assertEquals(1, horizontalEdgeDistance(right, left, right))
    assertEquals(40, horizontalEdgeDistance(left - 40, left, right))
    assertEquals(40, horizontalEdgeDistance(right + 39, left, right))
  }
}
