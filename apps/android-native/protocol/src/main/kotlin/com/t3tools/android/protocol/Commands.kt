package com.t3tools.android.protocol

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

data class StartCommand(
  val threadId: String,
  val commandId: String,
  val messageId: String,
  val command: JsonObject,
)

fun startCommand(command: JsonObject): StartCommand {
  val message = command.required("message").jsonObject
  return StartCommand(
    threadId = command.required("threadId").jsonPrimitive.content,
    commandId = command.required("commandId").jsonPrimitive.content,
    messageId = message.required("messageId").jsonPrimitive.content,
    command = command,
  )
}

fun rekeyAtomicStartCommand(
  command: JsonObject,
  commandId: String = UUID.randomUUID().toString(),
  messageId: String = UUID.randomUUID().toString(),
  threadId: String = UUID.randomUUID().toString(),
): StartCommand {
  val message = command.required("message").jsonObject
  val updated = JsonObject(
    command + mapOf(
      "commandId" to JsonPrimitive(commandId),
      "threadId" to JsonPrimitive(threadId),
      "message" to JsonObject(message + ("messageId" to JsonPrimitive(messageId))),
    ),
  )
  return StartCommand(threadId, commandId, messageId, updated)
}

fun editStartCommand(command: JsonObject, prompt: String, hasAttachments: Boolean = false): JsonObject {
  val message = command.required("message").jsonObject
  val commandHasAttachments = (message["attachments"] as? JsonArray)?.isNotEmpty() == true
  require(prompt.isNotBlank() || hasAttachments || commandHasAttachments) {
    "Message must include text or an attachment."
  }
  val titleSource = prompt.ifBlank { command["titleSeed"]?.jsonPrimitive?.content ?: "Image attachment" }
  val title = titleSource.trim().replace(Regex("\\s+"), " ").let {
    if (it.length <= 72) it else "${it.take(69).trimEnd()}..."
  }
  val bootstrap = command["bootstrap"] as? JsonObject
  val createThread = bootstrap?.get("createThread") as? JsonObject
  return JsonObject(
    command.toMutableMap().apply {
      put("message", JsonObject(message.toMutableMap().apply { put("text", JsonPrimitive(prompt)) }))
      if (containsKey("titleSeed")) put("titleSeed", JsonPrimitive(title))
      if (bootstrap != null && createThread != null) {
        put(
          "bootstrap",
          JsonObject(
            bootstrap.toMutableMap().apply {
              put(
                "createThread",
                JsonObject(createThread.toMutableMap().apply { put("title", JsonPrimitive(title)) }),
              )
            },
          ),
        )
      }
    },
  )
}

data class WorktreeBootstrap(
  val projectCwd: String,
  val baseBranch: String,
  val branch: String? = null,
  val startFromOrigin: Boolean = false,
  val runSetupScript: Boolean = false,
)

fun atomicStartCommand(
  project: ProjectChoice,
  modelSelection: JsonObject,
  prompt: String,
  attachments: List<UploadChatImageAttachment> = emptyList(),
  pendingAttachmentNames: List<String> = emptyList(),
  runtimeMode: String = "full-access",
  interactionMode: String = "default",
  branch: String? = null,
  worktreePath: String? = null,
  worktree: WorktreeBootstrap? = null,
  commandId: String = UUID.randomUUID().toString(),
  messageId: String = UUID.randomUUID().toString(),
  threadId: String = UUID.randomUUID().toString(),
  now: Instant = Instant.now(),
): StartCommand {
  require(prompt.isNotBlank() || attachments.isNotEmpty() || pendingAttachmentNames.isNotEmpty()) {
    "Message must include text or an attachment."
  }
  val timestamp = now.toString()
  val titleSource = prompt.ifBlank {
    attachments.firstOrNull()?.name ?: pendingAttachmentNames.firstOrNull() ?: "Image attachment"
  }
  val title = titleSource.trim().replace(Regex("\\s+"), " ").let {
    if (it.length <= 72) it else "${it.take(69).trimEnd()}..."
  }
  return StartCommand(
    threadId = threadId,
    commandId = commandId,
    messageId = messageId,
    command = buildJsonObject(
      "type" to JsonPrimitive("thread.turn.start"),
      "commandId" to JsonPrimitive(commandId),
      "threadId" to JsonPrimitive(threadId),
      "message" to buildJsonObject(
        "messageId" to JsonPrimitive(messageId),
        "role" to JsonPrimitive("user"),
        "text" to JsonPrimitive(prompt),
        "attachments" to JsonArray(attachments.map(UploadChatImageAttachment::toJsonObject)),
      ),
      "modelSelection" to modelSelection,
      "titleSeed" to JsonPrimitive(title),
      "runtimeMode" to JsonPrimitive(runtimeMode),
      "interactionMode" to JsonPrimitive(interactionMode),
      "bootstrap" to buildJsonObject(
        "createThread" to buildJsonObject(
          "projectId" to JsonPrimitive(project.id),
          "title" to JsonPrimitive(title),
          "modelSelection" to modelSelection,
          "runtimeMode" to JsonPrimitive(runtimeMode),
          "interactionMode" to JsonPrimitive(interactionMode),
          "branch" to (branch?.let(::JsonPrimitive) ?: JsonNull),
          "worktreePath" to (worktreePath?.let(::JsonPrimitive) ?: JsonNull),
          "createdAt" to JsonPrimitive(timestamp),
        ),
        "prepareWorktree" to worktree?.let {
          buildJsonObject(
            "projectCwd" to JsonPrimitive(it.projectCwd),
            "baseBranch" to JsonPrimitive(it.baseBranch),
            "branch" to it.branch?.let(::JsonPrimitive),
            "startFromOrigin" to JsonPrimitive(it.startFromOrigin),
          )
        },
        "runSetupScript" to worktree?.let { JsonPrimitive(it.runSetupScript) },
      ),
      "createdAt" to JsonPrimitive(timestamp),
    ),
  )
}

fun temporaryWorktreeBranchName(randomToken: String = UUID.randomUUID().toString()): String {
  val token = randomToken.lowercase().filter { it in "0123456789abcdef" }.take(8)
  require(token.length == 8) { "Temporary worktree branch token must contain 8 hex characters." }
  return "t3code/$token"
}

fun turnStartCommand(
  threadId: String,
  modelSelection: JsonObject,
  prompt: String,
  attachments: List<UploadChatImageAttachment> = emptyList(),
  pendingAttachmentNames: List<String> = emptyList(),
  runtimeMode: String,
  interactionMode: String,
  commandId: String = UUID.randomUUID().toString(),
  messageId: String = UUID.randomUUID().toString(),
  now: Instant = Instant.now(),
): StartCommand {
  require(prompt.isNotBlank() || attachments.isNotEmpty() || pendingAttachmentNames.isNotEmpty()) {
    "Message must include text or an attachment."
  }
  return StartCommand(
    threadId = threadId,
    commandId = commandId,
    messageId = messageId,
    command = buildJsonObject(
      "type" to JsonPrimitive("thread.turn.start"),
      "commandId" to JsonPrimitive(commandId),
      "threadId" to JsonPrimitive(threadId),
      "message" to buildJsonObject(
        "messageId" to JsonPrimitive(messageId),
        "role" to JsonPrimitive("user"),
        "text" to JsonPrimitive(prompt),
        "attachments" to JsonArray(attachments.map(UploadChatImageAttachment::toJsonObject)),
      ),
      "modelSelection" to modelSelection,
      "runtimeMode" to JsonPrimitive(runtimeMode),
      "interactionMode" to JsonPrimitive(interactionMode),
      "createdAt" to JsonPrimitive(now.toString()),
    ),
  )
}

fun withStartCommandAttachments(
  command: JsonObject,
  attachments: List<UploadChatImageAttachment>,
): JsonObject {
  val message = command.required("message").jsonObject
  val updatedMessage = JsonObject(
    message + ("attachments" to JsonArray(attachments.map(UploadChatImageAttachment::toJsonObject))),
  )
  return JsonObject(command + ("message" to updatedMessage))
}

private fun UploadChatImageAttachment.toJsonObject() = buildJsonObject(
  "type" to JsonPrimitive("image"),
  "name" to JsonPrimitive(name),
  "mimeType" to JsonPrimitive(mimeType),
  "sizeBytes" to JsonPrimitive(sizeBytes),
  "dataUrl" to JsonPrimitive(dataUrl),
)

fun interruptCommand(threadId: String, now: Instant = Instant.now()) = buildJsonObject(
  "type" to JsonPrimitive("thread.turn.interrupt"),
  "commandId" to JsonPrimitive(UUID.randomUUID().toString()),
  "threadId" to JsonPrimitive(threadId),
  "createdAt" to JsonPrimitive(now.toString()),
)

fun updateThreadGitContextCommand(
  threadId: String,
  branch: String?,
  worktreePath: String?,
  expectedBranch: String? = null,
  commandId: String = UUID.randomUUID().toString(),
) = buildJsonObject(
  "type" to JsonPrimitive("thread.meta.update"),
  "commandId" to JsonPrimitive(commandId),
  "threadId" to JsonPrimitive(threadId),
  "branch" to (branch?.let(::JsonPrimitive) ?: JsonNull),
  "expectedBranch" to expectedBranch?.let(::JsonPrimitive),
  "worktreePath" to (worktreePath?.let(::JsonPrimitive) ?: JsonNull),
)

fun updateThreadTitleCommand(
  threadId: String,
  title: String? = null,
  regenerate: Boolean = false,
  commandId: String = UUID.randomUUID().toString(),
): JsonObject {
  require((title != null) xor regenerate) { "Specify either a title or regeneration." }
  return buildJsonObject(
    "type" to JsonPrimitive("thread.meta.update"),
    "commandId" to JsonPrimitive(commandId),
    "threadId" to JsonPrimitive(threadId),
    *(title?.let { arrayOf("title" to JsonPrimitive(it.trim())) }
      ?: arrayOf("regenerateTitle" to JsonPrimitive(true))),
  )
}

fun stopSessionCommand(threadId: String, now: Instant = Instant.now()) = timestampedThreadCommand(
  type = "thread.session.stop",
  threadId = threadId,
  now = now,
)

fun createProjectCommand(
  workspaceRoot: String,
  projectId: String = UUID.randomUUID().toString(),
  commandId: String = UUID.randomUUID().toString(),
  now: Instant = Instant.now(),
): JsonObject {
  val trimmedRoot = workspaceRoot.trim()
  require(trimmedRoot.isNotEmpty()) { "Workspace root must not be blank." }
  val normalizedRoot = if (trimmedRoot == "/" || WINDOWS_DRIVE_ROOT.matches(trimmedRoot)) {
    trimmedRoot
  } else {
    trimmedRoot.trimEnd('/', '\\')
  }
  val title = normalizedRoot.substringAfterLast('/').substringAfterLast('\\').ifBlank { normalizedRoot }
  return buildJsonObject(
    "type" to JsonPrimitive("project.create"),
    "commandId" to JsonPrimitive(commandId),
    "projectId" to JsonPrimitive(projectId),
    "title" to JsonPrimitive(title),
    "workspaceRoot" to JsonPrimitive(normalizedRoot),
    "createWorkspaceRootIfMissing" to JsonPrimitive(true),
    "defaultModelSelection" to JsonNull,
    "createdAt" to JsonPrimitive(now.toString()),
  )
}

private val WINDOWS_DRIVE_ROOT = Regex("^[A-Za-z]:[\\\\/]$")

fun threadActionCommand(
  type: String,
  threadId: String,
  value: String? = null,
  now: Instant = Instant.now(),
): JsonObject {
  require(
    type in setOf(
      "thread.delete",
      "thread.archive",
      "thread.unarchive",
      "thread.settle",
      "thread.unsettle",
      "thread.snooze",
      "thread.unsnooze",
      "thread.pin",
      "thread.unpin",
      "thread.pin.reorder",
    ),
  ) { "Unsupported thread action: $type" }
  val fields = when (type) {
    "thread.unsettle", "thread.unsnooze" -> arrayOf("reason" to JsonPrimitive("user"))
    "thread.snooze" -> arrayOf("snoozedUntil" to JsonPrimitive(requireNotNull(value)))
    "thread.pin", "thread.pin.reorder" -> value?.let { arrayOf("orderKey" to JsonPrimitive(it)) }
      ?: emptyArray()
    else -> emptyArray()
  }
  return timestampedThreadCommand(type, threadId, now, *fields)
}

fun approvalResponseCommand(
  threadId: String,
  requestId: String,
  decision: String,
  now: Instant = Instant.now(),
): JsonObject {
  require(decision in setOf("accept", "acceptForSession", "decline", "cancel")) {
    "Unsupported approval decision."
  }
  return timestampedThreadCommand(
    type = "thread.approval.respond",
    threadId = threadId,
    now = now,
    "requestId" to JsonPrimitive(requestId),
    "decision" to JsonPrimitive(decision),
  )
}

fun userInputResponseCommand(
  threadId: String,
  requestId: String,
  answers: Map<String, String>,
  now: Instant = Instant.now(),
): JsonObject {
  require(answers.isNotEmpty()) { "At least one answer is required." }
  return timestampedThreadCommand(
    type = "thread.user-input.respond",
    threadId = threadId,
    now = now,
    "requestId" to JsonPrimitive(requestId),
    "answers" to JsonObject(answers.mapValues { JsonPrimitive(it.value) }),
  )
}

fun runtimeModeCommand(
  threadId: String,
  runtimeMode: String,
  now: Instant = Instant.now(),
) = timestampedThreadCommand(
  type = "thread.runtime-mode.set",
  threadId = threadId,
  now = now,
  "runtimeMode" to JsonPrimitive(runtimeMode),
)

fun interactionModeCommand(
  threadId: String,
  interactionMode: String,
  now: Instant = Instant.now(),
) = timestampedThreadCommand(
  type = "thread.interaction-mode.set",
  threadId = threadId,
  now = now,
  "interactionMode" to JsonPrimitive(interactionMode),
)

private fun timestampedThreadCommand(
  type: String,
  threadId: String,
  now: Instant,
  vararg fields: Pair<String, JsonElement>,
) = buildJsonObject(
  "type" to JsonPrimitive(type),
  "commandId" to JsonPrimitive(UUID.randomUUID().toString()),
  "threadId" to JsonPrimitive(threadId),
  *fields,
  "createdAt" to JsonPrimitive(now.toString()),
)

fun chooseModel(config: JsonObject, project: ProjectChoice): JsonObject {
  project.defaultModelSelection?.let { return it }
  val providers = config.required("providers") as? JsonArray
    ?: error("Server config does not contain providers.")
  val provider = providers
    .map { it.jsonObject }
    .firstOrNull {
      it.stringOrNull("enabled") == "true" &&
        it.stringOrNull("installed") == "true" &&
        it.stringOrNull("status") == "ready"
    }
    ?: error("No ready provider is available for the headless proof.")
  val models = provider.required("models") as JsonArray
  val model = models.map { it.jsonObject }
    .firstOrNull { it.stringOrNull("isDefault") == "true" }
    ?: models.firstOrNull()?.jsonObject
    ?: error("The selected provider has no models.")
  return buildJsonObject(
    "instanceId" to provider.required("instanceId"),
    "model" to model.required("slug"),
  )
}
