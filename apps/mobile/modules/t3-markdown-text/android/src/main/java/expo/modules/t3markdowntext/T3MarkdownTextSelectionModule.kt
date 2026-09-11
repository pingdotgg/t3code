package expo.modules.t3markdowntext

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ReplacementSpan
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.max
import kotlin.math.min

private const val OBJECT_REPLACEMENT_CHARACTER = "\uFFFC"

// Match React Native's measurement buffer. Android orders tied line-height
// spans differently in SpannableString, shifting inline images once RN's
// span priorities are exhausted.
private object MarkdownSpannableFactory : Spannable.Factory() {
  override fun newSpannable(source: CharSequence): Spannable =
    SpannableStringBuilder(source)
}

internal fun copyTextWithoutInlineImages(
  text: CharSequence,
  start: Int,
  end: Int
): String {
  if (text !is Spanned) return text.subSequence(start, end).toString()

  fun isInlineImage(index: Int): Boolean =
    index >= 0 && text[index].toString() == OBJECT_REPLACEMENT_CHARACTER &&
      text.getSpans(index, index + 1, ReplacementSpan::class.java).isNotEmpty()

  return buildString {
    for (index in start until end) {
      // The renderer inserts one NBSP after each image to keep its label on the same line.
      // Inspect the original text even when selection starts after the image.
      val isIconSpacer = text[index] == '\u00A0' && isInlineImage(index - 1)
      if (!isInlineImage(index) && !isIconSpacer) append(text[index])
    }
  }
}

private class SanitizingSelectionActionModeCallback(
  private val textView: TextView,
  private val delegate: ActionMode.Callback?
) : ActionMode.Callback {
  override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean =
    delegate?.onCreateActionMode(mode, menu) ?: true

  override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
    delegate?.onPrepareActionMode(mode, menu) ?: false

  override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
    if (item.itemId == android.R.id.copy) {
      val start = min(textView.selectionStart, textView.selectionEnd)
      val end = max(textView.selectionStart, textView.selectionEnd)
      if (start >= 0 && end > start) {
        val originalText = textView.text.subSequence(start, end).toString()
        val selectedText = copyTextWithoutInlineImages(textView.text, start, end)
        if (selectedText != originalText) {
          val clipboard =
            textView.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          clipboard.setPrimaryClip(ClipData.newPlainText(null, selectedText))
          mode.finish()
          return true
        }
      }
    }
    return delegate?.onActionItemClicked(mode, item) ?: false
  }

  override fun onDestroyActionMode(mode: ActionMode) {
    delegate?.onDestroyActionMode(mode)
  }
}

class T3MarkdownTextSelectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3MarkdownTextSelection")

    Function("installCopySanitizer") { reactTag: Int ->
      val reactContext = appContext.reactContext as? ReactContext ?: return@Function
      reactContext.runOnUiQueueThread {
        val textView =
          runCatching {
            UIManagerHelper.getUIManagerForReactTag(reactContext, reactTag)?.resolveView(reactTag)
          }
            .getOrNull() as? TextView ?: return@runOnUiQueueThread
        val currentCallback = textView.customSelectionActionModeCallback
        if (currentCallback is SanitizingSelectionActionModeCallback) {
          return@runOnUiQueueThread
        }
        textView.setSpannableFactory(MarkdownSpannableFactory)
        textView.customSelectionActionModeCallback =
          SanitizingSelectionActionModeCallback(textView, currentCallback)
      }
    }
  }
}
