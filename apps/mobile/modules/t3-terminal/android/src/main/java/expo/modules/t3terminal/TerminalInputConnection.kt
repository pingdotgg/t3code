package expo.modules.t3terminal

import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper

private const val MAX_DELETE_LENGTH = 1024

// Text the terminal already received from the hidden input. The input is empty
// by the time an IME deletes, so this is what its UTF-16 lengths refer to.
internal class TerminalSentText {
  private val text = StringBuilder()
  private var deletedHighSurrogate = false

  fun append(sent: CharSequence) {
    discardDeletedSurrogate()
    text.append(sent)
    if (text.length > MAX_DELETE_LENGTH) text.delete(0, text.length - MAX_DELETE_LENGTH)
  }

  fun removeUnits(units: Int): Int {
    val start = (text.length - units).coerceAtLeast(0)
    val removed = units - (text.length - start) + text.codePointCount(start, text.length) -
      if (deletedHighSurrogate && units > 0) 1 else 0
    // The low half already sent DEL; retain the high half only for IME unit accounting.
    deletedHighSurrogate = start > 0 && start < text.length &&
      Character.isHighSurrogate(text[start - 1]) && Character.isLowSurrogate(text[start])
    text.setLength(start)
    return removed
  }

  fun removeCodePoints(count: Int): Int {
    discardDeletedSurrogate()
    val known = count.coerceAtMost(text.codePointCount(0, text.length))
    text.setLength(text.offsetByCodePoints(text.length, -known))
    return count
  }

  private fun discardDeletedSurrogate() {
    if (deletedHighSurrogate) text.setLength(text.length - 1)
    deletedHighSurrogate = false
  }
}

// The hidden input clears after every change, so text an IME deletes was
// already sent to the terminal. Some keyboards delete through these calls
// instead of KEYCODE_DEL, so forward them as one DEL per code point.
internal class TerminalInputConnection(
  target: InputConnection,
  private val sentText: TerminalSentText,
  private val sendDeletes: (count: Int) -> Unit
) : InputConnectionWrapper(target, true) {
  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    if (beforeLength > 0) forwardDeletes(sentText.removeUnits(beforeLength))
    return super.deleteSurroundingText(beforeLength, afterLength)
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    if (beforeLength > 0) forwardDeletes(sentText.removeCodePoints(beforeLength))
    return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
  }

  private fun forwardDeletes(count: Int) {
    sendDeletes(count.coerceAtMost(MAX_DELETE_LENGTH))
  }
}
