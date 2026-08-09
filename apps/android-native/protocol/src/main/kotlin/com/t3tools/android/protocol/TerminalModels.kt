package com.t3tools.android.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

const val DEFAULT_TERMINAL_ID = "term-1"
const val DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024

enum class TerminalStatus(val wireValue: String) {
  Starting("starting"),
  Running("running"),
  Exited("exited"),
  Error("error"),
  Closed("closed"),
  ;

  companion object {
    fun fromWire(value: String) = entries.firstOrNull { it.wireValue == value }
      ?: error("Unknown terminal status: $value")
  }
}

data class TerminalSnapshot(
  val threadId: String,
  val terminalId: String,
  val cwd: String,
  val worktreePath: String?,
  val status: TerminalStatus,
  val pid: Int?,
  val history: String,
  val exitCode: Int?,
  val exitSignal: Int?,
  val label: String,
  val updatedAt: String,
  val sequence: Long?,
)

data class TerminalSummary(
  val threadId: String,
  val terminalId: String,
  val cwd: String,
  val worktreePath: String?,
  val status: TerminalStatus,
  val pid: Int?,
  val exitCode: Int?,
  val exitSignal: Int?,
  val hasRunningSubprocess: Boolean,
  val label: String,
  val updatedAt: String,
)

sealed interface TerminalMetadataEvent {
  data class Snapshot(val terminals: List<TerminalSummary>) : TerminalMetadataEvent
  data class Upsert(val terminal: TerminalSummary) : TerminalMetadataEvent
  data class Remove(val threadId: String, val terminalId: String) : TerminalMetadataEvent
}

sealed interface TerminalAttachEvent {
  data class Snapshot(val snapshot: TerminalSnapshot) : TerminalAttachEvent
  data class Output(val data: String) : TerminalAttachEvent
  data class Exited(val exitCode: Int?, val exitSignal: Int?) : TerminalAttachEvent
  data object Closed : TerminalAttachEvent
  data class Error(val message: String) : TerminalAttachEvent
  data object Cleared : TerminalAttachEvent
  data class Restarted(val snapshot: TerminalSnapshot) : TerminalAttachEvent
  data class Activity(val hasRunningSubprocess: Boolean, val label: String) : TerminalAttachEvent
}

data class TerminalBufferState(
  val buffer: String = "",
  val status: TerminalStatus = TerminalStatus.Closed,
  val error: String? = null,
  val updatedAt: String? = null,
  val version: Long = 0,
)

fun reduceTerminalBuffer(
  current: TerminalBufferState,
  event: TerminalAttachEvent,
  maxBufferBytes: Int = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState = when (event) {
  is TerminalAttachEvent.Snapshot -> event.snapshot.toBufferState(maxBufferBytes)
  is TerminalAttachEvent.Restarted -> event.snapshot.toBufferState(maxBufferBytes)
  is TerminalAttachEvent.Output -> current.copy(
    buffer = trimTerminalBuffer(current.buffer + event.data, maxBufferBytes),
    status = if (current.status == TerminalStatus.Closed) TerminalStatus.Running else current.status,
    error = null,
    version = current.version + 1,
  )
  TerminalAttachEvent.Cleared -> current.copy(
    buffer = "",
    error = null,
    version = current.version + 1,
  )
  is TerminalAttachEvent.Exited -> current.copy(
    status = TerminalStatus.Exited,
    error = null,
    version = current.version + 1,
  )
  TerminalAttachEvent.Closed -> current.copy(
    status = TerminalStatus.Closed,
    error = null,
    version = current.version + 1,
  )
  is TerminalAttachEvent.Error -> current.copy(
    status = TerminalStatus.Error,
    error = event.message,
    version = current.version + 1,
  )
  is TerminalAttachEvent.Activity -> current
}

fun reduceTerminalMetadata(
  current: List<TerminalSummary>,
  event: TerminalMetadataEvent,
): List<TerminalSummary> = when (event) {
  is TerminalMetadataEvent.Snapshot -> event.terminals
  is TerminalMetadataEvent.Remove -> current.filterNot {
    it.threadId == event.threadId && it.terminalId == event.terminalId
  }
  is TerminalMetadataEvent.Upsert -> current.filterNot {
    it.threadId == event.terminal.threadId && it.terminalId == event.terminal.terminalId
  } + event.terminal
}

fun nextTerminalId(ids: Collection<String>): String {
  val used = ids.mapNotNull { id ->
    id.takeIf { it.startsWith("term-") }?.removePrefix("term-")?.toIntOrNull()
  }.toSet()
  return "term-${generateSequence(1, Int::inc).first { it !in used }}"
}

internal fun terminalOpenPayload(
  threadId: String,
  terminalId: String,
  cwd: String,
  worktreePath: String?,
  cols: Int,
  rows: Int,
) = buildJsonObject(
  "threadId" to JsonPrimitive(threadId),
  "terminalId" to JsonPrimitive(terminalId),
  "cwd" to JsonPrimitive(cwd),
  "worktreePath" to (worktreePath?.let(::JsonPrimitive) ?: JsonNull),
  "cols" to JsonPrimitive(cols),
  "rows" to JsonPrimitive(rows),
)

internal fun terminalAttachPayload(
  threadId: String,
  terminalId: String,
  cwd: String,
  worktreePath: String?,
  cols: Int,
  rows: Int,
  restartIfNotRunning: Boolean,
) = buildJsonObject(
  "threadId" to JsonPrimitive(threadId),
  "terminalId" to JsonPrimitive(terminalId),
  "cwd" to JsonPrimitive(cwd),
  "worktreePath" to (worktreePath?.let(::JsonPrimitive) ?: JsonNull),
  "cols" to JsonPrimitive(cols),
  "rows" to JsonPrimitive(rows),
  "restartIfNotRunning" to JsonPrimitive(restartIfNotRunning),
)

internal fun terminalSessionPayload(threadId: String, terminalId: String) = buildJsonObject(
  "threadId" to JsonPrimitive(threadId),
  "terminalId" to JsonPrimitive(terminalId),
)

internal fun terminalWritePayload(threadId: String, terminalId: String, data: String) =
  buildJsonObject(
    "threadId" to JsonPrimitive(threadId),
    "terminalId" to JsonPrimitive(terminalId),
    "data" to JsonPrimitive(data),
  )

internal fun terminalResizePayload(
  threadId: String,
  terminalId: String,
  cols: Int,
  rows: Int,
) = buildJsonObject(
  "threadId" to JsonPrimitive(threadId),
  "terminalId" to JsonPrimitive(terminalId),
  "cols" to JsonPrimitive(cols),
  "rows" to JsonPrimitive(rows),
)

internal fun terminalRestartPayload(
  threadId: String,
  terminalId: String,
  cwd: String,
  worktreePath: String?,
  cols: Int,
  rows: Int,
) = terminalOpenPayload(threadId, terminalId, cwd, worktreePath, cols, rows)

internal fun JsonElement.toTerminalMetadataEvent(): TerminalMetadataEvent {
  val value = jsonObject
  return when (value.required("type").jsonPrimitive.content) {
    "snapshot" -> TerminalMetadataEvent.Snapshot(
      value.required("terminals").jsonArray.map(JsonElement::toTerminalSummary),
    )
    "upsert" -> TerminalMetadataEvent.Upsert(value.required("terminal").toTerminalSummary())
    "remove" -> TerminalMetadataEvent.Remove(
      value.required("threadId").jsonPrimitive.content,
      value.required("terminalId").jsonPrimitive.content,
    )
    else -> error("Unknown terminal metadata event: ${value["type"]}")
  }
}

internal fun JsonElement.toTerminalAttachEvent(): TerminalAttachEvent {
  val value = jsonObject
  return when (value.required("type").jsonPrimitive.content) {
    "snapshot" -> TerminalAttachEvent.Snapshot(value.required("snapshot").toTerminalSnapshot())
    "output" -> TerminalAttachEvent.Output(value.required("data").jsonPrimitive.content)
    "exited" -> TerminalAttachEvent.Exited(
      value.nullableInt("exitCode"),
      value.nullableInt("exitSignal"),
    )
    "closed" -> TerminalAttachEvent.Closed
    "error" -> TerminalAttachEvent.Error(value.required("message").jsonPrimitive.content)
    "cleared" -> TerminalAttachEvent.Cleared
    "restarted" -> TerminalAttachEvent.Restarted(value.required("snapshot").toTerminalSnapshot())
    "activity" -> TerminalAttachEvent.Activity(
      value.required("hasRunningSubprocess").jsonPrimitive.booleanOrNull == true,
      value.required("label").jsonPrimitive.content,
    )
    else -> error("Unknown terminal attach event: ${value["type"]}")
  }
}

internal fun JsonElement.toTerminalSnapshot(): TerminalSnapshot {
  val value = jsonObject
  return TerminalSnapshot(
    threadId = value.required("threadId").jsonPrimitive.content,
    terminalId = value.required("terminalId").jsonPrimitive.content,
    cwd = value.required("cwd").jsonPrimitive.content,
    worktreePath = value.nullableTerminalString("worktreePath"),
    status = TerminalStatus.fromWire(value.required("status").jsonPrimitive.content),
    pid = value.nullableInt("pid"),
    history = value.required("history").jsonPrimitive.content,
    exitCode = value.nullableInt("exitCode"),
    exitSignal = value.nullableInt("exitSignal"),
    label = value.required("label").jsonPrimitive.content,
    updatedAt = value.required("updatedAt").jsonPrimitive.content,
    sequence = value["sequence"]?.jsonPrimitive?.longOrNull,
  )
}

private fun JsonElement.toTerminalSummary(): TerminalSummary {
  val value = jsonObject
  return TerminalSummary(
    threadId = value.required("threadId").jsonPrimitive.content,
    terminalId = value.required("terminalId").jsonPrimitive.content,
    cwd = value.required("cwd").jsonPrimitive.content,
    worktreePath = value.nullableTerminalString("worktreePath"),
    status = TerminalStatus.fromWire(value.required("status").jsonPrimitive.content),
    pid = value.nullableInt("pid"),
    exitCode = value.nullableInt("exitCode"),
    exitSignal = value.nullableInt("exitSignal"),
    hasRunningSubprocess = value.required("hasRunningSubprocess").jsonPrimitive.booleanOrNull == true,
    label = value.required("label").jsonPrimitive.content,
    updatedAt = value.required("updatedAt").jsonPrimitive.content,
  )
}

private fun TerminalSnapshot.toBufferState(maxBufferBytes: Int) = TerminalBufferState(
  buffer = trimTerminalBuffer(history, maxBufferBytes),
  status = status,
  updatedAt = updatedAt,
  version = 1,
)

private fun trimTerminalBuffer(value: String, maxBytes: Int): String {
  if (maxBytes <= 0) return ""
  val bytes = value.toByteArray(Charsets.UTF_8)
  if (bytes.size <= maxBytes) return value
  var start = bytes.size - maxBytes
  while (start < bytes.size && bytes[start].toInt() and 0xC0 == 0x80) start += 1
  return String(bytes, start, bytes.size - start, Charsets.UTF_8)
}

private fun JsonObject.nullableTerminalString(name: String) = this[name]
  ?.takeUnless { it is JsonNull }
  ?.jsonPrimitive
  ?.content

private fun JsonObject.nullableInt(name: String) = this[name]
  ?.takeUnless { it is JsonNull }
  ?.jsonPrimitive
  ?.intOrNull
