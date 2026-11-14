package expo.modules.t3composereditor

import android.text.Layout
import android.view.View
import android.view.ViewGroup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.floor

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerContentWidthTest {
  private val editor = SelectionAwareEditText(RuntimeEnvironment.getApplication()).apply {
    layoutParams = ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    textSize = 16f
    setPadding(0, 0, 0, 0)
  }

  private fun layoutAt(width: Int): Layout {
    editor.measure(
      View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    editor.layout(0, 0, width, editor.measuredHeight)
    return editor.layout
  }

  // JS keeps the compact row when the reported width is at most the compact slot's.
  @Test
  fun reportedWidthStillFitsOnOneLine() {
    editor.setText("I know t3 code exposes a websocket")
    val wide = layoutAt(10_000)
    val natural = wide.getLineMax(0)
    assertNotEquals("the draft needs a fractional width", floor(natural), natural)

    val reported = singleLineContentWidth(wide)
    assertEquals(1, layoutAt(reported).lineCount)
  }
}
