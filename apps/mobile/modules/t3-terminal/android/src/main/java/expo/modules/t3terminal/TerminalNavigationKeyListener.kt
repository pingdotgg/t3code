package expo.modules.t3terminal

import android.view.KeyEvent
import android.view.View

internal class TerminalNavigationKeyListener(
  private val send: (String) -> Unit
) : View.OnKeyListener {
  override fun onKey(view: View?, keyCode: Int, event: KeyEvent): Boolean {
    val sequence = sequenceFor(keyCode, event) ?: return false
    if (event.action == KeyEvent.ACTION_DOWN) send(sequence)
    // Unconsumed arrow and Tab key events move focus off the terminal input.
    return true
  }

  // Matches iOS: these keys only without modifiers, plus Shift+Tab.
  private fun sequenceFor(keyCode: Int, event: KeyEvent): String? = when {
    keyCode == KeyEvent.KEYCODE_TAB && event.hasModifiers(KeyEvent.META_SHIFT_ON) -> "\u001b[Z"
    !event.hasNoModifiers() -> null
    keyCode == KeyEvent.KEYCODE_DPAD_UP -> "\u001b[A"
    keyCode == KeyEvent.KEYCODE_DPAD_DOWN -> "\u001b[B"
    keyCode == KeyEvent.KEYCODE_DPAD_RIGHT -> "\u001b[C"
    keyCode == KeyEvent.KEYCODE_DPAD_LEFT -> "\u001b[D"
    keyCode == KeyEvent.KEYCODE_TAB -> "\t"
    keyCode == KeyEvent.KEYCODE_ESCAPE -> "\u001b"
    else -> null
  }
}
