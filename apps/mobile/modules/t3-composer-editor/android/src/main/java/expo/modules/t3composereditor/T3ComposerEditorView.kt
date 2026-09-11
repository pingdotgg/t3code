package expo.modules.t3composereditor

import android.content.Context
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.InputFilter
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.ReplacementSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.t3markdowntext.T3ContextChip
import org.json.JSONObject
import kotlin.math.max

class T3ComposerEditorView(context: Context, appContext: AppContext) : ExpoView(
  context,
  appContext
) {
  private val editor = SelectionAwareEditText(context)
  private val defaultHighlightColor = editor.highlightColor
  private val defaultSelectionColor = context.resolveThemeColor(
    android.R.attr.colorAccent,
    editor.currentTextColor,
  )
  private val onComposerChange by EventDispatcher()
  private val onComposerSelectionChange by EventDispatcher()
  private val onComposerFocus by EventDispatcher()
  private val onComposerBlur by EventDispatcher()
  private val onComposerPasteImages by EventDispatcher()
  private val onComposerContextPress by EventDispatcher()
  private val onComposerPasteContext by EventDispatcher()
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
    editor.filters = arrayOf(
      InputFilter { _, _, _, dest, start, end ->
        if (editor.readOnly && !applyingNativeValue) dest.subSequence(start, end) else null
      }
    )
    editor.selectionListener = { start, end ->
      if (!applyingNativeValue) {
        emitSelectionChange(start, end)
      }
    }
    editor.pasteImagesListener = { uris ->
      onComposerPasteImages(mapOf("uris" to uris))
    }
    editor.pasteContextListener = { payload -> onComposerPasteContext(payload) }
    val contextGestures =
      GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
          override fun onDown(event: MotionEvent) = true
          override fun onSingleTapUp(event: MotionEvent): Boolean {
            val offset = editor.getOffsetForPosition(event.x, event.y)
            val token =
              tokens.firstOrNull {
                (it.type == "context" || it.type == "mention") && offset >= it.start &&
                  offset < it.end
              }
                ?: return false
            if (token.end <= editor.length() &&
              editor.text.substring(token.start, token.end) == token.source
            ) {
              onComposerContextPress(
                mapOf(
                  "source" to token.source,
                  "start" to token.start,
                  "end" to token.end
                )
              )
            }
            return false
          }
        }
      )
    editor.setOnTouchListener { _, event ->
      contextGestures.onTouchEvent(event)
      false
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
    editor.addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ ->
      if (right - left != oldRight - oldLeft) applyTokenSpans()
      emitContentSizeIfNeeded()
    }
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
      if (theme.isNull("selection")) {
        resetSelectionTheme()
      } else {
        applySelectionTheme(parseColor(theme.optString("selection"), editor.currentTextColor))
      }
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

  fun setClipboardFragment(fragment: String) {
    editor.clipboardFragment = fragment
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
    applyTokenSpans()
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
    editor.isCursorVisible = editable && !editor.readOnly
  }

  fun setReadOnly(readOnly: Boolean) {
    editor.readOnly = readOnly
    editor.isCursorVisible = editor.isEnabled && !readOnly
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
    // Re-applying an unchanged selection resets the keyboard's suggestion
    // state, so a no-op assignment must be skipped.
    if (editor.selectionStart == safeStart && editor.selectionEnd == safeEnd) return
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

  private fun applySelectionTheme(color: Int) {
    editor.highlightColor = color.withAlpha(0x52)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

    editor.textCursorDrawable = editor.textCursorDrawable?.mutate()?.apply { setTint(color) }
    editor.textSelectHandle?.mutate()?.setTint(color)
    editor.textSelectHandleLeft?.mutate()?.setTint(color)
    editor.textSelectHandleRight?.mutate()?.setTint(color)
  }

  private fun resetSelectionTheme() {
    applySelectionTheme(defaultSelectionColor)
    editor.highlightColor = defaultHighlightColor
  }

  private fun currentSelectionPayload(): Map<String, Int> =
    mapOf(
      "start" to editor.selectionStart.coerceAtLeast(0),
      "end" to editor.selectionEnd.coerceAtLeast(0),
    )

  private fun emitSelectionChange(start: Int, end: Int) {
    // Caret moves advance the revision counter like text edits do: a
    // controlled payload computed before this move is stale and must fail the
    // revision guard instead of yanking the caret back mid-typing.
    nativeEventCount += 1
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
          T3ContextChip(
            content = T3ContextChip.Content(
              label = token.label,
              symbol = token.symbol,
              detail = token.detail
            ),
            fontSize = editor.textSize * 0.8f,
            colors = T3ContextChip.Colors(
              accent = T3ContextChip.color(token.accent, chipTheme.chipText),
              foreground = chipTheme.chipText,
              border = chipTheme.chipBorder
            ),
            maximumWidth = (
              editor.width.takeIf {
                it > 0
              } ?: resources.displayMetrics.widthPixels
              ).toFloat(),
            density = resources.displayMetrics.density,
          )
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
      val androidColor = if (value.length == 9 && value.startsWith("#")) {
        "#${value.takeLast(2)}${value.substring(1, 7)}"
      } else {
        value
      }
      Color.parseColor(androidColor)
    } catch (_: Exception) {
      fallback
    }
}

private fun Int.withAlpha(alpha: Int): Int = (this and 0x00FFFFFF) or (alpha shl 24)

private fun Context.resolveThemeColor(attribute: Int, fallback: Int): Int {
  val value = TypedValue()
  return if (theme.resolveAttribute(attribute, value, true)) value.data else fallback
}

private data class ComposerToken(
  val type: String,
  val source: String,
  val label: String,
  val detail: String,
  val accent: String,
  val symbol: String,
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
  private val chip: T3ContextChip
) : ReplacementSpan() {
  override fun getSize(
    paint: Paint,
    text: CharSequence,
    start: Int,
    end: Int,
    fontMetrics: Paint.FontMetricsInt?
  ): Int {
    fontMetrics?.let {
      val base = paint.fontMetricsInt
      it.top = base.top
      it.ascent = base.ascent
      it.descent = base.descent
      it.bottom = base.bottom
    }
    // toInt() truncates; a fractional pixel would leave the span narrower than the chip
    // draws and clip its right-hand border.
    return kotlin.math.ceil(chip.width).toInt()
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
    val metrics = paint.fontMetrics
    chip.draw(canvas, x, y + (metrics.ascent + metrics.descent - chip.height) / 2)
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
      detail = token.optString("detail"),
      accent = token.optString("accent"),
      symbol = token.optString("symbol", "doc"),
      start = token.optInt("start"),
      end = token.optInt("end"),
    )
  }
} catch (_: Exception) {
  emptyList()
}

private class SelectionAwareEditText(context: Context) : EditText(context) {
  var readOnly = false
  var selectionListener: ((Int, Int) -> Unit)? = null
  var pasteImagesListener: ((List<String>) -> Unit)? = null
  var pasteContextListener: ((Map<String, String>) -> Unit)? = null
  var clipboardFragment = ""

  private fun deleteChip(backwards: Boolean): Boolean {
    val content = text
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (content == null || start < 0 || end < 0) return false
    val from = if (start == end && backwards) (start - 1).coerceAtLeast(0) else start
    val to = if (start == end && !backwards) (end + 1).coerceAtMost(content.length) else end
    val spans = content.getSpans(from, to, ComposerChipSpan::class.java).filter {
      content.getSpanStart(it) <
        to &&
        content.getSpanEnd(it) > from
    }
    if (spans.isNotEmpty()) {
      val first = minOf(from, spans.minOf { content.getSpanStart(it) })
      val last = maxOf(to, spans.maxOf { content.getSpanEnd(it) })
      content.delete(first, last)
      setSelection(first)
    }
    return spans.isNotEmpty()
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val handled = when (keyCode) {
      KeyEvent.KEYCODE_DEL -> deleteChip(true)
      KeyEvent.KEYCODE_FORWARD_DEL -> deleteChip(false)
      else -> false
    }
    return handled || super.onKeyDown(keyCode, event)
  }

  private fun deleteAdjacentChip(beforeLength: Int, afterLength: Int): Boolean = when {
    beforeLength == 1 && afterLength == 0 -> deleteChip(true)
    beforeLength == 0 && afterLength == 1 -> deleteChip(false)
    else -> false
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(connection, false) {
      override fun deleteSurroundingText(
        beforeLength: Int,
        afterLength: Int
      ): Boolean = deleteAdjacentChip(beforeLength, afterLength) ||
        super.deleteSurroundingText(beforeLength, afterLength)
      override fun deleteSurroundingTextInCodePoints(
        beforeLength: Int,
        afterLength: Int
      ): Boolean = deleteAdjacentChip(beforeLength, afterLength) ||
        super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }
  }

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    selectionListener?.invoke(selStart, selEnd)
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    val pasting = id == android.R.id.paste || id == android.R.id.pasteAsPlainText
    if (readOnly && (id == android.R.id.cut || pasting)) {
      return false
    }
    val handled = when {
      id == android.R.id.copy || id == android.R.id.cut -> copyContext(id == android.R.id.cut)
      pasting -> pasteContextOrImages()
      else -> false
    }
    return handled || super.onTextContextMenuItem(id)
  }

  private fun copyContext(cut: Boolean): Boolean {
    val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
    val end = maxOf(selectionStart, selectionEnd).coerceAtMost(length())
    if (end <= start || clipboardFragment.isEmpty()) return false
    T3ComposerClipboard.write(context, text.substring(start, end), clipboardFragment)
    if (cut) text.delete(start, end)
    return true
  }

  private fun pasteContextOrImages(): Boolean {
    val payload = T3ComposerClipboard.read(context)
    if (payload["html"]?.contains("data-t3-context-fragment=") == true) {
      pasteContextListener?.invoke(payload)
      return true
    }
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
    if (imageUris.isNotEmpty()) pasteImagesListener?.invoke(imageUris)
    return imageUris.isNotEmpty()
  }
}
