package com.t3tools.android.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

fun ShellState.reduce(item: JsonObject): ShellState {
  return when (item.text("kind")) {
    "snapshot" -> (item.obj("snapshot") ?: return this).toShellState()
    "synchronized" -> copy(synchronized = true)
    "project-upserted" -> reduceShellEvent(item) { sequence ->
      val project = item.obj("project")?.toProject() ?: return@reduceShellEvent this
      copy(sequence = sequence, projects = projects + (project.id to project))
    }
    "project-removed" -> reduceShellEvent(item) { sequence ->
      val projectId = item.text("projectId") ?: return@reduceShellEvent this
      copy(sequence = sequence, projects = projects - projectId)
    }
    "thread-upserted" -> reduceShellEvent(item) { sequence ->
      val thread = item.obj("thread")?.toThreadSummary() ?: return@reduceShellEvent this
      copy(sequence = sequence, threads = threads + (thread.id to thread))
    }
    "thread-removed" -> reduceShellEvent(item) { sequence ->
      val threadId = item.text("threadId") ?: return@reduceShellEvent this
      copy(sequence = sequence, threads = threads - threadId)
    }
    else -> this
  }
}

private inline fun ShellState.reduceShellEvent(
  item: JsonObject,
  update: (Long) -> ShellState,
): ShellState {
  val next = item.long("sequence") ?: return this
  return if (next <= sequence) this else update(next)
}

fun ThreadState.reduce(item: JsonObject): ThreadState {
  return when (item.text("kind")) {
    "snapshot" -> {
      val snapshot = item.obj("snapshot") ?: return this
      val detail = snapshot.obj("thread")?.toThreadDetail() ?: return this
      copy(
        sequence = snapshot.long("snapshotSequence") ?: sequence,
        detail = detail,
        synchronized = false,
        page = snapshot.obj("page")?.let { page ->
          ThreadPage(
            beforeCursor = page.nullableText("beforeCursor"),
            hasMore = page.bool("hasMore") == true,
          )
        },
      )
    }
    "synchronized" -> copy(synchronized = true)
    "event" -> reduceThreadEvent(item.obj("event") ?: return this)
    else -> this
  }
}

private fun ThreadState.reduceThreadEvent(event: JsonObject): ThreadState {
  val next = event.long("sequence") ?: return this
  val current = detail ?: return this
  if (next <= sequence) return this
  val payload = event.obj("payload") ?: return copy(sequence = next)
  val updated = when (event.text("type")) {
    "thread.message-sent" -> current.upsertMessage(payload)
    "thread.activity-appended" -> current.upsertActivity(payload.obj("activity"))
    "thread.session-set" -> current.withSession(payload.obj("session"))
    "thread.turn-interrupt-requested" -> current.interruptTurn(payload)
    "thread.meta-updated" -> current.copy(
      summary = current.summary.copy(
        title = payload.text("title") ?: current.summary.title,
        modelSelection = payload.obj("modelSelection")?.toModelSelection()
          ?: current.summary.modelSelection,
        branch = payload.nullableText("branch", current.summary.branch),
        worktreePath = payload.nullableText("worktreePath", current.summary.worktreePath),
        titleRegeneration = if ("titleRegeneration" in payload) {
          payload.obj("titleRegeneration")?.toThreadTitleRegeneration()
        } else {
          current.summary.titleRegeneration
        },
      ),
    )
    "thread.runtime-mode-set" -> current.copy(
      summary = current.summary.copy(
        runtimeMode = payload.text("runtimeMode") ?: current.summary.runtimeMode,
      ),
    )
    "thread.interaction-mode-set" -> current.copy(
      summary = current.summary.copy(
        interactionMode = payload.text("interactionMode") ?: current.summary.interactionMode,
      ),
    )
    "thread.turn-diff-completed" -> payload.toReviewCheckpoint()?.let { checkpoint ->
      val existing = current.checkpoints.firstOrNull { it.turnId == checkpoint.turnId }
      if (existing != null && existing.status != "missing" && checkpoint.status == "missing") {
        current
      } else {
        current.copy(
          checkpoints = (current.checkpoints.filterNot { it.turnId == checkpoint.turnId } + checkpoint)
            .sortedBy(ReviewCheckpoint::checkpointTurnCount),
        )
      }
    } ?: current
    "thread.archived" -> current.copy(
      summary = current.summary.copy(archivedAt = payload.text("archivedAt")),
    )
    "thread.unarchived" -> current.copy(summary = current.summary.copy(archivedAt = null))
    "thread.settled" -> current.copy(
      summary = current.summary.copy(
        settledOverride = "settled",
        settledAt = payload.text("settledAt"),
      ),
    )
    "thread.unsettled" -> current.copy(
      summary = current.summary.copy(
        settledOverride = if (payload.text("reason") == "user") "active" else null,
        settledAt = null,
      ),
    )
    "thread.snoozed" -> current.copy(
      summary = current.summary.copy(
        snoozedUntil = payload.text("snoozedUntil"),
        snoozedAt = payload.text("snoozedAt"),
      ),
    )
    "thread.unsnoozed" -> current.copy(
      summary = current.summary.copy(snoozedUntil = null, snoozedAt = null),
    )
    "thread.pinned" -> current.copy(
      summary = current.summary.copy(
        pinnedAt = payload.text("pinnedAt"),
        pinOrderKey = payload.text("pinOrderKey") ?: current.summary.pinOrderKey,
      ),
    )
    "thread.unpinned" -> current.copy(
      summary = current.summary.copy(pinnedAt = null, pinOrderKey = null),
    )
    "thread.pin-reordered" -> current.copy(
      summary = current.summary.copy(pinOrderKey = payload.text("orderKey")),
    )
    else -> current
  }
  return copy(sequence = next, detail = updated)
}

fun parseProviderModels(config: JsonObject): List<ProviderModel> =
  config.array("providers").orEmpty().flatMap { providerElement ->
    val provider = providerElement as? JsonObject ?: return@flatMap emptyList()
    if (provider.bool("enabled") == false || provider.bool("installed") == false) {
      return@flatMap emptyList()
    }
    val instanceId = provider.text("instanceId") ?: return@flatMap emptyList()
    val providerLabel = provider.text("label") ?: provider.text("name") ?: instanceId
    val slashCommands = provider.array("slashCommands").orEmpty().mapNotNull { commandElement ->
      val command = commandElement as? JsonObject ?: return@mapNotNull null
      ProviderSlashCommand(
        name = command.text("name") ?: return@mapNotNull null,
        description = command.text("description"),
        inputHint = command.obj("input")?.text("hint"),
      )
    }
    provider.array("models").orEmpty().mapNotNull { modelElement ->
      val model = modelElement as? JsonObject ?: return@mapNotNull null
      val slug = model.text("slug") ?: return@mapNotNull null
      val optionDescriptors = model.obj("capabilities")?.array("optionDescriptors").orEmpty()
        .mapNotNull { descriptorElement ->
          val descriptor = descriptorElement as? JsonObject ?: return@mapNotNull null
          ProviderOptionDescriptor(
            id = descriptor.text("id") ?: return@mapNotNull null,
            label = descriptor.text("label") ?: return@mapNotNull null,
            type = descriptor.text("type") ?: return@mapNotNull null,
            choices = descriptor.array("options").orEmpty().mapNotNull { choiceElement ->
              val choice = choiceElement as? JsonObject ?: return@mapNotNull null
              ProviderOptionChoice(
                id = choice.text("id") ?: return@mapNotNull null,
                label = choice.text("label") ?: return@mapNotNull null,
                isDefault = choice.bool("isDefault") == true,
              )
            },
            currentValue = descriptor["currentValue"] as? JsonPrimitive,
            promptInjectedValues = descriptor.array("promptInjectedValues").orEmpty()
              .mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
          )
        }
      val selection = buildJsonObject(
        "instanceId" to JsonPrimitive(instanceId),
        "model" to JsonPrimitive(slug),
      )
      ProviderModel(
        instanceId = instanceId,
        providerLabel = providerLabel,
        model = slug,
        modelLabel = model.text("name") ?: model.text("label") ?: slug,
        isDefault = model.bool("isDefault") == true,
        isLegacy = model.bool("isLegacy") == true,
        rawSelection = selection,
        optionDescriptors = optionDescriptors,
        slashCommands = slashCommands,
      )
    }
  }

internal fun JsonObject.toShellState(): ShellState {
  val projects = array("projects").orEmpty()
    .mapNotNull { (it as? JsonObject)?.toProject() }
    .associateBy(Project::id)
  val threads = array("threads").orEmpty()
    .mapNotNull { (it as? JsonObject)?.toThreadSummary() }
    .associateBy(ThreadSummary::id)
  return ShellState(
    sequence = long("snapshotSequence") ?: -1,
    projects = projects,
    threads = threads,
  )
}

private fun JsonObject.toProject(): Project? {
  val id = text("id") ?: return null
  return Project(
    id = id,
    title = text("title") ?: id,
    workspaceRoot = text("workspaceRoot") ?: "",
    defaultModelSelection = obj("defaultModelSelection")?.toModelSelection(),
    scripts = array("scripts").orEmpty().mapNotNull { value ->
      val script = value as? JsonObject ?: return@mapNotNull null
      val name = script.text("name") ?: script.text("id") ?: return@mapNotNull null
      val command = script.text("command") ?: return@mapNotNull null
      ProjectScript(name, command)
    },
    repositoryIdentity = obj("repositoryIdentity")?.let { identity ->
      identity.text("canonicalKey")?.let { canonicalKey ->
        RepositoryIdentity(
          canonicalKey = canonicalKey,
          rootPath = identity.text("rootPath"),
          displayName = identity.text("displayName"),
          provider = identity.text("provider"),
          owner = identity.text("owner"),
          name = identity.text("name"),
        )
      }
    },
    createdAt = text("createdAt").orEmpty(),
    updatedAt = text("updatedAt").orEmpty(),
  )
}

private fun JsonObject.toThreadSummary(): ThreadSummary? {
  val id = text("id") ?: return null
  val projectId = text("projectId") ?: return null
  val modelSelection = obj("modelSelection")?.toModelSelection() ?: return null
  return ThreadSummary(
    id = id,
    projectId = projectId,
    title = text("title") ?: id,
    modelSelection = modelSelection,
    runtimeMode = text("runtimeMode") ?: "full-access",
    interactionMode = text("interactionMode") ?: "default",
    branch = nullableText("branch"),
    worktreePath = nullableText("worktreePath"),
    latestTurn = obj("latestTurn")?.let { turn ->
      val turnId = turn.text("turnId") ?: return@let null
      LatestTurn(
        id = turnId,
        state = turn.text("state") ?: "completed",
        startedAt = turn.nullableText("startedAt"),
        completedAt = turn.nullableText("completedAt"),
      )
    },
    session = obj("session")?.toThreadSession(),
    createdAt = text("createdAt") ?: text("updatedAt") ?: "",
    updatedAt = text("updatedAt") ?: "",
    archivedAt = nullableText("archivedAt"),
    settledOverride = nullableText("settledOverride"),
    settledAt = nullableText("settledAt"),
    snoozedUntil = nullableText("snoozedUntil"),
    snoozedAt = nullableText("snoozedAt"),
    pinnedAt = nullableText("pinnedAt"),
    pinOrderKey = nullableText("pinOrderKey"),
    titleRegeneration = obj("titleRegeneration")?.toThreadTitleRegeneration(),
    hasPendingApprovals = bool("hasPendingApprovals") == true,
    hasPendingUserInput = bool("hasPendingUserInput") == true,
  )
}

private fun JsonObject.toThreadTitleRegeneration(): ThreadTitleRegeneration? {
  val requestId = text("requestId") ?: return null
  val startedAt = text("startedAt") ?: return null
  return ThreadTitleRegeneration(requestId, startedAt)
}

private fun JsonObject.toThreadDetail(): ThreadDetail? {
  val summary = toThreadSummary() ?: return null
  return ThreadDetail(
    summary = summary,
    messages = array("messages").orEmpty().mapNotNull { (it as? JsonObject)?.toMessage() },
    activities = array("activities").orEmpty().mapNotNull { (it as? JsonObject)?.toActivity() },
    checkpoints = array("checkpoints").orEmpty()
      .mapNotNull { (it as? JsonObject)?.toReviewCheckpoint() }
      .sortedBy(ReviewCheckpoint::checkpointTurnCount),
  )
}

private fun JsonObject.toMessage(): ChatMessage? {
  val id = text("id") ?: return null
  return ChatMessage(
    id = id,
    role = text("role") ?: "system",
    text = text("text") ?: "",
    attachments = attachments(),
    turnId = nullableText("turnId"),
    streaming = bool("streaming") == true,
    createdAt = text("createdAt") ?: "",
    updatedAt = text("updatedAt") ?: text("createdAt") ?: "",
  )
}

private fun JsonObject.toActivity(): ThreadActivity? {
  val id = text("id") ?: return null
  return ThreadActivity(
    id = id,
    tone = text("tone") ?: "info",
    kind = text("kind") ?: "unknown",
    summary = text("summary") ?: "Activity",
    payload = this["payload"] ?: JsonNull,
    turnId = nullableText("turnId"),
    createdAt = text("createdAt") ?: "",
    sequence = long("sequence"),
  )
}

private fun JsonObject.toModelSelection(): ModelSelection? {
  val instanceId = text("instanceId") ?: text("provider") ?: return null
  val model = text("model") ?: return null
  return ModelSelection(instanceId, model, this["options"])
}

private fun JsonObject.toThreadSession() = ThreadSession(
  status = text("status") ?: "idle",
  activeTurnId = nullableText("activeTurnId"),
  lastError = nullableText("lastError"),
  updatedAt = nullableText("updatedAt"),
)

private fun ThreadDetail.upsertMessage(payload: JsonObject): ThreadDetail {
  val id = payload.text("messageId") ?: return this
  val incoming = ChatMessage(
    id = id,
    role = payload.text("role") ?: "system",
    text = payload.text("text") ?: "",
    attachments = payload.attachments(),
    turnId = payload.nullableText("turnId"),
    streaming = payload.bool("streaming") == true,
    createdAt = payload.text("createdAt") ?: "",
    updatedAt = payload.text("updatedAt") ?: payload.text("createdAt") ?: "",
  )
  val existing = messages.firstOrNull { it.id == id }
  val next = if (existing == null) {
    messages + incoming
  } else {
    messages.map { message ->
      if (message.id != id) message else incoming.copy(
        text = if (incoming.streaming) message.text + incoming.text
        else incoming.text.ifEmpty { message.text },
        attachments = incoming.attachments.ifEmpty { message.attachments },
        createdAt = message.createdAt,
      )
    }
  }
  val activeTurnId = summary.session?.activeTurnId
  val turnStillRunning = incoming.turnId != null &&
    summary.session?.status == "running" &&
    activeTurnId == incoming.turnId
  val settlesTurn = !incoming.streaming && !turnStillRunning
  val currentTurn = summary.latestTurn
  val latestTurn = if (
    incoming.role == "assistant" && incoming.turnId != null &&
    (currentTurn == null || currentTurn.id == incoming.turnId)
  ) {
    LatestTurn(
      id = incoming.turnId,
      state = if (settlesTurn) {
        currentTurn?.state?.takeIf { it in setOf("interrupted", "error") } ?: "completed"
      } else "running",
      completedAt = if (settlesTurn) incoming.updatedAt else currentTurn?.completedAt,
      startedAt = currentTurn?.startedAt ?: incoming.createdAt,
    )
  } else currentTurn
  return copy(messages = next, summary = summary.copy(latestTurn = latestTurn))
}

private fun JsonObject.attachments() = array("attachments").orEmpty().mapNotNull { value ->
  val attachment = value as? JsonObject ?: return@mapNotNull null
  val id = attachment.text("id") ?: return@mapNotNull null
  val mimeType = attachment.text("mimeType")?.takeIf { it.startsWith("image/", ignoreCase = true) }
    ?: return@mapNotNull null
  ChatImageAttachment(
    id = id,
    type = attachment.text("type") ?: "image",
    name = attachment.text("name") ?: "image",
    mimeType = mimeType,
    sizeBytes = attachment.long("sizeBytes") ?: 0,
  )
}

private fun ThreadDetail.upsertActivity(activity: JsonObject?): ThreadDetail {
  val parsed = activity?.toActivity() ?: return this
  return copy(activities = activities.filterNot { it.id == parsed.id } + parsed)
}

private fun ThreadDetail.withSession(session: JsonObject?): ThreadDetail {
  val nextSession = session?.toThreadSession()
  val currentTurn = summary.latestTurn
  val latestTurn = when {
    nextSession?.status == "running" && nextSession.activeTurnId != null -> LatestTurn(
      id = nextSession.activeTurnId,
      state = "running",
      completedAt = null,
      startedAt = currentTurn?.takeIf { it.id == nextSession.activeTurnId }?.startedAt
        ?: nextSession.updatedAt,
    )
    currentTurn?.state == "running" -> settledTurnState(nextSession?.status)?.let { state ->
      currentTurn.copy(state = state, completedAt = nextSession?.updatedAt)
    } ?: currentTurn
    else -> currentTurn
  }
  return copy(summary = summary.copy(session = nextSession, latestTurn = latestTurn))
}

private fun ThreadDetail.interruptTurn(payload: JsonObject): ThreadDetail {
  val turnId = payload.text("turnId") ?: return this
  val current = summary.latestTurn?.takeIf { it.id == turnId } ?: return this
  val interruptedAt = payload.text("createdAt")
  return copy(
    summary = summary.copy(
      latestTurn = current.copy(
        state = "interrupted",
        startedAt = current.startedAt ?: interruptedAt,
        completedAt = current.completedAt ?: interruptedAt,
      ),
    ),
  )
}

private fun settledTurnState(status: String?) = when (status) {
  "idle", "ready" -> "completed"
  "error" -> "error"
  "interrupted", "stopped" -> "interrupted"
  else -> null
}

internal fun derivePendingApprovals(activities: List<ThreadActivity>): List<PendingApproval> {
  val pending = linkedMapOf<String, PendingApproval>()
  activities.sortedBy(ThreadActivity::createdAt).forEach { activity ->
    val payload = activity.payload as? JsonObject ?: return@forEach
    val requestId = payload.text("requestId") ?: return@forEach
    when (activity.kind) {
      "approval.requested" -> {
        val kind = payload.text("requestKind") ?: when (payload.text("requestType")) {
          "command_execution_approval", "exec_command_approval" -> "command"
          "file_read_approval" -> "file-read"
          "file_change_approval", "apply_patch_approval" -> "file-change"
          else -> return@forEach
        }
        pending[requestId] = PendingApproval(
          requestId,
          kind,
          payload.text("detail"),
          activity.createdAt,
        )
      }
      "approval.resolved" -> pending.remove(requestId)
    }
  }
  return pending.values.toList()
}

internal fun derivePendingUserInputs(activities: List<ThreadActivity>): List<PendingUserInput> {
  val pending = linkedMapOf<String, PendingUserInput>()
  activities.sortedBy(ThreadActivity::createdAt).forEach { activity ->
    val payload = activity.payload as? JsonObject ?: return@forEach
    val requestId = payload.text("requestId") ?: return@forEach
    when (activity.kind) {
      "user-input.requested" -> {
        val questions = payload.array("questions").orEmpty().mapNotNull { value ->
          val question = value as? JsonObject ?: return@mapNotNull null
          val id = question.text("id") ?: return@mapNotNull null
          val header = question.text("header") ?: return@mapNotNull null
          val text = question.text("question") ?: return@mapNotNull null
          val options = question.array("options").orEmpty().mapNotNull { optionValue ->
            val option = optionValue as? JsonObject ?: return@mapNotNull null
            val label = option.text("label") ?: return@mapNotNull null
            UserInputOption(label, option.text("description") ?: "")
          }
          if (options.isEmpty()) return@mapNotNull null
          UserInputQuestion(id, header, text, options, question.bool("multiSelect") == true)
        }
        if (questions.isNotEmpty()) {
          pending[requestId] = PendingUserInput(requestId, questions, activity.createdAt)
        }
      }
      "user-input.resolved" -> pending.remove(requestId)
    }
  }
  return pending.values.toList()
}

internal fun JsonObject.text(name: String): String? =
  (this[name] as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.bool(name: String): Boolean? =
  (this[name] as? JsonPrimitive)?.booleanOrNull

internal fun JsonObject.long(name: String): Long? =
  (this[name] as? JsonPrimitive)?.longOrNull

internal fun JsonObject.obj(name: String): JsonObject? = this[name] as? JsonObject

internal fun JsonObject.array(name: String): JsonArray? = this[name] as? JsonArray

private fun JsonObject.nullableText(name: String, fallback: String? = null): String? = when (val value = this[name]) {
  null -> fallback
  JsonNull -> null
  is JsonPrimitive -> value.contentOrNull
  else -> fallback
}
