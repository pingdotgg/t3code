package expo.modules.t3terminal

import android.text.Editable
import android.text.Spannable
import android.text.TextWatcher
import android.view.inputmethod.BaseInputConnection

// Sends what the IME commits to the hidden input, then clears it. Composing
// text (pinyin, predicted words) stays in the input until it is committed,
// so the terminal never receives partial compositions.
internal class TerminalTextWatcher(
  private val sentText: TerminalSentText,
  private val isReadOnly: () -> Boolean,
  private val send: (String) -> Unit
) : TextWatcher {
  private var clearing = false

  override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

  override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
    if (isReadOnly() || clearing) return
    if (s == null || count <= 0 || isComposing(s)) return
    val end = (start + count).coerceAtMost(s.length)
    if (start < end) {
      val insertedText = s.subSequence(start, end).toString()
      sentText.append(insertedText)
      send(insertedText)
    }
  }

  override fun afterTextChanged(editable: Editable?) {
    if (clearing || editable.isNullOrEmpty() || isComposing(editable)) return
    clear(editable)
  }

  // finishComposingText keeps the composed text without a text change.
  fun onComposingFinished(editable: Editable) {
    if (editable.isEmpty() || isComposing(editable)) return
    if (!isReadOnly()) {
      val composedText = editable.toString()
      sentText.append(composedText)
      send(composedText)
    }
    clear(editable)
  }

  private fun clear(editable: Editable) {
    clearing = true
    editable.clear()
    clearing = false
  }

  private fun isComposing(text: CharSequence) =
    text is Spannable && BaseInputConnection.getComposingSpanStart(text) != -1
}
