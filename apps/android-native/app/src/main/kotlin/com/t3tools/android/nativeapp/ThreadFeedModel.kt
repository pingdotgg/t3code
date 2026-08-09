package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ChatMessage
import com.t3tools.android.protocol.LatestTurn
import com.t3tools.android.protocol.ThreadActivity
import com.t3tools.android.protocol.ThreadDetail
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal sealed interface ThreadFeedItem {
  val id: String
  val createdAt: String

  data class Message(val message: ChatMessage) : ThreadFeedItem {
    override val id = message.id
    override val createdAt = message.createdAt
  }

  data class ActivityGroup(
    override val id: String,
    override val createdAt: String,
    val turnId: String?,
    val activities: List<ThreadFeedActivity>,
  ) : ThreadFeedItem

  data class TurnFold(
    override val id: String,
    override val createdAt: String,
    val turnId: String,
    val label: String,
    val expanded: Boolean,
  ) : ThreadFeedItem

  data class WorkToggle(
    override val id: String,
    override val createdAt: String,
    val groupId: String,
    val hiddenCount: Int,
    val expanded: Boolean,
  ) : ThreadFeedItem

  data class Working(override val createdAt: String) : ThreadFeedItem {
    override val id = "working-indicator-row"
  }
}

internal enum class ThreadFeedActivityStatus { Success, Failure, Neutral }

internal data class ThreadFeedActivity(
  val id: String,
  val createdAt: String,
  val turnId: String?,
  val summary: String,
  val detail: String?,
  val canExpand: Boolean,
  val getFullDetail: () -> String?,
  val toolLike: Boolean,
  val status: ThreadFeedActivityStatus?,
)

internal fun buildThreadFeed(detail: ThreadDetail): List<ThreadFeedItem> {
  val raw = buildList<ThreadFeedItem> {
    detail.messages.forEach { add(ThreadFeedItem.Message(it)) }
    deriveWorkActivities(detail.activities).forEach { activity ->
      add(
        ThreadFeedItem.ActivityGroup(
          id = activity.id,
          createdAt = activity.createdAt,
          turnId = activity.turnId,
          activities = listOf(activity),
        ),
      )
    }
  }.sortedWith(compareBy<ThreadFeedItem>({ parseTime(it.createdAt) }, { it.createdAt }, { it.id }))

  val grouped = mutableListOf<ThreadFeedItem>()
  var openActivities: MutableList<ThreadFeedActivity>? = null
  var openTurnId: String? = null
  raw.forEach { entry ->
    if (entry is ThreadFeedItem.Message && entry.message.text.isBlank() && entry.message.attachments.isEmpty()) {
      return@forEach
    }
    if (
      entry is ThreadFeedItem.ActivityGroup &&
      openActivities != null &&
      openTurnId == entry.turnId
    ) {
      requireNotNull(openActivities).addAll(entry.activities)
    } else {
      grouped += entry
      if (entry is ThreadFeedItem.ActivityGroup) {
        openActivities = entry.activities.toMutableList()
        openTurnId = entry.turnId
        grouped[grouped.lastIndex] = entry.copy(activities = requireNotNull(openActivities))
      } else {
        openActivities = null
        openTurnId = null
      }
    }
  }
  return grouped
}

internal fun presentThreadFeed(
  feed: List<ThreadFeedItem>,
  latestTurn: LatestTurn?,
  expandedTurnIds: Set<String>,
  expandedWorkGroupIds: Set<String> = emptySet(),
  activeWorkStartedAt: String? = null,
): List<ThreadFeedItem> {
  val source = feed.filterNot {
    it is ThreadFeedItem.TurnFold || it is ThreadFeedItem.WorkToggle || it is ThreadFeedItem.Working
  }
  val folds = deriveTurnFolds(source, latestTurn)
  val hiddenIds = folds.values
    .filterNot { it.turnId in expandedTurnIds }
    .flatMapTo(mutableSetOf()) { it.hiddenIds }

  return buildList {
    source.forEach { entry ->
      folds[entry.id]?.let { fold ->
        add(
          ThreadFeedItem.TurnFold(
            id = "turn-fold:${fold.turnId}",
            createdAt = fold.createdAt,
            turnId = fold.turnId,
            label = fold.label,
            expanded = fold.turnId in expandedTurnIds,
          ),
        )
      }
      if (entry.id !in hiddenIds) appendPresentedEntry(entry, expandedWorkGroupIds)
    }
    activeWorkStartedAt?.let { add(ThreadFeedItem.Working(it)) }
  }
}

private fun MutableList<ThreadFeedItem>.appendPresentedEntry(
  entry: ThreadFeedItem,
  expandedWorkGroupIds: Set<String>,
) {
  if (entry !is ThreadFeedItem.ActivityGroup) {
    add(entry)
    return
  }
  val activities = entry.activities.filterNot {
    it.toolLike && it.status == ThreadFeedActivityStatus.Neutral
  }
  if (activities.isEmpty()) return
  if (activities.size == 1) {
    add(entry.copy(activities = activities))
    return
  }

  val expanded = entry.id in expandedWorkGroupIds
  val visible = if (expanded) activities else activities.takeLast(1)
  visible.forEach { activity ->
    add(
      ThreadFeedItem.ActivityGroup(
        id = activity.id,
        createdAt = activity.createdAt,
        turnId = activity.turnId,
        activities = listOf(activity),
      ),
    )
  }
  add(
    ThreadFeedItem.WorkToggle(
      id = "work-toggle:${entry.id}",
      createdAt = entry.createdAt,
      groupId = entry.id,
      hiddenCount = activities.size - 1,
      expanded = expanded,
    ),
  )
}

private data class TurnFold(
  val turnId: String,
  val createdAt: String,
  val hiddenIds: Set<String>,
  val label: String,
)

private fun deriveTurnFolds(
  feed: List<ThreadFeedItem>,
  latestTurn: LatestTurn?,
): Map<String, TurnFold> {
  val terminalByTurn = mutableMapOf<String, String>()
  feed.forEach { entry ->
    if (entry is ThreadFeedItem.Message && entry.message.role == "assistant") {
      entry.message.turnId?.let { terminalByTurn[it] = entry.id }
    }
  }

  data class TurnGroup(val entries: MutableList<ThreadFeedItem>, val startBoundary: String?)
  val groups = linkedMapOf<String, TurnGroup>()
  var userBoundary: String? = null
  feed.forEach { entry ->
    if (entry is ThreadFeedItem.Message && entry.message.role == "user") {
      userBoundary = entry.createdAt
      return@forEach
    }
    val turnId = when (entry) {
      is ThreadFeedItem.Message -> entry.message.turnId.takeIf { entry.message.role == "assistant" }
      is ThreadFeedItem.ActivityGroup -> entry.turnId
      else -> null
    } ?: return@forEach
    val group = groups.getOrPut(turnId) {
      TurnGroup(mutableListOf(), userBoundary).also { userBoundary = null }
    }
    group.entries += entry
  }

  val unsettledTurnId = latestTurn?.takeUnless {
    it.completedAt != null && it.state != "running"
  }?.id
  return buildMap {
    groups.forEach { (turnId, group) ->
      if (turnId == unsettledTurnId) return@forEach
      if (group.entries.any { it is ThreadFeedItem.Message && it.message.streaming }) return@forEach
      val terminalId = terminalByTurn[turnId]
      val hiddenIds = group.entries.mapNotNullTo(mutableSetOf()) { it.id.takeIf { id -> id != terminalId } }
      if (hiddenIds.isEmpty()) return@forEach
      val first = group.entries.first()
      val last = group.entries.last()
      val terminal = group.entries.filterIsInstance<ThreadFeedItem.Message>()
        .firstOrNull { it.id == terminalId }
      val start = if (latestTurn?.id == turnId) latestTurn.startedAt else group.startBoundary ?: first.createdAt
      val end = if (latestTurn?.id == turnId) latestTurn.completedAt else {
        maxTimestamp(terminal?.message?.updatedAt, entryEnd(last))
      }
      val duration = elapsedMillis(start, end)?.let(::formatDuration)
      val interrupted = latestTurn?.id == turnId && latestTurn.state == "interrupted"
      val label = when {
        interrupted && duration != null -> "You stopped after $duration"
        interrupted -> "You stopped this response"
        duration != null -> "Worked for $duration"
        else -> "Worked"
      }
      put(first.id, TurnFold(turnId, first.createdAt, hiddenIds, label))
    }
  }
}

private fun deriveWorkActivities(activities: List<ThreadActivity>): List<ThreadFeedActivity> {
  val ordered = activities.sortedWith(
    compareBy<ThreadActivity>(
      { it.sequence ?: Long.MAX_VALUE },
      { parseTime(it.createdAt) },
      { lifecycleRank(it.kind) },
      { it.id },
    ),
  )
  val collapsed = mutableListOf<DerivedActivity>()
  val taskIndexes = mutableMapOf<String, Int>()
  ordered.forEach { activity ->
    if (shouldHide(activity)) return@forEach
    val next = activity.toDerivedActivity()
    if (next.taskId != null && activity.kind in taskLifecycleKinds) {
      val index = taskIndexes[next.taskId]
      if (index == null) {
        taskIndexes[next.taskId] = collapsed.size
        collapsed += next
      } else {
        collapsed[index] = collapsed[index].merge(next)
      }
      return@forEach
    }
    val previous = collapsed.lastOrNull()
    if (
      previous != null &&
      previous.kind == "tool.updated" &&
      next.kind in setOf("tool.updated", "tool.completed") &&
      previous.collapseKey != null &&
      previous.collapseKey == next.collapseKey
    ) {
      collapsed[collapsed.lastIndex] = previous.merge(next)
    } else {
      collapsed += next
    }
  }
  return collapsed.map(DerivedActivity::toFeedActivity)
}

private data class DerivedActivity(
  val source: ThreadActivity,
  val summary: String,
  val detail: String?,
  val itemType: String?,
  val statusText: String?,
  val taskId: String?,
  val collapseKey: String?,
) {
  val kind get() = source.kind

  fun merge(next: DerivedActivity) = next.copy(
    detail = next.detail ?: detail,
    itemType = next.itemType ?: itemType,
    statusText = next.statusText ?: statusText,
    taskId = next.taskId ?: taskId,
    collapseKey = next.collapseKey ?: collapseKey,
  )

  fun toFeedActivity(): ThreadFeedActivity {
    val toolLike = source.tone in setOf("tool", "thinking", "error") ||
      itemType != null || source.kind.startsWith("tool.")
    val failed = source.tone == "error" || statusText in setOf("failed", "declined") ||
      detail.orEmpty().lowercase().let {
        "command not found" in it || "no such file" in it || "enoent" in it ||
          Regex("exit(?:ed)? with exit code\\s+[1-9]\\d*").containsMatchIn(it)
      }
    val inProgress = statusText in setOf("inProgress", "running", "started") || source.kind == "tool.updated"
    val canExpand = when (val payload = source.payload) {
      JsonNull -> false
      is JsonObject -> payload.isNotEmpty()
      else -> true
    }
    val fullDetail by lazy {
      source.payload.toString().takeUnless { it == "{}" || it == "null" }
    }
    return ThreadFeedActivity(
      id = source.id,
      createdAt = source.createdAt,
      turnId = source.turnId,
      summary = summary,
      detail = detail,
      canExpand = canExpand || detail != null,
      getFullDetail = { fullDetail },
      toolLike = toolLike,
      status = when {
        !toolLike -> null
        failed -> ThreadFeedActivityStatus.Failure
        inProgress -> ThreadFeedActivityStatus.Neutral
        else -> ThreadFeedActivityStatus.Success
      },
    )
  }
}

private fun ThreadActivity.toDerivedActivity(): DerivedActivity {
  val payload = payload as? JsonObject
  val itemType = payload.string("itemType") ?: payload.obj("data").string("itemType")
  val title = payload.string("title") ?: payload.obj("data").string("title") ?: summary
  val normalizedSummary = title.replace(Regex("\\s+(?:complete|completed)$", RegexOption.IGNORE_CASE), "")
    .trim().replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
  val detail = payload.string("detail") ?: payload.obj("data").string("detail") ?: findString(payload, "command")
  val status = payload.string("status") ?: payload.obj("data").string("status")
  val taskId = payload.string("taskId")
  val collapseKey = if (kind in setOf("tool.updated", "tool.completed")) {
    listOf(itemType.orEmpty(), normalizedSummary, detail.orEmpty()).joinToString("\u001f")
      .takeIf { it.isNotBlank() }
  } else null
  return DerivedActivity(this, normalizedSummary, detail, itemType, status, taskId, collapseKey)
}

private val taskLifecycleKinds = setOf("task.progress", "task.completed", "task.updated")
private val terminalTaskStatuses = setOf("idle", "completed", "failed", "cancelled", "interrupted")

private fun shouldHide(activity: ThreadActivity): Boolean {
  val payload = activity.payload as? JsonObject
  if (activity.kind in setOf("tool.started", "task.started", "tool.progress", "context-window.updated")) return true
  if (activity.kind == "task.updated" && !(payload.bool("timelineBypass") && payload.string("status") in terminalTaskStatuses)) return true
  if (activity.summary == "Checkpoint captured") return true
  if (activity.kind in setOf("tool.updated", "tool.completed") && payload.string("detail")?.startsWith("ExitPlanMode:") == true) return true
  val terminalTask = activity.kind == "task.completed" ||
    (activity.kind == "task.updated" && payload.string("status") in terminalTaskStatuses)
  if (payload.bool("timelineBypass") && !terminalTask) return true
  val agentOwned = !payload.string("agentId").isNullOrBlank()
  return agentOwned && !(terminalTask && payload.string("agentKind") == "agent")
}

private fun lifecycleRank(kind: String) = when {
  kind.endsWith(".started") -> 0
  kind.endsWith(".completed") || kind.endsWith(".resolved") -> 2
  else -> 1
}

private fun JsonObject?.string(key: String): String? =
  (this?.get(key) as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

private fun JsonObject?.bool(key: String): Boolean =
  ((this?.get(key) as? JsonPrimitive)?.booleanOrNull == true)

private fun JsonObject?.obj(key: String): JsonObject? = this?.get(key) as? JsonObject

private fun findString(element: JsonElement?, key: String, depth: Int = 0): String? {
  if (element !is JsonObject || depth > 3) return null
  element.string(key)?.let { return it }
  return element.values.firstNotNullOfOrNull { findString(it, key, depth + 1) }
}

private fun parseTime(value: String): Long = runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(Long.MAX_VALUE)

private fun entryEnd(entry: ThreadFeedItem) =
  (entry as? ThreadFeedItem.Message)?.message?.updatedAt ?: entry.createdAt

private fun maxTimestamp(first: String?, second: String?): String? = when {
  first == null -> second
  second == null -> first
  parseTime(first) >= parseTime(second) -> first
  else -> second
}

private fun elapsedMillis(start: String?, end: String?): Long? {
  if (start == null || end == null) return null
  val startMs = parseTime(start)
  val endMs = parseTime(end)
  if (startMs == Long.MAX_VALUE || endMs == Long.MAX_VALUE) return null
  return (endMs - startMs).coerceAtLeast(0)
}

private fun formatDuration(milliseconds: Long): String {
  val seconds = (milliseconds / 1_000).coerceAtLeast(1)
  if (seconds < 60) return "${seconds}s"
  val minutes = seconds / 60
  val remainder = seconds % 60
  return if (remainder == 0L) "${minutes}m" else "${minutes}m ${remainder}s"
}
