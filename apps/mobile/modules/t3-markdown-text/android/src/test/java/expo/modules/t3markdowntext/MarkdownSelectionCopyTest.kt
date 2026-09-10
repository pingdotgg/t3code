package expo.modules.t3markdowntext

import android.graphics.drawable.ColorDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ImageSpan
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class MarkdownSelectionCopyTest {
  private fun withIcon(value: String): SpannableString = SpannableString(value).apply {
    val index = value.indexOf('\uFFFC')
    setSpan(ImageSpan(ColorDrawable()), index, index + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  @Test
  fun removesIconAndInjectedSpacer() {
    val text = withIcon("\uFFFC\u00A0main.go:12 starts the server.")
    assertEquals("main.go:12 starts the server.", copyTextWithoutInlineImages(text, 0, text.length))
  }

  @Test
  fun removesSpacerWhenSelectionStartsAfterIcon() {
    val text = withIcon("\uFFFC\u00A0main.go:12 starts the server.")
    assertEquals("main.go:12", copyTextWithoutInlineImages(text, 1, 12))
  }

  @Test
  fun preservesAuthoredWhitespaceAndLiteralObjectCharacters() {
    val text = withIcon("before\u00A0 \uFFFC\u00A0\u00A0 main.go after\u00A0\uFFFC\u00A0")
    assertEquals(
      "before\u00A0 \u00A0 main.go after\u00A0\uFFFC\u00A0",
      copyTextWithoutInlineImages(text, 0, text.length)
    )
  }

  @Test
  fun preservesTextWithoutImageSpans() {
    val text = "\uFFFC\u00A0main.go"
    assertEquals(text, copyTextWithoutInlineImages(text, 0, text.length))
    assertEquals(text, copyTextWithoutInlineImages(SpannableString(text), 0, text.length))
  }
}
