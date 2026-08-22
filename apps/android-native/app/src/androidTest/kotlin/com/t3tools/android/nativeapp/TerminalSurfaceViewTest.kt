package com.t3tools.android.nativeapp

import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.t3terminal.TerminalSurfaceView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TerminalSurfaceViewTest {
  @Test
  fun creates_feeds_resizes_and_destroys_the_shared_renderer() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      var measuredGrid: Pair<Int, Int>? = null
      val view = TerminalSurfaceView(instrumentation.targetContext).apply {
        terminalKey = "renderer-smoke"
        onResize = { cols, rows -> measuredGrid = cols to rows }
        measure(exactly(1080), exactly(1600))
        layout(0, 0, 1080, 1600)
        reset("\u001b[32mready\u001b[0m\r\n")
        append("unicode 🙂\r\n")
        fontSize = 11f
      }

      assertEquals("t3-terminal-renderer-smoke", view.contentDescription)
      assertTrue("Initial layout must create the terminal grid", measuredGrid != null)
      view.cleanup()
    }
  }

  private fun exactly(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
}
