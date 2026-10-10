package expo.modules.t3terminal

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal data class TerminalRow(
  val foregrounds: IntArray,
  val backgrounds: IntArray,
  val flags: IntArray,
  val text: Array<String>
)

internal data class TerminalFrame(
  val cols: Int,
  val rows: Int,
  val cursorX: Int,
  val cursorY: Int,
  val cursorVisible: Boolean,
  val cursorStyle: Int,
  val cursorBlinking: Boolean,
  val foreground: Int,
  val background: Int,
  val cursorColor: Int,
  val cells: Array<TerminalRow>,
  val dirtyRows: IntArray,
  val full: Boolean
) {
  companion object {
    private const val MAGIC = 0x54563354
    private const val VERSION = 2
    private const val HEADER_BYTES = 32
    private const val CELL_HEADER_BYTES = 12

    @Suppress("ReturnCount")
    fun decode(bytes: ByteArray, previous: TerminalFrame? = null): TerminalFrame? {
      if (bytes.size < HEADER_BYTES) return null
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      if (buffer.int != MAGIC || buffer.short.toInt() != VERSION) return null

      val cols = buffer.short.toInt() and 0xFFFF
      val rows = buffer.short.toInt() and 0xFFFF
      val cursorX = buffer.short.toInt() and 0xFFFF
      val cursorY = buffer.short.toInt() and 0xFFFF
      val cursorVisible = buffer.get().toInt() != 0
      val cursorStyle = buffer.get().toInt() and 0xFF
      val cursorBlinking = buffer.get().toInt() != 0
      val full = buffer.get().toInt() != 0
      val foreground = buffer.int
      val background = buffer.int
      val cursorColor = buffer.int
      if (cols !in 1..400 || rows !in 1..200) return null
      val count = buffer.short.toInt() and 0xFFFF
      val cells = prepareGrid(previous, cols, rows, count, full) ?: return null
      val dirtyRows = IntArray(count)
      val seen = BooleanArray(rows)
      for (entry in 0 until count) {
        if (buffer.remaining() < 2) return null
        val row = buffer.short.toInt() and 0xFFFF
        if (row >= rows || seen[row]) return null
        seen[row] = true
        dirtyRows[entry] = row
        cells[row] = decodeRow(buffer, cols) ?: return null
      }
      if (buffer.hasRemaining()) return null
      return TerminalFrame(
        cols = cols,
        rows = rows,
        cursorX = cursorX,
        cursorY = cursorY,
        cursorVisible = cursorVisible,
        cursorStyle = cursorStyle,
        cursorBlinking = cursorBlinking,
        foreground = foreground,
        background = background,
        cursorColor = cursorColor,
        cells = Array(rows) { cells[it] ?: return null },
        dirtyRows = dirtyRows,
        full = full,
      )
    }

    private fun prepareGrid(
      previous: TerminalFrame?,
      cols: Int,
      rows: Int,
      count: Int,
      full: Boolean
    ): Array<TerminalRow?>? {
      if (count > rows || (full && count != rows)) return null
      return when {
        full -> arrayOfNulls(rows)
        previous == null -> null
        previous.cols != cols || previous.rows != rows -> null
        else -> {
          val cells = arrayOfNulls<TerminalRow>(rows)
          previous.cells.copyInto(cells)
          cells
        }
      }
    }

    private fun decodeRow(buffer: ByteBuffer, cols: Int): TerminalRow? {
      val row = TerminalRow(IntArray(cols), IntArray(cols), IntArray(cols), Array(cols) { "" })
      for (col in 0 until cols) {
        if (!decodeCell(buffer, row, col)) return null
      }
      return row
    }

    private fun decodeCell(buffer: ByteBuffer, row: TerminalRow, col: Int): Boolean {
      if (buffer.remaining() < CELL_HEADER_BYTES) return false
      row.foregrounds[col] = buffer.int
      row.backgrounds[col] = buffer.int
      row.flags[col] = buffer.short.toInt() and 0xFFFF
      val length = buffer.short.toInt() and 0xFFFF
      return if (buffer.remaining() >= length) {
        if (length > 0) {
          row.text[col] = String(buffer.array(), buffer.position(), length, Charsets.UTF_8)
          buffer.position(buffer.position() + length)
        }
        true
      } else {
        false
      }
    }
  }
}
