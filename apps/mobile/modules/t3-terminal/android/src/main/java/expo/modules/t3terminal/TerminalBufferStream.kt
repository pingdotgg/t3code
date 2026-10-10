package expo.modules.t3terminal

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class TerminalBufferWriteRecord : Record {
  @Field var generation: Int = 0

  @Field var offset: Long = 0

  @Field var data: String = ""
}

/** Retains the acknowledged stream for native surface rebuilds; overlapping commits feed only new data. */
internal class TerminalBufferStream {
  var generation = 0
    private set
  private val replay = ArrayDeque<StringBuilder>()
  private var retainedLength = 0
  var offset: Long = 0
    private set
  val buffer: String get() = replay.joinToString("")

  data class Update(val reset: Boolean, val data: String)

  fun apply(write: TerminalBufferWriteRecord): Update? {
    val reset = write.generation > generation
    val accepted = when {
      write.generation < generation -> false
      write.offset < 0 -> false
      reset -> write.offset == 0L
      else -> write.offset <= offset && write.data.length.toLong() > offset - write.offset
    }
    if (!accepted) return null
    if (reset) {
      generation = write.generation
      replay.clear()
      retainedLength = 0
      offset = 0
    }
    val suffix = write.data.substring((offset - write.offset).toInt())
    offset += suffix.length
    appendReplay(suffix)
    return Update(reset, suffix)
  }

  private fun appendReplay(data: String) {
    var start = 0
    while (start < data.length) {
      val tail = replay.lastOrNull()?.takeIf { it.length < 16383 }
        ?: StringBuilder().also { replay.addLast(it) }
      var end = (start + 16384 - tail.length).coerceAtMost(data.length)
      if (end < data.length && Character.isHighSurrogate(data[end - 1])) end--
      tail.append(data, start, end)
      retainedLength += end - start
      start = end
    }
    while (retainedLength > 512 * 1024) retainedLength -= replay.removeFirst().length
  }
}
