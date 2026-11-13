package expo.modules.t3terminal

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.widget.TextView

internal class TerminalEnterListener(
  private val isReadOnly: () -> Boolean,
  private val sendEnter: () -> Unit
) : TextView.OnEditorActionListener {
  override fun onEditorAction(view: TextView?, actionId: Int, event: KeyEvent?): Boolean {
    if (isReadOnly()) return true
    val isKeyUp = event?.action == KeyEvent.ACTION_UP
    val isImeSend = actionId == EditorInfo.IME_ACTION_SEND && !isKeyUp
    val isHardwareEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER ||
      event?.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    if (isImeSend || (isHardwareEnter && !isKeyUp)) sendEnter()
    // An unconsumed Enter key-up makes a single-line TextView move focus to
    // the next view, so the terminal stops receiving keys.
    return isImeSend || isHardwareEnter
  }
}
