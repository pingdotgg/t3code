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

  private fun touch(action: Int, x: Float, y: Float) {
    val pointer = MotionEvent.PointerProperties().apply {
      id = 0
      toolType = MotionEvent.TOOL_TYPE_FINGER
    }
    val coords = MotionEvent.PointerCoords().apply {
      this.x = x
      this.y = y
      pressure = 1f
      size = 1f
    }
    val event = MotionEvent.obtain(
      downTime,
      SystemClock.uptimeMillis(),
      action,
      1,
      arrayOf(pointer),
      arrayOf(coords),
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

  // A second finger lands while the first is still down, so the event carries both pointers.
  private fun secondFingerDown(firstX: Float, firstY: Float, x: Float, y: Float) {
    val pointers = Array(2) { id ->
      MotionEvent.PointerProperties().apply {
        this.id = id
        toolType = MotionEvent.TOOL_TYPE_FINGER
      }
    }
    val coords = arrayOf(
      MotionEvent.PointerCoords().apply { this.x = firstX; this.y = firstY; pressure = 1f; size = 1f },
      MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f },
    )
    val action = MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
    val event = MotionEvent.obtain(
      downTime,
      SystemClock.uptimeMillis(),
      action,
      2,
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

    touch(MotionEvent.ACTION_DOWN, 40f, 250f)
    touch(MotionEvent.ACTION_MOVE, 40f, 250f - slop * 3)
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

    touch(MotionEvent.ACTION_DOWN, 40f, 250f)
    touch(MotionEvent.ACTION_MOVE, 40f, movedY)
    secondFingerDown(40f, movedY, 120f, 250f)
    holdPastLongPressTimeout()

    assertEquals(bottom, editor.scrollY)
    assertEquals(editor.selectionStart, editor.selectionEnd)
  }

  @Test
  fun stillLongPressSelectsAWord() {
    scrolledToBottom()

    touch(MotionEvent.ACTION_DOWN, 40f, 250f)
    holdPastLongPressTimeout()

    assertNotEquals(editor.selectionStart, editor.selectionEnd)
  }
}
