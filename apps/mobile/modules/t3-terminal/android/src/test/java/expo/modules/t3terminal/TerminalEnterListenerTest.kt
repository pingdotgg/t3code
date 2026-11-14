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
class TerminalEnterListenerTest {
  @Test
  fun hardwareEnterKeepsFocusOnTheTerminalInput() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    var sent = 0
    val input = EditText(activity).apply {
      setSingleLine(true)
      isFocusableInTouchMode = true
      setOnEditorActionListener(TerminalEnterListener({ false }) { sent += 1 })
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

    for (keyCode in listOf(KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)) {
      input.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
      input.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
      assertTrue("focus left the input after key $keyCode", input.isFocused)
    }
    assertEquals(2, sent)
  }
}
