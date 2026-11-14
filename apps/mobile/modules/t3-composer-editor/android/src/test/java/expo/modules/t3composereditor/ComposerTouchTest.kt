package expo.modules.t3composereditor

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.ViewGroup
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerTouchTest {
  private val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
  private val editor = SelectionAwareEditText(activity).apply {
    setText((1..40).joinToString("\n") { "Line $it alpha beta gamma" })
  }
  private val downTime = SystemClock.uptimeMillis()

  private fun scrolledToBottom() {
    activity.setContentView(editor, ViewGroup.LayoutParams(600, 300))
    shadowOf(Looper.getMainLooper()).idle()
    editor.requestFocus()
    editor.setSelection(editor.text.length)
    val padding = editor.totalPaddingTop + editor.totalPaddingBottom
    editor.scrollTo(0, editor.layout.height - (editor.height - padding))
    shadowOf(Looper.getMainLooper()).idle()
  }

  // Each pair is one finger's position, in pointer id order.
  private fun touch(action: Int, vararg fingers: Pair<Float, Float>) {
    val pointers = Array(fingers.size) { id ->
      MotionEvent.PointerProperties().apply {
        this.id = id
        toolType = MotionEvent.TOOL_TYPE_FINGER
      }
    }
    val coords = Array(fingers.size) { index ->
      MotionEvent.PointerCoords().apply {
        x = fingers[index].first
        y = fingers[index].second
        pressure = 1f
        size = 1f
      }
    }
    val event = MotionEvent.obtain(
      downTime,
      SystemClock.uptimeMillis(),
      action,
      fingers.size,
      pointers,
      coords,
      0,
      0,
      1f,
      1f,
      0,
      0,
      InputDevice.SOURCE_TOUCHSCREEN,
      0,
    )
    editor.dispatchTouchEvent(event)
    event.recycle()
  }

  private fun holdPastLongPressTimeout() {
    shadowOf(Looper.getMainLooper())
      .idleFor(Duration.ofMillis(ViewConfiguration.getLongPressTimeout() + 100L))
  }

  @Test
  fun dragAtTheScrollLimitDoesNotSelectAWord() {
    scrolledToBottom()
    val bottom = editor.scrollY
    assertNotEquals(0, bottom)
    val slop = ViewConfiguration.get(activity).scaledTouchSlop

    touch(MotionEvent.ACTION_DOWN, 40f to 250f)
    touch(MotionEvent.ACTION_MOVE, 40f to 250f - slop * 3)
    holdPastLongPressTimeout()

    assertEquals(bottom, editor.scrollY)
    assertEquals(editor.selectionStart, editor.selectionEnd)
  }

  @Test
  fun secondFingerDuringADragDoesNotSelectAWord() {
    scrolledToBottom()
    val bottom = editor.scrollY
    val slop = ViewConfiguration.get(activity).scaledTouchSlop
    val movedY = 250f - slop * 3

    touch(MotionEvent.ACTION_DOWN, 40f to 250f)
    touch(MotionEvent.ACTION_MOVE, 40f to movedY)
    touch(
      MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
      40f to movedY,
      120f to 250f,
    )
    holdPastLongPressTimeout()

    assertEquals(bottom, editor.scrollY)
    assertEquals(editor.selectionStart, editor.selectionEnd)
  }

  @Test
  fun stillLongPressSelectsAWord() {
    scrolledToBottom()

    touch(MotionEvent.ACTION_DOWN, 40f to 250f)
    holdPastLongPressTimeout()

    assertNotEquals(editor.selectionStart, editor.selectionEnd)
  }
}
