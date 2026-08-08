package expo.modules.t3agentliveupdate

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

internal class LiveUpdateSnapshot : Record {
  @Field
  val title: String = ""

  @Field
  val summary: String = ""

  @Field
  val lines: List<String> = emptyList()

  @Field
  val shortCriticalText: String = ""
}
