package expo.modules.t3composereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject
import org.json.JSONArray

internal object T3ComposerClipboard {
  fun write(context: Context, text: String, fragment: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val payload = try {
      JSONObject(fragment)
    } catch (_: Exception) {
      null
    }
    val records = payload?.optJSONArray("records")
    if (payload == null || records == null) {
      clipboard.setPrimaryClip(ClipData.newPlainText("T3 Code", text))
      return
    }
    val all = (0 until records.length()).map { records.getJSONObject(it) }
    val selected = all.filter { text.contains("/${it.optString("contextId")})") }.toMutableList()
    val screenshots = selected.map { it.optString("screenshotContextId") }.toSet()
    selected.addAll(
      all.filter {
        screenshots.contains(it.optString("contextId")) &&
          !selected.contains(it)
      }
    )
    payload.put("records", JSONArray(selected))
    val encoded = java.net.URLEncoder.encode(payload.toString(), "UTF-8").replace("+", "%20")
    val escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    clipboard.setPrimaryClip(
      if (selected.isEmpty()) {
        ClipData.newPlainText(
          "T3 Code",
          text
        )
      } else {
        ClipData.newHtmlText(
          "T3 Code",
          text,
          "<pre data-t3-context-fragment=\"$encoded\">$escaped</pre>"
        )
      }
    )
  }

  fun read(context: Context): Map<String, String> {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = clipboard.primaryClip
    val item = if (clip != null && clip.itemCount > 0) clip.getItemAt(0) else null
    return mapOf(
      "text" to (item?.text?.toString() ?: ""),
      "html" to (item?.htmlText ?: ""),
      "fragment" to ""
    )
  }
}

class T3ComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3ComposerEditor")

    AsyncFunction("writeContextClipboard") { text: String, fragment: String ->
      T3ComposerClipboard.write(requireNotNull(appContext.reactContext), text, fragment)
    }

    View(T3ComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: T3ComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: T3ComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("clipboardFragment") { view: T3ComposerEditorView, fragment: String ->
        view.setClipboardFragment(fragment)
      }
      Prop("placeholder") { view: T3ComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { view: T3ComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: T3ComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: T3ComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") { view: T3ComposerEditorView, contentInsetVertical: Double ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: T3ComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: T3ComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("readOnly") { view: T3ComposerEditorView, readOnly: Boolean ->
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { view: T3ComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: T3ComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: T3ComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: T3ComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }
      Prop("textPasteThresholdBytes") { view: T3ComposerEditorView, threshold: Int ->
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { view: T3ComposerEditorView, maxInputChars: Int ->
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteContext",
        "onComposerPasteText",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: T3ComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: T3ComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: T3ComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
