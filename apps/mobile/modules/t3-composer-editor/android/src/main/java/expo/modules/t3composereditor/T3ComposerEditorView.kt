package expo.modules.t3composereditor

import android.content.Context
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.ReplacementSpan
import android.view.Gravity
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import kotlin.math.max

class T3ComposerEditorView(context: Context, appContext: AppContext) : ExpoView(
  context,
  appContext
) {
  private val editor = SelectionAwareEditText(context)
  private val onComposerChange by EventDispatcher()
  private val onComposerSelectionChange by EventDispatcher()
  private val onComposerFocus by EventDispatcher()
  private val onComposerBlur by EventDispatcher()
  private val onComposerPasteImages by EventDispatcher()
  private val onComposerContentSizeChange by EventDispatcher()
  private var applyingNativeValue = false
  private var desiredLineHeightPx = 0
  private var lastContentHeight = 0
  private var contentInsetVertical = 0
  private var tokensJson = "[]"
  private var tokens: List<ComposerToken> = emptyList()
  private var chipTheme = ComposerChipTheme.default()
  private var autoCorrect = true
  private var spellCheck = true
  private var nativeEventCount = 0

  init {
    editor.setBackgroundColor(Color.TRANSPARENT)
    editor.gravity = Gravity.TOP or Gravity.START
    editor.includeFontPadding = false
    editor.isSingleLine = false
    editor.minLines = 1
    editor.inputType =
      InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    editor.setTextColor(Color.BLACK)
    editor.setHintTextColor(Color.GRAY)
    editor.setPadding(0, 0, 0, 0)
    editor.selectionListener = { start, end ->
      if (!applyingNativeValue) {
        emitSelectionChange(start, end)
      }
    }
    editor.pasteImagesListener = { uris ->
      onComposerPasteImages(mapOf("uris" to uris))
    }
    editor.setOnFocusChangeListener { _, hasFocus ->
      if (hasFocus) {
        onComposerFocus(emptyMap<String, Any>())
      } else {
        onComposerBlur(emptyMap<String, Any>())
      }
    }
    editor.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(
          text: CharSequence?,
          start: Int,
          count: Int,
          after: Int
        ) = Unit
        override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit

        override fun afterTextChanged(editable: Editable?) {
          if (applyingNativeValue) return
          val nextValue = editable.toString()
          val selection = currentSelectionPayload()
          nativeEventCount += 1
          onComposerChange(
            mapOf(
              "value" to nextValue,
              "selection" to selection,
              "eventCount" to nativeEventCount,
            ),
          )
          emitContentSizeIfNeeded()
        }
      },
    )
    editor.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> emitContentSizeIfNeeded() }
    addView(
      editor,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  @Suppress("ReturnCount")
  fun setControlledDocumentJson(documentJson: String) {
    val document = try {
      JSONObject(documentJson)
    } catch (_: Exception) {
      return
    }
    val mostRecentEventCount = document.optInt("mostRecentEventCount", -1)
    if (mostRecentEventCount < nativeEventCount) return

    val value = document.optString("value")
    if (document.optBoolean("isNativeEcho") && editor.text.toString() != value) return

    val nextTokensJson = document.optString("tokensJson", "[]")
    val nextTokens = if (nextTokensJson == tokensJson) tokens else parseTokens(nextTokensJson)
    val requestedSelection = document.optJSONObject("selection")
    val previousSelectionStart = editor.selectionStart.coerceAtLeast(0)
    val previousSelectionEnd = editor.selectionEnd.coerceAtLeast(0)
    val valueChanged = editor.text.toString() != value

    applyingNativeValue = true
    try {
      if (valueChanged) {
        editor.setText(value)
      }
      tokensJson = nextTokensJson
      tokens = nextTokens
      applyTokenSpans()
      if (requestedSelection != null) {
        applySelection(
          requestedSelection.optInt("start", previousSelectionStart),
          requestedSelection.optInt("end", previousSelectionEnd),
        )
      } else if (valueChanged) {
        applySelection(previousSelectionStart, previousSelectionEnd)
      }
    } finally {
      applyingNativeValue = false
    }
    emitContentSizeIfNeeded()
  }

  fun setThemeJson(themeJson: String) {
    try {
      val theme = JSONObject(themeJson)
      editor.setTextColor(parseColor(theme.optString("text"), Color.BLACK))
      editor.setHintTextColor(parseColor(theme.optString("placeholder"), Color.GRAY))
      chipTheme = ComposerChipTheme(
        chipBackground = parseColor(theme.optString("chipBackground"), chipTheme.chipBackground),
        chipBorder = parseColor(theme.optString("chipBorder"), chipTheme.chipBorder),
        chipText = parseColor(theme.optString("chipText"), chipTheme.chipText),
        skillBackground = parseColor(
          theme.optString("skillBackground"),
          chipTheme.skillBackground,
        ),
        skillBorder = parseColor(theme.optString("skillBorder"), chipTheme.skillBorder),
        skillText = parseColor(theme.optString("skillText"), chipTheme.skillText),
      )
      applyTokenSpans()
    } catch (_: Exception) {
    }
  }

  fun setPlaceholder(placeholder: String) {
    editor.hint = placeholder
  }

  fun setFontFamily(fontFamily: String) {
    editor.typeface = if (fontFamily.contains("Mono", ignoreCase = true)) {
      Typeface.MONOSPACE
    } else {
      Typeface.DEFAULT
    }
  }

  fun setFontSize(fontSize: Float) {
    editor.textSize = fontSize
    applyLineHeight()
  }

  fun setLineHeight(lineHeight: Float) {
    desiredLineHeightPx = (lineHeight * resources.displayMetrics.density).toInt()
    applyLineHeight()
  }

  fun setSingleLineCentered(centered: Boolean) {
    editor.gravity = if (centered) {
      Gravity.CENTER_VERTICAL or Gravity.START
    } else {
      Gravity.TOP or Gravity.START
    }
  }

  fun setContentInsetVertical(contentInsetVertical: Int) {
    this.contentInsetVertical =
      max(0, (contentInsetVertical * resources.displayMetrics.density).toInt())
    editor.setPadding(0, this.contentInsetVertical, 0, this.contentInsetVertical)
    emitContentSizeIfNeeded()
  }

  fun setEditable(editable: Boolean) {
    editor.isEnabled = editable
    editor.isFocusable = editable
    editor.isFocusableInTouchMode = editable
    editor.isCursorVisible = editable
  }

  fun setScrollEnabled(scrollEnabled: Boolean) {
    editor.isVerticalScrollBarEnabled = scrollEnabled
  }

  fun setAutoFocus(autoFocus: Boolean) {
    if (autoFocus) {
      post { focusEditor() }
    }
  }

  fun setAutoCorrect(autoCorrect: Boolean) {
    this.autoCorrect = autoCorrect
    updateInputFlags()
  }

  fun setSpellCheck(spellCheck: Boolean) {
    this.spellCheck = spellCheck
    updateInputFlags()
  }

  fun focusEditor() {
    editor.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
  }

  fun blurEditor() {
    editor.clearFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(editor.windowToken, 0)
  }

  fun setSelection(start: Int, end: Int) {
    applySelection(start, end)
  }

  private fun applySelection(start: Int, end: Int) {
    val textLength = editor.text?.length ?: 0
    val safeStart = start.coerceIn(0, textLength)
    val safeEnd = end.coerceIn(0, textLength)
    editor.setSelection(safeStart, safeEnd)
  }

  private fun updateInputFlags() {
    var flags =
      InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    flags = if (autoCorrect && spellCheck) {
      flags or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    } else {
      flags or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    }
    editor.inputType = flags
  }

  private fun applyLineHeight() {
    if (desiredLineHeightPx <= 0) return
    val fontHeight = editor.paint.fontMetricsInt.descent - editor.paint.fontMetricsInt.ascent
    editor.setLineSpacing(max(0, desiredLineHeightPx - fontHeight).toFloat(), 1f)
  }

  private fun currentSelectionPayload(): Map<String, Int> =
    mapOf(
      "start" to editor.selectionStart.coerceAtLeast(0),
      "end" to editor.selectionEnd.coerceAtLeast(0),
    )

  private fun emitSelectionChange(start: Int, end: Int) {
    onComposerSelectionChange(
      mapOf(
        "value" to editor.text.toString(),
        "selection" to mapOf("start" to start, "end" to end),
        "eventCount" to nativeEventCount,
      ),
    )
  }

  private fun emitContentSizeIfNeeded() {
    val height = editor.layout?.height ?: editor.measuredHeight
    val contentHeight = height + contentInsetVertical * 2
    if (contentHeight == lastContentHeight) return
    lastContentHeight = contentHeight
    onComposerContentSizeChange(
      mapOf("height" to contentHeight / resources.displayMetrics.density),
    )
  }

  private fun applyTokenSpans() {
    val editable = editor.text ?: return
    editable.getSpans(
      0,
      editable.length,
      ComposerChipSpan::class.java
    ).forEach(editable::removeSpan)
    tokens.forEach { token ->
      if (token.start < 0 || token.end <= token.start || token.end > editable.length) return@forEach
      val expectedSource = editable.substring(token.start, token.end)
      if (expectedSource != token.source) return@forEach
      editable.setSpan(
        ComposerChipSpan(
          token.label,
          token.type == "skill",
          chipTheme,
          resources.displayMetrics.density
        ),
        token.start,
        token.end,
        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
    editor.invalidate()
  }

  private fun parseColor(value: String, fallback: Int): Int =
    try {
      Color.parseColor(value)
    } catch (_: Exception) {
      fallback
    }
}

private data class ComposerToken(
  val type: String,
  val source: String,
  val label: String,
  val start: Int,
  val end: Int
)

private data class ComposerChipTheme(
  val chipBackground: Int,
  val chipBorder: Int,
  val chipText: Int,
  val skillBackground: Int,
  val skillBorder: Int,
  val skillText: Int
) {
  companion object {
    fun default() = ComposerChipTheme(
      chipBackground = Color.rgb(238, 240, 243),
      chipBorder = Color.rgb(210, 214, 220),
      chipText = Color.rgb(35, 39, 45),
      skillBackground = Color.rgb(233, 239, 255),
      skillBorder = Color.rgb(185, 200, 245),
      skillText = Color.rgb(45, 72, 155),
    )
  }
}

private class ComposerChipSpan(
  private val label: String,
  private val skill: Boolean,
  private val theme: ComposerChipTheme,
  density: Float
) : ReplacementSpan() {
  private val horizontalPadding = 7f * density
  private val verticalPadding = 2f * density
  private val cornerRadius = 6f * density
  private val borderWidth = density

  override fun getSize(
    paint: Paint,
    text: CharSequence,
    start: Int,
    end: Int,
    fontMetrics: Paint.FontMetricsInt?
  ): Int {
    fontMetrics?.let {
      val extra = verticalPadding.toInt()
      val base = paint.fontMetricsInt
      it.top = base.top - extra
      it.ascent = base.ascent - extra
      it.descent = base.descent + extra
      it.bottom = base.bottom + extra
    }
    return (paint.measureText(label) + horizontalPadding * 2).toInt()
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint
  ) {
    val width = paint.measureText(label) + horizontalPadding * 2
    val metrics = paint.fontMetrics
    val rect = RectF(
      x,
      y + metrics.ascent - verticalPadding,
      x + width,
      y + metrics.descent + verticalPadding,
    )
    val originalColor = paint.color
    val originalStyle = paint.style
    val originalStrokeWidth = paint.strokeWidth

    paint.color = if (skill) theme.skillBackground else theme.chipBackground
    paint.style = Paint.Style.FILL
    canvas.drawRoundRect(rect, cornerRadius, cornerRadius, paint)
    paint.color = if (skill) theme.skillBorder else theme.chipBorder
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = borderWidth
    canvas.drawRoundRect(rect, cornerRadius, cornerRadius, paint)
    paint.color = if (skill) theme.skillText else theme.chipText
    paint.style = Paint.Style.FILL
    canvas.drawText(label, x + horizontalPadding, y.toFloat(), paint)

    paint.color = originalColor
    paint.style = originalStyle
    paint.strokeWidth = originalStrokeWidth
  }
}

private fun parseTokens(value: String): List<ComposerToken> = try {
  val array = org.json.JSONArray(value)
  List(array.length()) { index ->
    val token = array.getJSONObject(index)
    ComposerToken(
      type = token.optString("type"),
      source = token.optString("source"),
      label = token.optString("label"),
      start = token.optInt("start"),
      end = token.optInt("end"),
    )
  }
} catch (_: Exception) {
  emptyList()
}

private class SelectionAwareEditText(context: Context) : EditText(context) {
  var selectionListener: ((Int, Int) -> Unit)? = null
  var pasteImagesListener: ((List<String>) -> Unit)? = null

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    selectionListener?.invoke(selStart, selEnd)
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      val clip = clipboard?.primaryClip
      val imageUris = buildList {
        if (clip != null) {
          for (index in 0 until clip.itemCount) {
            clip.getItemAt(index).uri?.let { uri ->
              val mimeType = context.contentResolver.getType(uri)
              if (mimeType?.startsWith("image/") == true) add(uri.toString())
            }
          }
        }
      }
      if (imageUris.isNotEmpty()) {
        pasteImagesListener?.invoke(imageUris)
        return true
      }
    }
    return super.onTextContextMenuItem(id)
  }
}
