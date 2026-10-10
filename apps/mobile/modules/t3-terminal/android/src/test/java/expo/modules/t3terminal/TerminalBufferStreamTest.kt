package expo.modules.t3terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalBufferStreamTest {
  private fun write(generation: Int, offset: Int, data: String) = TerminalBufferWriteRecord().also {
    it.generation = generation
    it.offset = offset.toLong()
    it.data = data
  }

  @Test fun consumesOverlappingCommitsOnceUsingUtf16Offsets() {
    val stream = TerminalBufferStream()
    assertEquals(TerminalBufferStream.Update(true, "a🌍"), stream.apply(write(1, 0, "a🌍")))
    assertEquals(TerminalBufferStream.Update(false, "é"), stream.apply(write(1, 0, "a🌍é")))
    assertNull(stream.apply(write(1, 0, "a🌍")))
    assertNull(stream.apply(write(1, 3, "é")))
    assertEquals("a🌍é", stream.buffer)
    assertEquals(5L, stream.offset)
  }

  @Test fun acceptsSkippedCommitsAndRejectsGaps() {
    val stream = TerminalBufferStream()
    stream.apply(write(1, 0, "a"))
    assertNull(stream.apply(write(1, 2, "missing")))
    assertEquals(TerminalBufferStream.Update(false, "bc"), stream.apply(write(1, 0, "abc")))
    assertEquals("abc", stream.buffer)
  }

  @Test fun clearsAndReplacesHistoryWithoutAcceptingStaleOutput() {
    val stream = TerminalBufferStream()
    stream.apply(write(1, 0, "old output"))
    assertEquals(TerminalBufferStream.Update(true, ""), stream.apply(write(2, 0, "")))
    assertNull(stream.apply(write(1, 0, "late old output")))
    assertNull(stream.apply(write(3, 1, "gap")))
    assertEquals(TerminalBufferStream.Update(false, "new"), stream.apply(write(2, 0, "new")))
    assertEquals(
      TerminalBufferStream.Update(true, "replacement"),
      stream.apply(write(3, 0, "replacement"))
    )
    assertEquals("replacement", stream.buffer)
  }

  @Test fun boundsReplayWhileContinuingTheAbsoluteCursor() {
    val stream = TerminalBufferStream()
    stream.apply(write(1, 0, "x".repeat(512 * 1024)))
    repeat(1000) {
      val write = TerminalBufferWriteRecord().also {
        it.generation = 1
        it.offset = stream.offset
        it.data = "🌍".repeat(256)
      }
      assertFalse(stream.apply(write)!!.reset)
    }
    assertTrue(stream.buffer.length <= 512 * 1024)
    assertEquals(512L * 1024 + 1000L * 512, stream.offset)
    assertTrue(stream.buffer.endsWith("🌍"))
  }
}
