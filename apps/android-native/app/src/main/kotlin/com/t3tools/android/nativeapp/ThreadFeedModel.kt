package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ChatMessage
import com.t3tools.android.protocol.LatestTurn
import com.t3tools.android.protocol.ThreadActivity
import com.t3tools.android.protocol.ThreadDetail
import com.t3tools.android.protocol.ThreadSession
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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

  data class Plan(
    override val id: String,
    override val createdAt: String,
    val updatedAt: String,
    val turnId: String?,
    val steps: List<ThreadPlanStep>,
  ) : ThreadFeedItem {
    val currentStepLabel: String
      get() = steps.firstOrNull { it.status == ThreadPlanStepStatus.InProgress }?.step
        ?: steps.firstOrNull { it.status == ThreadPlanStepStatus.Pending }?.step
        ?: steps.lastOrNull()?.step
        ?: "Plan"
  }

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
    val onlyToolActivities: Boolean,
    val expanded: Boolean,
  ) : ThreadFeedItem

  data class Working(
    override val createdAt: String,
    val stepLabel: String?,
  ) : ThreadFeedItem {
    override val id = "working-indicator-row"
  }
}

internal enum class ThreadPlanStepStatus { Pending, InProgress, Completed }

internal data class ThreadPlanStep(
  val step: String,
  val status: ThreadPlanStepStatus,
)

internal data class ActiveWorkPresentation(
  val startedAt: String,
  val turn: LatestTurn?,
)

internal fun deriveActiveWorkPresentation(
  latestTurn: LatestTurn?,
  session: ThreadSession?,
): ActiveWorkPresentation? {
  if (session?.status != "starting" && session?.status != "running") return null
  val activeTurn = latestTurn?.takeIf { turn ->
    session.status == "running" && (
      session.activeTurnId?.let { it == turn.id }
        ?: (turn.state == "running" || turn.completedAt == null)
      )
  }
  val startedAt = activeTurn?.startedAt ?: session.updatedAt ?: return null
  return ActiveWorkPresentation(startedAt, activeTurn)
}

internal enum class ThreadFeedActivityStatus { Success, Failure, Neutral }

internal enum class ThreadFeedActivityIcon {
  Agent,
  Check,
  Command,
  Edit,
  Eye,
  Globe,
  Message,
  Warning,
  Wrench,
  Generic,
}

internal data class ThreadFeedActivity(
  val id: String,
  val createdAt: String,
  val turnId: String?,
  val summary: String,
  val detail: String?,
  val expandedBody: String?,
  val icon: ThreadFeedActivityIcon,
  val toolLike: Boolean,
  val status: ThreadFeedActivityStatus?,
) {
  val canExpand get() = expandedBody != null
}

internal fun buildThreadFeed(detail: ThreadDetail): List<ThreadFeedItem> {
  val raw = buildList<ThreadFeedItem> {
    detail.messages.forEach { add(ThreadFeedItem.Message(it)) }
    addAll(deriveTurnPlans(detail.activities))
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
  activeWorkTurn: LatestTurn? = latestTurn,
): List<ThreadFeedItem> {
  val source = feed.filterNot {
    it is ThreadFeedItem.TurnFold || it is ThreadFeedItem.WorkToggle || it is ThreadFeedItem.Working
  }
  val latestPlanId = source.filterIsInstance<ThreadFeedItem.Plan>()
    .maxWithOrNull(compareBy<ThreadFeedItem.Plan>({ parseTime(it.updatedAt) }, { it.id }))
    ?.id
  val folds = deriveTurnFolds(source, latestTurn, setOfNotNull(latestPlanId))
  val hiddenIds = folds.values
    .filterNot { it.turnId in expandedTurnIds }
    .flatMapTo(mutableSetOf()) { it.hiddenIds }
  val activeStepLabel = activeWorkTurn?.id?.let { turnId ->
    source.filterIsInstance<ThreadFeedItem.Plan>()
      .lastOrNull { it.turnId == turnId }
      ?.currentStepLabel
  }

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
    activeWorkStartedAt?.let { add(ThreadFeedItem.Working(it, activeStepLabel)) }
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
      onlyToolActivities = activities.all(ThreadFeedActivity::toolLike),
      expanded = expanded,
    ),
  )
}

internal fun workToggleLabel(toggle: ThreadFeedItem.WorkToggle): String {
  val singular = toggle.hiddenCount == 1
  val noun = if (toggle.onlyToolActivities) {
    if (singular) "tool call" else "tool calls"
  } else {
    if (singular) "log entry" else "log entries"
  }
  return if (toggle.expanded) {
    "Show fewer ${if (toggle.onlyToolActivities) "tool calls" else "log entries"}"
  } else {
    "+${toggle.hiddenCount} previous $noun"
  }
}

internal fun formatWorkingTimer(startIso: String, endIso: String): String? {
  val startedAt = runCatching { Instant.parse(startIso).toEpochMilli() }.getOrNull() ?: return null
  val endedAt = runCatching { Instant.parse(endIso).toEpochMilli() }.getOrNull() ?: return null
  val elapsedSeconds = ((endedAt - startedAt).coerceAtLeast(0L)) / 1_000
  if (elapsedSeconds < 60) return "${elapsedSeconds}s"
  val hours = elapsedSeconds / 3_600
  val minutes = (elapsedSeconds % 3_600) / 60
  val seconds = elapsedSeconds % 60
  if (hours > 0) return if (minutes > 0) "${hours}h ${minutes}m" else "${hours}h"
  return if (seconds > 0) "${minutes}m ${seconds}s" else "${minutes}m"
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
  alwaysVisibleIds: Set<String>,
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
      is ThreadFeedItem.Plan -> entry.turnId
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
      val hiddenIds = group.entries.mapNotNullTo(mutableSetOf()) {
        it.id.takeIf { id -> id != terminalId && id !in alwaysVisibleIds }
      }
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
  val collapsed = mutableListOf<DerivedActivity>()
  val taskIndexes = mutableMapOf<String, Int>()
  orderedActivities(activities).forEach { activity ->
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

private fun deriveTurnPlans(activities: List<ThreadActivity>): List<ThreadFeedItem.Plan> {
  val plans = linkedMapOf<String, ThreadFeedItem.Plan>()
  orderedActivities(activities).forEach { activity ->
    if (activity.kind != "turn.plan.updated") return@forEach
    val key = activity.turnId ?: "no-turn"
    val steps = (activity.payload as? JsonObject)
      ?.array("plan")
      .orEmpty()
      .mapNotNull { value ->
        val step = value as? JsonObject ?: return@mapNotNull null
        val label = step.string("step") ?: return@mapNotNull null
        ThreadPlanStep(
          step = label,
          status = when (step.string("status")) {
            "completed" -> ThreadPlanStepStatus.Completed
            "inProgress" -> ThreadPlanStepStatus.InProgress
            else -> ThreadPlanStepStatus.Pending
          },
        )
      }
    if (steps.isEmpty()) {
      plans.remove(key)
      return@forEach
    }
    val existing = plans[key]
    plans[key] = ThreadFeedItem.Plan(
      id = "turn-plan:$key",
      createdAt = existing?.createdAt ?: activity.createdAt,
      updatedAt = activity.createdAt,
      turnId = activity.turnId,
      steps = steps,
    )
  }
  return plans.values.toList()
}

private fun orderedActivities(activities: List<ThreadActivity>) = activities.sortedWith(
  compareBy<ThreadActivity>(
    { it.sequence ?: Long.MAX_VALUE },
    { parseTime(it.createdAt) },
    { lifecycleRank(it.kind) },
    { it.id },
  ),
)

private data class DerivedActivity(
  val source: ThreadActivity,
  val summary: String,
  val detail: String?,
  val itemType: String?,
  val statusText: String?,
  val taskId: String?,
  val collapseKey: String?,
  val command: String?,
  val rawCommand: String?,
  val changedFiles: List<String>,
  val toolData: JsonElement?,
  val requestKind: String?,
) {
  val kind get() = source.kind

  fun merge(next: DerivedActivity) = next.copy(
    detail = next.detail ?: detail,
    itemType = next.itemType ?: itemType,
    statusText = next.statusText ?: statusText,
    taskId = next.taskId ?: taskId,
    collapseKey = next.collapseKey ?: collapseKey,
    command = next.command ?: command,
    rawCommand = next.rawCommand ?: rawCommand,
    changedFiles = (changedFiles + next.changedFiles).distinct(),
    toolData = next.toolData ?: toolData,
    requestKind = next.requestKind ?: requestKind,
  )

  fun toFeedActivity(): ThreadFeedActivity {
    val toolLike = source.tone in setOf("tool", "thinking", "error") ||
      itemType != null || source.kind.startsWith("tool.")
    val failed = source.tone == "error" || statusText in setOf("failed", "declined") ||
      toolDetailTextLooksLikeFailure(detail.orEmpty())
    val inProgress = statusText in setOf("inProgress", "running", "started") || source.kind == "tool.updated"
    val preview = command ?: detail ?: changedFiles.firstOrNull()?.let { first ->
      if (changedFiles.size == 1) first else "$first +${changedFiles.size - 1} more"
    }
    val expandedBody = buildList {
      if (itemType == "mcp_tool_call" && toolData != null) {
        add("MCP call\n${prettyJson.encodeToString(JsonElement.serializer(), toolData)}")
      }
      add(rawCommand ?: command)
      add(detail)
      if (changedFiles.isNotEmpty()) add(changedFiles.joinToString("\n"))
    }.filterNotNull().map(String::trim).filter(String::isNotEmpty).distinct()
      .joinToString("\n\n").ifEmpty { null }
    return ThreadFeedActivity(
      id = source.id,
      createdAt = source.createdAt,
      turnId = source.turnId,
      summary = summary,
      detail = preview,
      expandedBody = expandedBody,
      icon = activityIcon(source, itemType, requestKind, command, changedFiles),
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

private fun toolDetailTextLooksLikeFailure(text: String): Boolean {
  val normalized = text.lowercase()
  return "command not found" in normalized ||
    "no such file" in normalized ||
    "enoent" in normalized ||
    "is not recognized as the name of a cmdlet" in normalized ||
    "a parameter cannot be found that matches parameter name" in normalized ||
    Regex("exit(?:ed)? with exit code\\s+[1-9]\\d*").containsMatchIn(normalized)
}

private fun ThreadActivity.toDerivedActivity(): DerivedActivity {
  val payload = payload as? JsonObject
  val itemType = payload.string("itemType") ?: payload.obj("data").string("itemType")
  val title = payload.string("title") ?: payload.obj("data").string("title") ?: summary
  val normalizedSummary = title.replace(Regex("\\s+(?:complete|completed)$", RegexOption.IGNORE_CASE), "")
    .trim().replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
  val command = extractCommand(payload)
  val detail = payload.string("detail")?.let(::stripTrailingExitCode)
    ?.takeUnless { normalizePreview(it) == normalizePreview(title) }
  val status = payload.string("status") ?: payload.obj("data").string("status")
  val taskId = payload.string("taskId")
  val changedFiles = extractChangedFiles(payload)
  val toolData = if (itemType == "mcp_tool_call") payload.obj("data")?.get("item") else null
  val requestKind = payload.string("requestKind") ?: when (payload.string("requestType")) {
    "command_execution_approval", "exec_command_approval" -> "command"
    "file_read_approval" -> "file-read"
    "file_change_approval", "apply_patch_approval" -> "file-change"
    else -> null
  }
  val collapseKey = if (kind in setOf("tool.updated", "tool.completed")) {
    listOf(itemType.orEmpty(), normalizedSummary, detail.orEmpty()).joinToString("\u001f")
      .takeIf { it.isNotBlank() }
  } else null
  return DerivedActivity(
    source = this,
    summary = normalizedSummary,
    detail = detail,
    itemType = itemType,
    statusText = status,
    taskId = taskId,
    collapseKey = collapseKey,
    command = command?.normalized,
    rawCommand = command?.raw,
    changedFiles = changedFiles,
    toolData = toolData,
    requestKind = requestKind,
  )
}

private data class ToolCommand(val normalized: String, val raw: String?)

private fun extractCommand(payload: JsonObject?): ToolCommand? {
  val data = payload.obj("data")
  val item = data.obj("item")
  val candidates = listOf(
    item?.get("command"),
    item.obj("input")?.get("command"),
    item.obj("result")?.get("command"),
    data?.get("command"),
  )
  candidates.forEach { candidate ->
    val raw = formatCommand(candidate) ?: return@forEach
    val normalized = unwrapShellCommand(raw)
    return ToolCommand(normalized, raw.takeIf { it != normalized })
  }
  if (payload.string("itemType") == "command_execution") {
    val raw = payload.string("detail")?.let(::stripTrailingExitCode) ?: return null
    val normalized = unwrapShellCommand(raw)
    return ToolCommand(normalized, raw.takeIf { it != normalized })
  }
  return null
}

private fun formatCommand(value: JsonElement?): String? = when (value) {
  is JsonPrimitive -> value.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
  is JsonArray -> value.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    .takeIf(List<String>::isNotEmpty)
    ?.joinToString(" ") { part ->
      if (part.any(Char::isWhitespace)) "\"${part.replace("\"", "\\\"")}\"" else part
    }
  else -> null
}

private fun unwrapShellCommand(value: String): String {
  val wrapper = Regex(
    """^(?:\"[^\"]*(?:pwsh|powershell)(?:\.exe)?\"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+.*?-Command\s+(.+)$""",
    RegexOption.IGNORE_CASE,
  ).find(value)?.groupValues?.get(1)
    ?: Regex("""^(?:bash|zsh|sh)\s+-(?:l)?c\s+(.+)$""").find(value)?.groupValues?.get(1)
    ?: Regex("""^(?:cmd(?:\.exe)?)\s+/c\s+(.+)$""", RegexOption.IGNORE_CASE)
      .find(value)?.groupValues?.get(1)
    ?: return value
  return wrapper.trim().removeSurrounding("\"").removeSurrounding("'").trim()
}

private fun stripTrailingExitCode(value: String) = value.trim()
  .replace(Regex("""\s*<exited with exit code \d+>\s*$""", RegexOption.IGNORE_CASE), "")
  .trim()

private fun normalizePreview(value: String) = value.replace(Regex("\\s+"), " ")
  .replace(Regex("\\s+(?:complete|completed)$", RegexOption.IGNORE_CASE), "")
  .trim().lowercase()

private fun extractChangedFiles(payload: JsonObject?): List<String> {
  val files = linkedSetOf<String>()
  fun collect(value: JsonElement?, depth: Int) {
    if (depth > 4 || files.size >= 12) return
    when (value) {
      is JsonArray -> value.forEach { collect(it, depth + 1) }
      is JsonObject -> {
        listOf("path", "filePath", "relativePath", "filename", "newPath", "oldPath")
          .mapNotNull(value::string)
          .forEach(files::add)
        listOf("item", "result", "input", "data", "changes", "files", "edits", "patch", "patches", "operations")
          .forEach { collect(value[it], depth + 1) }
      }
      else -> Unit
    }
  }
  collect(payload.obj("data"), 0)
  return files.toList()
}

private fun activityIcon(
  activity: ThreadActivity,
  itemType: String?,
  requestKind: String?,
  command: String?,
  changedFiles: List<String>,
) = when {
  activity.kind in setOf("user-input.requested", "user-input.resolved") -> ThreadFeedActivityIcon.Message
  activity.kind == "runtime.warning" -> ThreadFeedActivityIcon.Warning
  requestKind == "command" -> ThreadFeedActivityIcon.Command
  requestKind == "file-read" -> ThreadFeedActivityIcon.Eye
  requestKind == "file-change" -> ThreadFeedActivityIcon.Edit
  itemType == "command_execution" || command != null -> ThreadFeedActivityIcon.Command
  itemType == "file_change" || changedFiles.isNotEmpty() -> ThreadFeedActivityIcon.Edit
  itemType == "web_search" -> ThreadFeedActivityIcon.Globe
  itemType == "image_view" -> ThreadFeedActivityIcon.Eye
  itemType == "mcp_tool_call" -> ThreadFeedActivityIcon.Wrench
  itemType in setOf("dynamic_tool_call", "collab_agent_tool_call") || activity.kind.startsWith("task.") -> ThreadFeedActivityIcon.Agent
  activity.tone == "error" -> ThreadFeedActivityIcon.Warning
  activity.tone == "info" -> ThreadFeedActivityIcon.Check
  else -> ThreadFeedActivityIcon.Generic
}

private val prettyJson = Json { prettyPrint = true }

private val taskLifecycleKinds = setOf("task.progress", "task.completed", "task.updated")
private val terminalTaskStatuses = setOf("idle", "completed", "failed", "cancelled", "interrupted")

private fun shouldHide(activity: ThreadActivity): Boolean {
  val payload = activity.payload as? JsonObject
  if (activity.kind == "turn.plan.updated") return true
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

private fun JsonObject?.array(key: String): JsonArray? = this?.get(key) as? JsonArray

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
