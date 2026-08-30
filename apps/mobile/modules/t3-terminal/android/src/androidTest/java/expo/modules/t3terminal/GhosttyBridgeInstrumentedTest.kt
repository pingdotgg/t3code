package expo.modules.t3terminal

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.math.abs
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GhosttyBridgeInstrumentedTest {
  @Test
  fun retainsApproximatelyTenThousandRowsWithExplicitLimits() {
    val terminal =
      GhosttyBridge.nativeCreate(
        cols = 80,
        rows = 10,
        cellWidth = 8,
        cellHeight = 16,
        foreground = 0xFFFFFFFF.toInt(),
        background = 0xFF000000.toInt(),
        cursor = 0xFFFFFFFF.toInt(),
        palette = IntArray(0)
      )
    assertNotEquals(0L, terminal)

    try {
      val output = StringBuilder(300_000)
      for (index in 1..12_000) {
        output.append("T3-SCROLLBACK-")
        output.append(index.toString().padStart(5, '0'))
        output.append("\r\n")
      }
      output.append("T3-END\r\n")
      GhosttyBridge.nativeFeed(terminal, output.toString().toByteArray(Charsets.UTF_8))

      assertTrue(GhosttyBridge.nativeSelectAll(terminal))
      val selectedBytes = GhosttyBridge.nativeGetSelectionText(terminal)
      assertNotNull(selectedBytes)
      val retainedMarkers =
        String(requireNotNull(selectedBytes), Charsets.UTF_8)
          .lineSequence()
          .count { it.startsWith("T3-SCROLLBACK-") }
      Log.i("T3GhosttyScrollbackTest", "retainedMarkers=$retainedMarkers")

      // The upstream standard page holds 215 rows. This bound proves that the
      // line limit is active and that the 10,000-byte library default was
      // replaced, while allowing only one page of pruning approximation.
      assertTrue(
        "expected approximately 10,000 retained markers, found $retainedMarkers",
        abs(retainedMarkers - 10_000) <= 215
      )
    } finally {
      GhosttyBridge.nativeDestroy(terminal)
    }
  }
}
