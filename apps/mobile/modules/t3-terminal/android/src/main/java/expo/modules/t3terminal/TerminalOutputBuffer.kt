package expo.modules.t3terminal

import java.util.ArrayDeque

private const val REPLAY_LIMIT = 512 * 1024
private const val REPLAY_CHUNK_SIZE = 16 * 1024

// Keep only replay history for intentional terminal recreation.
internal class TerminalOutputBuffer {
  private val chunks = ArrayDeque<ByteArray>()
  private var firstOffset = 0
  private var tailSize = 0
  private var size = 0

  // Only terminal recreation needs contiguous history; appends reuse the retained chunks.
  val data: ByteArray
    get() {
      val result = ByteArray(size)
      var destination = 0
      var start = firstOffset
      for (chunk in chunks) {
        val end = if (chunk === chunks.last) tailSize else chunk.size
        chunk.copyInto(result, destination, start, end)
        destination += end - start
        start = 0
      }
      return result
    }

  fun write(incoming: ByteArray, reset: Boolean) {
    if (reset || incoming.size >= REPLAY_LIMIT) clear()
    var start = maxOf(0, incoming.size - REPLAY_LIMIT)
    while (start < incoming.size && incoming[start].toInt() and 0xC0 == 0x80) start += 1
    while (start < incoming.size) {
      if (chunks.isEmpty() || tailSize == REPLAY_CHUNK_SIZE) {
        chunks.addLast(ByteArray(REPLAY_CHUNK_SIZE))
        tailSize = 0
      }
      val count = minOf(incoming.size - start, REPLAY_CHUNK_SIZE - tailSize)
      incoming.copyInto(chunks.last, tailSize, start, start + count)
      start += count
      tailSize += count
      size += count
    }
    discardPrefix(maxOf(0, size - REPLAY_LIMIT))
    while (size > 0 && chunks.first[firstOffset].toInt() and 0xC0 == 0x80) discardPrefix(1)
  }

  private fun discardPrefix(count: Int) {
    var remaining = count
    while (remaining > 0) {
      val end = if (chunks.size == 1) tailSize else chunks.first.size
      val discarded = minOf(remaining, end - firstOffset)
      firstOffset += discarded
      remaining -= discarded
      size -= discarded
      if (firstOffset == end) {
        chunks.removeFirst()
        firstOffset = 0
        if (chunks.isEmpty()) tailSize = 0
      }
    }
  }

  private fun clear() {
    chunks.clear()
    firstOffset = 0
    tailSize = 0
    size = 0
  }
}
