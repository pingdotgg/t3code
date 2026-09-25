package expo.modules.t3markdowntext

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownSelectionColorTest {
  private fun textView() = TextView(RuntimeEnvironment.getApplication()).apply {
    setTextSelectHandle(ColorDrawable(Color.WHITE))
    setTextSelectHandleLeft(ColorDrawable(Color.WHITE))
    setTextSelectHandleRight(ColorDrawable(Color.WHITE))
  }

  private fun renderedColor(drawable: Drawable?): Int {
    requireNotNull(drawable)
    val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    drawable.setBounds(0, 0, 4, 4)
    drawable.draw(Canvas(bitmap))
    val color = bitmap.getPixel(2, 2)
    bitmap.recycle()
    return color
  }

  @Test
  fun retintsAllHandlesWhenTheThemeChangesWithoutChangingTheHighlight() {
    val text = textView()
    val highlight = 0x52FF0088
    text.highlightColor = highlight

    for (color in listOf(Color.MAGENTA, Color.GREEN, Color.MAGENTA)) {
      applySelectionHandleColor(text, color)
      assertEquals(color, renderedColor(text.textSelectHandle))
      assertEquals(color, renderedColor(text.textSelectHandleLeft))
      assertEquals(color, renderedColor(text.textSelectHandleRight))
      assertEquals(highlight, text.highlightColor)
    }
  }

  @Test
  fun doesNotTintOtherTextViewsSharingDrawableState() {
    val original = ColorDrawable(Color.WHITE)
    val first = textView().apply {
      setTextSelectHandleLeft(original.constantState!!.newDrawable())
    }
    val second = textView().apply {
      setTextSelectHandleLeft(original.constantState!!.newDrawable())
    }

    applySelectionHandleColor(first, Color.MAGENTA)

    assertEquals(Color.MAGENTA, renderedColor(first.textSelectHandleLeft))
    assertEquals(Color.WHITE, renderedColor(second.textSelectHandleLeft))
  }
}
