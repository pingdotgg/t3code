package expo.modules.t3composereditor

import android.view.View
import android.view.ViewGroup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerPlaceholderTest {
  private val placeholder = "Ask the repo agent, or run a command…"
  private val editor = SelectionAwareEditText(RuntimeEnvironment.getApplication()).apply {
    layoutParams = ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    )
    textSize = 16f
    placeholder = this@ComposerPlaceholderTest.placeholder
  }

  private fun measureAt(width: Int) {
    editor.measure(
      View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    editor.layout(0, 0, width, editor.measuredHeight)
  }

  @Test
  fun narrowEditorCutsThePlaceholderToOneLine() {
    val fullWidth = editor.paint.measureText(placeholder)
    val width = (fullWidth / 2).toInt()
    measureAt(width)

    val hint = editor.hint.toString()
    assertTrue(hint, hint.endsWith("…") && hint.length < placeholder.length)
    assertTrue(hint, editor.paint.measureText(hint) <= width)
  }

  @Test
  fun wideEditorKeepsTheWholePlaceholder() {
    measureAt(editor.paint.measureText(placeholder).toInt() + 20)
    assertEquals(placeholder, editor.hint.toString())
  }

  @Test
  fun placeholderRecoversWhenTheEditorWidens() {
    measureAt((editor.paint.measureText(placeholder) / 2).toInt())
    measureAt(editor.paint.measureText(placeholder).toInt() + 20)
    assertEquals(placeholder, editor.hint.toString())
  }
}
