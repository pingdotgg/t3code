package expo.modules.t3markdowntext

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.ReplacementSpan
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import android.util.Base64
import android.util.LruCache
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.uimanager.UIManagerHelper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.max
import kotlin.math.min
import org.json.JSONObject
import org.json.JSONArray
import java.net.URLEncoder
import java.io.ByteArrayOutputStream
import kotlin.math.ceil

private const val OBJECT_REPLACEMENT_CHARACTER = "\uFFFC"

// Match React Native's measurement buffer. Android orders tied line-height
// spans differently in SpannableString, shifting inline images once RN's
// span priorities are exhausted.
private object MarkdownSpannableFactory : Spannable.Factory() {
  override fun newSpannable(source: CharSequence): Spannable =
    SpannableStringBuilder(source)
}

private fun copyTextWithoutInlineImages(
  text: CharSequence,
  start: Int,
  end: Int
): String {
  if (text !is Spanned) return text.subSequence(start, end).toString()

  return buildString {
    for (index in start until end) {
      val isInlineImage =
        text[index].toString() == OBJECT_REPLACEMENT_CHARACTER &&
          text.getSpans(index, index + 1, ReplacementSpan::class.java).isNotEmpty()
      if (!isInlineImage) append(text[index])
    }
  }
}

private fun canonicalSelection(
  originalText: String,
  start: Int,
  end: Int,
  ranges: JSONArray?
): String? {
  if (ranges == null) return null
  val canonical = StringBuilder(originalText)
  var hasContext = false
  for (index in ranges.length() - 1 downTo 0) {
    val range = ranges.optJSONObject(index) ?: continue
    val first = max(start, range.optInt("start"))
    val last = min(end, range.optInt("end"))
    if (last > first) {
      canonical.replace(first - start, last - start, range.optString("text"))
      hasContext = true
    }
  }
  return if (hasContext) canonical.toString().replace(OBJECT_REPLACEMENT_CHARACTER, "") else null
}

private fun selectedContextRecords(records: JSONArray, selectedText: String): JSONArray {
  val ids = mutableSetOf<String>()
  for (index in 0 until records.length()) {
    val record = records.getJSONObject(index)
    if (selectedText.contains("/${record.optString("contextId")})")) {
      ids.add(record.optString("contextId"))
      if (record.has("screenshotContextId")) ids.add(record.getString("screenshotContextId"))
    }
  }
  val copied = JSONArray()
  for (index in 0 until records.length()) {
    val record = records.getJSONObject(index)
    if (ids.contains(record.optString("contextId"))) copied.put(record)
  }
  return copied
}

private fun contextClipData(selectedText: String, fragment: String): ClipData {
  val payload = runCatching { JSONObject(fragment) }.getOrNull()
  val records = payload?.optJSONArray("records")
  val copied = records?.let { selectedContextRecords(it, selectedText) }
  if (payload == null || copied == null || copied.length() == 0) {
    return ClipData.newPlainText(null, selectedText)
  }
  payload.put("records", copied)
  val attribute = URLEncoder.encode(payload.toString(), "UTF-8").replace("+", "%20")
  val escaped = selectedText.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
  return ClipData.newHtmlText(
    null,
    selectedText,
    "<pre data-t3-context-fragment=\"$attribute\">$escaped</pre>"
  )
}

private class SanitizingSelectionActionModeCallback(
  private val textView: TextView,
  private val delegate: ActionMode.Callback?,
  var contextClipboardConfig: String
) : ActionMode.Callback {
  override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean =
    delegate?.onCreateActionMode(mode, menu) ?: true

  override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
    delegate?.onPrepareActionMode(mode, menu) ?: false

  override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
    if (item.itemId == android.R.id.copy && copySelection()) {
      mode.finish()
      return true
    }
    return delegate?.onActionItemClicked(mode, item) ?: false
  }

  private fun copySelection(): Boolean {
    val start = min(textView.selectionStart, textView.selectionEnd)
    val end = max(textView.selectionStart, textView.selectionEnd)
    if (start < 0 || end <= start) return false
    val originalText = textView.text.subSequence(start, end).toString()
    val config = runCatching { JSONObject(contextClipboardConfig) }.getOrNull()
    val canonical = canonicalSelection(originalText, start, end, config?.optJSONArray("ranges"))
    val selectedText = canonical ?: copyTextWithoutInlineImages(textView.text, start, end)
    val handled = canonical != null || selectedText != originalText
    if (handled) {
      val clipboard =
        textView.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = if (canonical != null) {
        contextClipData(selectedText, config?.optString("fragment") ?: "")
      } else {
        ClipData.newPlainText(null, selectedText)
      }
      clipboard.setPrimaryClip(clip)
    }
    return handled
  }

  override fun onDestroyActionMode(mode: ActionMode) {
    delegate?.onDestroyActionMode(mode)
  }
}

class T3MarkdownTextSelectionModule : Module() {
  private val chipImages = LruCache<String, Map<String, Any>>(128)

  /**
   * Metrics of the paragraph font a chip sits in, so the inline box it reports can be sized
   * from the same ascent and descent the surrounding text lays out with.
   */
  private fun paragraphFontMetrics(text: JSONObject?, scale: Float): Paint.FontMetricsInt =
    TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = (text?.optDouble("fontSize", 15.0)?.toFloat() ?: 15f).coerceIn(6f, 80f) * scale
      val fontFamily = text?.optString("fontFamily").orEmpty()
      typeface = if (fontFamily.isEmpty()) {
        Typeface.DEFAULT
      } else {
        ReactFontManager.getInstance()
          .getTypeface(fontFamily, Typeface.NORMAL, appContext.reactContext?.assets)
      }
    }.fontMetricsInt

  override fun definition() = ModuleDefinition {
    Name("T3MarkdownTextSelection")

    Function("renderContextChip") { payloadJson: String ->
      val resources = appContext.reactContext?.resources ?: return@Function null
      val metrics = resources.displayMetrics
      val fontScale = resources.configuration.fontScale
      val key = "${metrics.density}:$fontScale:${metrics.widthPixels}:$payloadJson"
      chipImages.get(key)?.let { return@Function it }
      val payload = JSONObject(payloadJson)
      val chip = T3ContextChip(
        content = T3ContextChip.Content(
          label = payload.optString("label").take(4096),
          symbol = payload.optString("symbol", "doc")
        ),
        // The line box around the chip is measured with `fontScale` below, so the chip has to
        // carry it too, or it shrinks against the words beside it at a larger text size.
        fontSize =
          payload.optDouble("fontSize", 12.0).toFloat().coerceIn(10f, 40f) *
            metrics.density * fontScale,
        colors = T3ContextChip.Colors(
          accent = T3ContextChip.color(payload.optString("accent"), Color.GRAY),
          foreground = T3ContextChip.color(payload.optString("foreground"), Color.BLACK),
          border = T3ContextChip.color(payload.optString("border"), Color.GRAY)
        ),
        maximumWidth = (metrics.widthPixels - 80 * metrics.density).coerceAtLeast(100f),
        density = metrics.density,
      )
      // toInt() truncates, so a fractional pixel of the chip would fall outside the bitmap
      // and take the right-hand border with it. Round up: a spare column costs nothing.
      // One spare pixel of transparency on each side. Whatever rounding happens between the
      // bitmap's pixels and the box's dp then falls on padding instead of on the border.
      val bleed = 1
      val bitmap = Bitmap.createBitmap(
        ceil(chip.width).toInt() + bleed * 2,
        ceil(chip.height).toInt() + bleed * 2,
        Bitmap.Config.ARGB_8888
      )
      chip.draw(Canvas(bitmap), bleed.toFloat(), bleed.toFloat())
      val bytes = ByteArrayOutputStream()
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
      bitmap.recycle()
      // React Native sits an inline view's box on the text baseline and grows the line's
      // ascent to fit it, so a box as tall as the chip lifts the chip above the words and
      // pushes the baseline down. Report a box no taller than the paragraph font's ascent,
      // which leaves the line exactly as tall as a line of plain text, plus where inside
      // that box the bitmap must sit so the chip centres on the font's ascent/descent box:
      // the same rule the composer's ReplacementSpan uses to draw its chips.
      val lineMetrics = paragraphFontMetrics(
        payload.optJSONObject("text"),
        fontScale * metrics.density,
      )
      val ascent = -lineMetrics.ascent
      val descent = lineMetrics.descent
      val bitmapWidth = ceil(chip.width) + bleed * 2
      val bitmapHeight = ceil(chip.height) + bleed * 2
      val result = mapOf<String, Any>(
        "uri" to
          "data:image/png;base64,${Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)}",
        // Layout rounds dp back to whole pixels. Reporting a hair less than the bitmap lets
        // that rounding land inside the image and crop its right-hand border, so round the
        // box up: an extra fraction of a pixel is invisible, a missing border is not.
        "width" to bitmapWidth / metrics.density,
        "height" to bitmapHeight / metrics.density,
        "boxHeight" to ascent / metrics.density,
        "offsetY" to (ascent + descent - bitmapHeight) / 2f / metrics.density,
      )
      chipImages.put(key, result)
      result
    }

    Function("installCopySanitizer") { reactTag: Int, contextClipboardConfig: String ->
      val reactContext = appContext.reactContext as? ReactContext ?: return@Function
      reactContext.runOnUiQueueThread {
        val textView =
          runCatching {
            UIManagerHelper.getUIManagerForReactTag(reactContext, reactTag)?.resolveView(reactTag)
          }
            .getOrNull() as? TextView ?: return@runOnUiQueueThread
        val currentCallback = textView.customSelectionActionModeCallback
        if (currentCallback is SanitizingSelectionActionModeCallback) {
          currentCallback.contextClipboardConfig = contextClipboardConfig
          return@runOnUiQueueThread
        }
        textView.setSpannableFactory(MarkdownSpannableFactory)
        textView.customSelectionActionModeCallback =
          SanitizingSelectionActionModeCallback(textView, currentCallback, contextClipboardConfig)
      }
    }
  }
}
