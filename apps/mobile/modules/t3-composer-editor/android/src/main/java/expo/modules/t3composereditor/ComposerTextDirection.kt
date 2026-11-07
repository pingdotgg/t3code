package expo.modules.t3composereditor

import android.text.TextDirectionHeuristic

// Keep the word vote and Unicode ranges in sync with apps/web/src/textDirection.ts.
internal object ComposerTextDirection : TextDirectionHeuristic {
  private val inlineCode = Regex("(?<!`)(`+)(?!`)[^\\r\\n]*?(?<!`)\\1(?!`)")
  private val fence = Regex("^ {0,3}(`{3,}|~{3,}).*\\s*$")

  // shortcut: fence bodies and neutral lines lack document context; upgrade with an offset-aware layout API.
  override fun isRtl(text: CharSequence, start: Int, count: Int): Boolean {
    require(start >= 0 && count >= 0 && start <= text.length - count)
    val paragraph = text.subSequence(start, start + count).toString()
    if (fence.matches(paragraph)) return false
    return wordDirection(inlineCode.replace(paragraph, " ")) ?: false
  }

  override fun isRtl(text: CharArray, start: Int, count: Int): Boolean {
    require(start >= 0 && count >= 0 && start <= text.size - count)
    return isRtl(String(text, start, count), 0, count)
  }

  fun wordDirection(text: CharSequence): Boolean? {
    var rtl = 0
    var ltr = 0
    var first: Boolean? = null
    var hasLetter = false
    var index = 0
    while (index < text.length) {
      val value = Character.codePointAt(text, index)
      index += Character.charCount(value)
      // ECMAScript \s, plus ReplacementSpan's display-only chip placeholders.
      val isWordBreak = when (value) {
        in 0x09..0x0D, in 0x2000..0x200A, 0x20, 0xA0, 0x1680, 0x2028, 0x2029,
        0x202F, 0x205F, 0x3000, 0xFEFF, 0xFFFC -> true
        else -> false
      }
      if (isWordBreak) {
        hasLetter = false
      } else if (!hasLetter && Character.isLetter(value)) {
        val isRTL = value in 0x0590..0x08FF || value in 0xFB1D..0xFDFF ||
          value in 0xFE70..0xFEFF || value in 0x10800..0x10FFF || value in 0x1E800..0x1EFFF
        if (first == null) first = isRTL
        if (isRTL) rtl++ else ltr++
        hasLetter = true
      }
    }
    return if (rtl == ltr) first else rtl > ltr
  }
}
