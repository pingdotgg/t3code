package expo.modules.t3reviewdiff

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import expo.modules.kotlin.AppContext
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ReviewDiffViewportTest {
  @Test
  fun immediateNavigationStopsAnActiveFling() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val view = T3ReviewDiffView(activity, AppContext())
    val scroller = view.javaClass.getDeclaredField("verticalScroller").apply {
      isAccessible = true
    }.get(view) as android.widget.OverScroller
    try {
      scroller.fling(0, 100, 0, 2000, 0, 0, 0, 10000)
      assertTrue(!scroller.isFinished)
      view.scrollToTop(false)
      view.computeScroll()
      val canvas = view.getChildAt(0)
      val offset = canvas.javaClass.getDeclaredMethod("verticalOffset").apply {
        isAccessible = true
      }.invoke(canvas)
      assertEquals(0, offset)
      assertTrue(scroller.isFinished)
    } finally {
      view.cleanup()
      activity.finish()
    }
  }

  @Test
  fun resetDiscardsOldRowsAndPendingDecodeBeforePublishingTheNewDestination() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val appContext = AppContext()
    val view = T3ReviewDiffView(activity, appContext)
    val decoder = ManualDecoder()
    view.javaClass.getDeclaredField("payloadDecodeExecutor").apply { isAccessible = true }
      .set(view, decoder)
    activity.setContentView(view)
    val canvas = view.getChildAt(0)
    val measure = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(measure, measure)
    canvas.layout(0, 0, 320, 320)
    val bitmap = Bitmap.createBitmap(320, 320, Bitmap.Config.ARGB_8888)
    try {
      view.setInitialFileId("old-selected")
      view.setRowsJson(rows("old-selected"))
      decoder.completeNext()
      canvas.draw(Canvas(bitmap))
      assertEquals(900, ranges(appContext).first()["firstRowIndex"])
      appContext.events.clear()

      // This decode belongs to the old content, but completes after the reset.
      view.setRowsJson(rows("old-selected"))
      view.setContentResetKey("new-content")
      view.setInitialFileId("new-selected")
      canvas.draw(Canvas(bitmap))
      assertTrue(
        "reset must not publish the previous payload's top range",
        ranges(appContext).isEmpty()
      )
      assertEquals(0, rowTop(canvas, 1))
      decoder.completeNext()
      canvas.draw(Canvas(bitmap))
      assertTrue(
        "a stale decode must not restore old rows or publish a range",
        ranges(appContext).isEmpty()
      )
      assertEquals(0, rowTop(canvas, 1))

      view.setRowsJson(rows("new-selected"))
      decoder.completeNext()
      canvas.draw(Canvas(bitmap))
      assertEquals(1, ranges(appContext).size)
      assertEquals(900, ranges(appContext).single()["firstRowIndex"])
      assertEquals(1000, ranges(appContext).single()["totalRows"])
    } finally {
      view.cleanup()
      bitmap.recycle()
      activity.finish()
      appContext.events.clear()
    }
  }

  @Test
  fun decodedRowsWaitForTheReplacementFilePropBeforePublishingAViewport() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val appContext = AppContext()
    val view = T3ReviewDiffView(activity, appContext)
    val decoder = ManualDecoder()
    view.javaClass.getDeclaredField("payloadDecodeExecutor").apply { isAccessible = true }
      .set(view, decoder)
    activity.setContentView(view)
    val canvas = view.getChildAt(0)
    val measure = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(measure, measure)
    canvas.layout(0, 0, 320, 320)
    try {
      view.setInitialFileId("old-selected")
      view.setRowsJson(rows("old-selected"))
      decoder.completeNext()
      appContext.events.clear()

      view.setContentResetKey("new-content")
      view.setRowsJson(rows("new-selected"))
      decoder.completeNext()
      // Other props can rebuild layout while the destination still names the old payload.
      view.setCollapsedFileIdsJson("[]")
      view.setStyleJson("{}")
      view.setInitialRowIndex(-1.0)
      assertTrue(
        "decoded rows must wait for a resolvable destination",
        ranges(appContext).isEmpty()
      )

      view.setInitialFileId("new-selected")
      assertEquals(900, ranges(appContext).single()["firstRowIndex"])
      assertEquals(1000, ranges(appContext).single()["totalRows"])
    } finally {
      view.cleanup()
      activity.finish()
      appContext.events.clear()
    }
  }

  @Test
  fun collapsedFilesKeepViewportIndicesInTheFullPayload() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val appContext = AppContext()
    val view = T3ReviewDiffView(activity, appContext)
    val decoder = ManualDecoder()
    view.javaClass.getDeclaredField("payloadDecodeExecutor").apply { isAccessible = true }
      .set(view, decoder)
    activity.setContentView(view)
    val canvas = view.getChildAt(0)
    val measure = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(measure, measure)
    canvas.layout(0, 0, 320, 320)
    try {
      view.setRowsJson(rows("expanded-file", 100001, 100226))
      decoder.completeNext()
      assertEquals(0, ranges(appContext).last()["firstRowIndex"])
      assertTrue((ranges(appContext).last()["lastRowIndex"] as Int) < 100001)
      appContext.events.clear()

      view.setCollapsedFileIdsJson("[\"first-file\"]")
      val collapsedRange = ranges(appContext).single()
      assertEquals("the collapsed file header stays visible", 0, collapsedRange["firstRowIndex"])
      assertTrue(
        "the following expanded file must be addressed in the full payload",
        (collapsedRange["lastRowIndex"] as Int) > 100001
      )
      assertEquals(100226, collapsedRange["totalRows"])
      appContext.events.clear()

      view.setInitialFileId("expanded-file")
      assertEquals(100001, ranges(appContext).last()["firstRowIndex"])
      assertEquals(
        "expanded-file",
        appContext.events.last { it.first == "onVisibleFileChange" }.second["fileId"]
      )
      appContext.events.clear()

      view.setCollapsedFileIdsJson("[]")
      view.setInitialFileId("first-file")
      assertEquals(0, ranges(appContext).last()["firstRowIndex"])
      assertTrue((ranges(appContext).last()["lastRowIndex"] as Int) < 100001)
    } finally {
      view.cleanup()
      activity.finish()
      appContext.events.clear()
    }
  }

  private fun rowTop(canvas: View, index: Int): Int = canvas.javaClass
    .getDeclaredMethod("rowTop", Int::class.javaPrimitiveType).apply { isAccessible = true }
    .invoke(canvas, index) as Int

  private fun ranges(appContext: AppContext) = appContext.events
    .filter { (name, payload) -> name == "onDebug" && payload["message"] == "visible-range" }
    .map { it.second }

  private fun rows(
    selectedFileId: String,
    selectedStart: Int = 900,
    count: Int = 1000
  ): String = JSONArray().apply {
    for (index in 0 until count) {
      put(
        JSONObject().apply {
          put("id", "$selectedFileId:$index")
          put("kind", if (index == 0 || index == selectedStart) "file" else "line")
          put("fileId", if (index < selectedStart) "first-file" else selectedFileId)
          put("content", "const value = $index")
        }
      )
    }
  }.toString()

  private class ManualDecoder : AbstractExecutorService() {
    private val work = ArrayDeque<Runnable>()
    override fun execute(command: Runnable) {
      work.addLast(command)
    }
    fun completeNext() {
      work.removeFirst().run()
      shadowOf(Looper.getMainLooper()).idle()
    }
    override fun shutdown() = Unit
    override fun shutdownNow(): MutableList<Runnable> = mutableListOf()
    override fun isShutdown() = false
    override fun isTerminated() = false
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
  }
}
