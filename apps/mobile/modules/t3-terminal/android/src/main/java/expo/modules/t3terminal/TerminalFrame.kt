package expo.modules.t3terminal

import java.nio.ByteBuffer
import java.nio.ByteOrder

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
  val cellForegrounds: IntArray,
  val cellBackgrounds: IntArray,
  val cellFlags: IntArray,
  val cellText: Array<String>
) {
  companion object {
    private const val MAGIC = 0x54563354
    private const val VERSION = 1
    private const val HEADER_BYTES = 32
    private const val CELL_HEADER_BYTES = 12

    @Suppress("ReturnCount")
    fun decode(bytes: ByteArray): TerminalFrame? {
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
      buffer.get()
      val foreground = buffer.int
      val background = buffer.int
      val cursorColor = buffer.int
      val cellCount = cols * rows
      val foregrounds = IntArray(cellCount)
      val backgrounds = IntArray(cellCount)
      val flags = IntArray(cellCount)
      val text = Array(cellCount) { "" }

      for (index in 0 until cellCount) {
        if (buffer.remaining() < CELL_HEADER_BYTES) return null
        foregrounds[index] = buffer.int
        backgrounds[index] = buffer.int
        flags[index] = buffer.short.toInt() and 0xFFFF
        val textLength = buffer.short.toInt() and 0xFFFF
        if (buffer.remaining() < textLength) return null
        if (textLength > 0) {
          text[index] = String(bytes, buffer.position(), textLength, Charsets.UTF_8)
          buffer.position(buffer.position() + textLength)
        }
      }

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
        cellForegrounds = foregrounds,
        cellBackgrounds = backgrounds,
        cellFlags = flags,
        cellText = text,
      )
    }
  }
}
