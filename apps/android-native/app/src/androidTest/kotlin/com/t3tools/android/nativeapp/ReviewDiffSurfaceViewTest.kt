package com.t3tools.android.nativeapp

import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.t3reviewdiff.ReviewDiffSurfaceView
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReviewDiffSurfaceViewTest {
  @Test
  fun creates_renders_and_destroys_the_shared_renderer() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    lateinit var view: ReviewDiffSurfaceView

    instrumentation.runOnMainSync {
      view = ReviewDiffSurfaceView(instrumentation.targetContext).apply {
        measure(exactly(1080), exactly(1600))
        layout(0, 0, 1080, 1600)
        setRowsJson(
          """[{"kind":"file","id":"file:README.md","fileId":"file:README.md","filePath":"README.md","changeType":"modified","additions":1,"deletions":0},{"kind":"line","id":"line:1","fileId":"file:README.md","filePath":"README.md","content":"phase-three-delta","change":"add","newLineNumber":1}]""",
        )
      }
    }
    instrumentation.waitForIdleSync()
    instrumentation.runOnMainSync {
      assertEquals("t3-review-renderer-smoke", view.contentDescription)
      view.setCollapsedFileIdsJson("[]")
      view.setViewedFileIdsJson("[]")
      view.setSelectedRowIdsJson("[\"line:1\"]")
      view.scrollToFile("file:README.md", animated = false)
      view.cleanup()
    }
  }

  private fun exactly(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
}
