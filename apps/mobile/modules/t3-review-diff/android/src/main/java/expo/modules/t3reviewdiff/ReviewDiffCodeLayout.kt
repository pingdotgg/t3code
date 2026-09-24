package expo.modules.t3reviewdiff

import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableString
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import kotlin.math.ceil
import kotlin.math.max

/** Text layout is independent of comment heights and vertical row offsets. */
internal class CodeLines(
  val starts: IntArray,
  val height: Int,
  val nativeLayout: StaticLayout? = null
) {
  fun end(line: Int, length: Int): Int = if (line + 1 < starts.size) starts[line + 1] else length

  fun firstHeight(base: Int): Int = max(base, nativeLayout?.getLineBottom(0) ?: 0)

  fun baseline(top: Int, bottom: Int, paint: Paint): Float = nativeLayout?.let {
    top + (bottom - top - it.getLineBottom(0)) / 2f + it.getLineBaseline(0)
  } ?: ((top + bottom - paint.fontMetrics.ascent - paint.fontMetrics.descent) / 2f)

  val extraHeight: Int
    get() = nativeLayout?.let { it.height - it.getLineBottom(0) } ?: ((starts.size - 1) * height)
}

internal class CodeWrapLayout(
  val enabled: Boolean,
  private val linesByRowId: Map<String, CodeLines>
) {
  fun lines(rowId: String): CodeLines = linesByRowId[rowId] ?: SINGLE_LINE
  fun extraHeight(rowId: String): Int = lines(rowId).extraHeight
  fun rowHeight(rowId: String, base: Int): Int = lines(rowId).let {
    it.firstHeight(base) +
      it.extraHeight
  }

  companion object {
    private val SINGLE_LINE = CodeLines(intArrayOf(0), 0)
    val NONE = CodeWrapLayout(false, emptyMap())
  }
}

/** ASCII is fixed-pitch; other text needs the same shaping for measurement and drawing. */
internal fun createCodeLines(text: CharSequence, paint: TextPaint, width: Int): CodeLines {
  val characterWidth = paint.measureText("M")
  val lineHeight = ceil(paint.fontMetrics.run { descent - ascent }).toInt()
  if (text.all { it in ' '..'~' }) {
    val columns = max(1, (width / characterWidth).toInt())
    return CodeLines(
      IntArray(max(1, (text.length + columns - 1) / columns)) {
        it * columns
      },
      lineHeight
    )
  }
  val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, max(1, width))
    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
    .setIncludePad(false)
    .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
    .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
    .build()
  return CodeLines(IntArray(layout.lineCount) { layout.getLineStart(it) }, lineHeight, layout)
}

internal class CodeLayoutCache {
  private data class Entry(val row: DiffRow, val tokens: List<DiffToken>?, val lines: CodeLines)
  private var entries = emptyMap<String, Entry>()
  private var previousStyle: DiffStyle? = null
  private var previousTheme: DiffTheme? = null
  private var previousWidth = 0

  /** Entries are immutable; a worker can reuse them without changing the displayed cache. */
  fun copyForPreparation(): CodeLayoutCache = CodeLayoutCache().also {
    it.entries = entries
    it.previousStyle = previousStyle
    it.previousTheme = previousTheme
    it.previousWidth = previousWidth
  }

  @Suppress("LongParameterList")
  fun layout(
    rows: List<DiffRow>,
    tokens: Map<String, List<DiffToken>>,
    paint: Paint,
    style: DiffStyle,
    theme: DiffTheme,
    width: Int
  ): CodeWrapLayout {
    if (!style.wordWrap || width < paint.measureText("M")) {
      entries = emptyMap()
      return CodeWrapLayout.NONE
    }
    if (previousStyle != style || previousTheme != theme || previousWidth != width) {
      entries = emptyMap()
      previousStyle = style
      previousTheme = theme
      previousWidth = width
    }
    val next = HashMap<String, Entry>()
    val layouts = HashMap<String, CodeLines>()
    for (row in rows) {
      if (row.kind != "line") continue
      val rowTokens = tokens[row.id]
      val cached = entries[row.id]
      val entry = if (cached?.row == row && cached.tokens == rowTokens) {
        cached
      } else {
        val text = styledCode(row, rowTokens, theme)
        Entry(row, rowTokens, createCodeLines(text, TextPaint(paint), width))
      }
      next[row.id] = entry
      layouts[row.id] = entry.lines
    }
    entries = next
    return CodeWrapLayout(true, layouts)
  }

  private fun styledCode(row: DiffRow, tokens: List<DiffToken>?, theme: DiffTheme): CharSequence {
    // The ASCII path uses the existing token drawing and rounded highlight rectangles.
    if (row.content.all { it in ' '..'~' }) return row.content
    val text = SpannableString(row.content)
    var offset = 0
    for (token in tokens.orEmpty()) {
      val end = (offset + token.content.length).coerceAtMost(text.length)
      if (end > offset) {
        token.color?.let {
          text.setSpan(ForegroundColorSpan(it), offset, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        val fontStyle = (if (token.fontStyle and 2 != 0) Typeface.BOLD else 0) or
          (if (token.fontStyle and 1 != 0) Typeface.ITALIC else 0)
        if (fontStyle !=
          0
        ) {
          text.setSpan(StyleSpan(fontStyle), offset, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (token.fontStyle and 4 !=
          0
        ) {
          text.setSpan(UnderlineSpan(), offset, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
      offset = end
    }
    if (row.change == "add" || row.change == "delete") {
      val bar = if (row.change == "add") theme.addBar else theme.deleteBar
      val color = Color.argb(71, Color.red(bar), Color.green(bar), Color.blue(bar))
      for (range in row.wordDiffRanges) {
        val start = range.start.coerceIn(0, text.length)
        val end = range.end.coerceIn(start, text.length)
        if (end >
          start
        ) {
          text.setSpan(BackgroundColorSpan(color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
    }
    return text
  }
}
