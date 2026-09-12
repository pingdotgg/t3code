package expo.modules.t3terminal

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * One incremental terminal write from JS: [seq] orders and deduplicates the
 * writes, [reset] clears the grid before [data] is fed.
 *
 * JS 侧的一次增量终端写入：[seq] 负责排序与去重，[reset] 表示喂入 [data]
 * 之前要先清屏。
 */
class TerminalBufferWriteRecord : Record {
  @Field
  var seq: Int = 0

  @Field
  var reset: Boolean = false

  @Field
  var data: String = ""
}
