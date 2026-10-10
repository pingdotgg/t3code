package expo.modules.t3terminal

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalFrameTest {
  private fun packet(
    full: Boolean,
    rows: List<Pair<Int, String>>,
    cols: Int = 2,
    height: Int = 2,
    cursorX: Int = 0
  ): ByteArray {
    val bytes = ByteBuffer.allocate(4096).order(ByteOrder.LITTLE_ENDIAN)
    bytes.putInt(0x54563354).putShort(2).putShort(cols.toShort()).putShort(height.toShort())
    bytes.putShort(cursorX.toShort()).putShort(0).put(1).put(0).put(0).put(if (full) 1 else 0)
    bytes.putInt(0xFFEEEEEE.toInt()).putInt(0xFF000000.toInt()).putInt(0xFF00FFFF.toInt())
    bytes.putShort(rows.size.toShort())
    for ((row, text) in rows) {
      bytes.putShort(row.toShort())
      for (col in 0 until cols) {
        val utf8 = (if (col == 0) text else "").toByteArray(Charsets.UTF_8)
        bytes.putInt(
          0xFFEEEEEE.toInt()
        ).putInt(0xFF000000.toInt()).putShort(1).putShort(utf8.size.toShort())
        bytes.put(utf8)
      }
    }
    return bytes.array().copyOf(bytes.position())
  }

  @Test fun appliesPartialOutputWithoutLosingUnchangedRows() {
    val original = TerminalFrame.decode(packet(true, listOf(0 to "first", 1 to "old")))!!
    val changed = TerminalFrame.decode(packet(false, listOf(1 to "🌍é")), original)!!
    assertEquals("first", changed.cells[0].text[0])
    assertEquals("🌍é", changed.cells[1].text[0])
    assertEquals(1, changed.cells[1].flags[0])
    assertEquals("old", original.cells[1].text[0])
  }

  @Test fun updatesCursorWithoutCellChanges() {
    val original = TerminalFrame.decode(packet(true, listOf(0 to "first", 1 to "last")))!!
    val moved = TerminalFrame.decode(packet(false, emptyList(), cursorX = 1), original)!!
    assertEquals(1, moved.cursorX)
    assertEquals("first", moved.cells[0].text[0])
    assertEquals("last", moved.cells[1].text[0])
  }

  @Test fun requiresFullFrameOnFirstSnapshotAndResize() {
    assertNull(TerminalFrame.decode(packet(false, listOf(0 to "partial"))))
    val original = TerminalFrame.decode(packet(true, listOf(0 to "first", 1 to "last")))!!
    assertNull(TerminalFrame.decode(packet(false, listOf(0 to "resize"), cols = 3), original))
    val resized = TerminalFrame.decode(
      packet(true, listOf(0 to "resized"), cols = 3, height = 1),
      original
    )!!
    assertEquals(3, resized.cols)
    assertEquals(1, resized.rows)
    assertEquals("resized", resized.cells[0].text[0])
  }

  @Test fun rejectsMalformedPacketsWithoutReplacingPreviousOutput() {
    val original = TerminalFrame.decode(packet(true, listOf(0 to "first", 1 to "last")))!!
    for (bad in listOf(
      packet(false, listOf(2 to "outside")),
      packet(false, listOf(1 to "duplicate", 1 to "again")),
      packet(true, listOf(0 to "missing")),
      packet(false, listOf(1 to "truncated")).dropLast(1).toByteArray(),
      packet(false, listOf(1 to "trailing")) + byteArrayOf(1),
    )) {
      assertNull(TerminalFrame.decode(bad, original))
    }
    assertEquals("last", original.cells[1].text[0])
  }
}
