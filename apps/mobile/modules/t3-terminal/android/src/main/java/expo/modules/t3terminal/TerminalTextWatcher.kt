package expo.modules.t3terminal

import android.text.Editable
import android.text.Spannable
import android.text.TextWatcher
import android.view.inputmethod.BaseInputConnection

// Sends what the IME types into the hidden input as it happens. Composing text
// (Samsung Keyboard words, pinyin) stays in the input so the IME can keep
// editing it; each edit sends only its difference from what was already sent.
internal class TerminalTextWatcher(
  private val sentText: TerminalSentText,
  private val isReadOnly: () -> Boolean,
  private val send: (String) -> Unit
) : TextWatcher {
  private var sentComposing = ""
  private var clearing = false

  override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

  override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

  override fun afterTextChanged(editable: Editable?) {
    if (clearing || editable == null) return
    val text = editable.toString()
    if (!isReadOnly()) sendDifference(text)
    sentComposing = text
    if (!isComposing(editable)) clear(editable)
  }

  // finishComposingText keeps the composed text without a text change.
  fun onComposingFinished(editable: Editable) {
    if (!isComposing(editable)) clear(editable)
  }

  fun reset(editable: Editable) = clear(editable)

  private fun sendDifference(text: String) {
    val prefix = sentComposing.commonPrefixWith(text).length
    val removed = sentComposing.codePointCount(prefix, sentComposing.length)
    val inserted = text.substring(prefix)
    if (removed > 0) {
      sentText.removeCodePoints(removed)
      send("\u007F".repeat(removed))
    }
    if (inserted.isNotEmpty()) {
      sentText.append(inserted)
      send(inserted)
    }
  }

  private fun clear(editable: Editable) {
    sentComposing = ""
    if (editable.isEmpty()) return
    clearing = true
    editable.clear()
    clearing = false
  }

  private fun isComposing(text: CharSequence) =
    text is Spannable && BaseInputConnection.getComposingSpanStart(text) != -1
}
