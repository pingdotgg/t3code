package expo.modules.t3terminal

import android.app.Activity
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class TerminalNavigationKeyListenerTest {
  @Test
  fun hardwareNavigationKeysReachThePtyAndKeepFocus() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val sent = StringBuilder()
    val input = EditText(activity).apply {
      setSingleLine(true)
      isFocusableInTouchMode = true
      setOnKeyListener(TerminalNavigationKeyListener { sent.append(it) })
    }
    val nextControl = Button(activity).apply { isFocusableInTouchMode = true }
    val root = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      addView(input)
      addView(nextControl)
    }
    activity.setContentView(root)
    // Focus search below the input only finds controls that have bounds.
    root.measure(
      View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
    )
    root.layout(0, 0, 1080, 1920)
    assertTrue(input.requestFocus())

    val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    val keys = listOf(
      Triple(KeyEvent.KEYCODE_DPAD_UP, 0, "\u001b[A"),
      Triple(KeyEvent.KEYCODE_DPAD_DOWN, 0, "\u001b[B"),
      Triple(KeyEvent.KEYCODE_DPAD_RIGHT, 0, "\u001b[C"),
      Triple(KeyEvent.KEYCODE_DPAD_LEFT, 0, "\u001b[D"),
      Triple(KeyEvent.KEYCODE_TAB, 0, "\t"),
      Triple(KeyEvent.KEYCODE_TAB, shift, "\u001b[Z"),
      Triple(KeyEvent.KEYCODE_ESCAPE, 0, "\u001b"),
    )
    for ((keyCode, meta, expected) in keys) {
      sent.clear()
      input.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_DOWN, keyCode, 0, meta))
      input.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_UP, keyCode, 0, meta))
      assertEquals("bytes for key $keyCode meta $meta", expected, sent.toString())
      assertTrue("focus left the input after key $keyCode meta $meta", input.isFocused)
    }

    sent.clear()
    val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
    input.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP, 0, ctrl))
    assertEquals("modified arrows are left to the app, as on iOS", "", sent.toString())
  }
}
