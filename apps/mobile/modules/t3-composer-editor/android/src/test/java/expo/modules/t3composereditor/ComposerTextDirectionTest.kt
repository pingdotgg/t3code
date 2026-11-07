package expo.modules.t3composereditor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerTextDirectionTest {
  @Test
  fun matchesWebWordVotes() {
    val cases = listOf(
      "اكتب دالة تجمع الأرقام" to true,
      "תקן את הבאג" to true,
      "fix the failing test" to false,
      "StrictMode: يعيد الـ render مرتين في التطوير" to true,
      "API: תקן את הבאג" to true,
      "translate the label مرحبا for the login screen" to false,
      "React مكتبة" to false,
      "مكتبة React" to true,
      "عدّل السطر 42، ثم شغّل الاختبارات (3)" to true,
      "42 — 7 ✓" to null,
      "🇯🇴 𞤀𞤁 𐤀 React" to true,
      "中文 日本語 عربي" to false,
      "abcالعربية مرحبا" to false,
      "hello\uFEFFمرحبا\uFEFFبالعالم" to true,
      "hello\u0085مرحبا بالعالم" to false,
    )
    for ((text, expected) in cases) {
      assertEquals(text, expected, ComposerTextDirection.wordDirection(text))
    }
  }

  @Test
  fun excludesInlineCodeAndChipPlaceholders() {
    for (text in listOf(
      "عربي `one two three` عربي",
      "عربي ``one ` two`` عربي",
      "hello\uFFFCعربي عربي",
    )) {
      assertTrue(text, ComposerTextDirection.isRtl(text, 0, text.length))
    }
    val english = "hello `عربي عربي عربي` world"
    assertFalse(ComposerTextDirection.isRtl(english, 0, english.length))
  }

  @Test
  fun respectsTheParagraphBufferAndUtf16OffsetsWithoutChangingIt() {
    val text = "🙂 English\nAPI: أصلح هذا الخلل\nEnglish"
    val start = text.indexOf("API")
    val count = text.indexOf('\n', start) + 1 - start
    val chars = text.toCharArray()
    assertTrue(ComposerTextDirection.isRtl(text, start, count))
    assertTrue(ComposerTextDirection.isRtl(chars, start, count))
    assertFalse(ComposerTextDirection.isRtl(text, 0, start))
    assertEquals(text, String(chars))
    assertEquals("API: أصلح هذا الخلل\n", text.substring(start, start + count))
  }

  @Test
  fun keepsFenceDelimitersLtr() {
    val text = "```عربي\n"
    assertFalse(ComposerTextDirection.isRtl(text, 0, text.length))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsInvalidOffsets() {
    ComposerTextDirection.isRtl("text", 1, Int.MAX_VALUE)
  }
}
