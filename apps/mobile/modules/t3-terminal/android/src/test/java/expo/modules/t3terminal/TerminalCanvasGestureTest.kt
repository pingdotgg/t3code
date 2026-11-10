package expo.modules.t3terminal

import android.app.Activity
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class TerminalCanvasGestureTest {
  @Test
  fun scrollingLeavesTheKeyboardClosedAndTappingOpensIt() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val canvas = TerminalCanvasView(activity)
    var keyboardRequests = 0
    var scrolledRows = 0
    canvas.onRequestKeyboard = { keyboardRequests += 1 }
    canvas.onScrollRows = { scrolledRows += it }

    fun touch(downTime: Long, eventTime: Long, action: Int, y: Float) {
      val event = MotionEvent.obtain(downTime, eventTime, action, 200f, y, 0)
      canvas.onTouchEvent(event)
      event.recycle()
    }

    touch(0, 0, MotionEvent.ACTION_DOWN, 900f)
    touch(0, 50, MotionEvent.ACTION_MOVE, 600f)
    touch(0, 100, MotionEvent.ACTION_MOVE, 300f)
    touch(0, 150, MotionEvent.ACTION_UP, 300f)
    assertTrue("the swipe did not scroll", scrolledRows > 0)
    assertEquals("a scroll requested the keyboard", 0, keyboardRequests)

    touch(1_000, 1_000, MotionEvent.ACTION_DOWN, 300f)
    touch(1_000, 1_050, MotionEvent.ACTION_UP, 300f)
    assertEquals(1, keyboardRequests)
  }
}
