package com.t3tools.android.protocol

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
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

fun editStartCommand(command: JsonObject, prompt: String): JsonObject {
  require(prompt.isNotBlank()) { "Prompt must not be blank." }
  val message = command.required("message").jsonObject
  val title = prompt.trim().replace(Regex("\\s+"), " ").let {
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
  runtimeMode: String = "full-access",
  interactionMode: String = "default",
  worktree: WorktreeBootstrap? = null,
  commandId: String = UUID.randomUUID().toString(),
  messageId: String = UUID.randomUUID().toString(),
  threadId: String = UUID.randomUUID().toString(),
  now: Instant = Instant.now(),
): StartCommand {
  require(prompt.isNotBlank()) { "Prompt must not be blank." }
  val timestamp = now.toString()
  val title = prompt.trim().replace(Regex("\\s+"), " ").let {
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
        "attachments" to JsonArray(emptyList()),
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
          "branch" to JsonNull,
          "worktreePath" to JsonNull,
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

fun turnStartCommand(
  threadId: String,
  modelSelection: JsonObject,
  prompt: String,
  runtimeMode: String,
  interactionMode: String,
  commandId: String = UUID.randomUUID().toString(),
  messageId: String = UUID.randomUUID().toString(),
  now: Instant = Instant.now(),
): StartCommand {
  require(prompt.isNotBlank()) { "Prompt must not be blank." }
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
        "attachments" to JsonArray(emptyList()),
      ),
      "modelSelection" to modelSelection,
      "runtimeMode" to JsonPrimitive(runtimeMode),
      "interactionMode" to JsonPrimitive(interactionMode),
      "createdAt" to JsonPrimitive(now.toString()),
    ),
  )
}

fun interruptCommand(threadId: String, now: Instant = Instant.now()) = buildJsonObject(
  "type" to JsonPrimitive("thread.turn.interrupt"),
  "commandId" to JsonPrimitive(UUID.randomUUID().toString()),
  "threadId" to JsonPrimitive(threadId),
  "createdAt" to JsonPrimitive(now.toString()),
)

fun stopSessionCommand(threadId: String, now: Instant = Instant.now()) = timestampedThreadCommand(
  type = "thread.session.stop",
  threadId = threadId,
  now = now,
)

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
