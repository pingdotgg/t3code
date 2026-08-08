package com.t3tools.android.protocol

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

data class StartCommand(
  val threadId: String,
  val command: JsonObject,
)

fun atomicStartCommand(
  project: ProjectChoice,
  modelSelection: JsonObject,
  prompt: String,
  now: Instant = Instant.now(),
): StartCommand {
  require(prompt.isNotBlank()) { "Prompt must not be blank." }
  val timestamp = now.toString()
  val threadId = UUID.randomUUID().toString()
  val title = prompt.trim().replace(Regex("\\s+"), " ").let {
    if (it.length <= 72) it else "${it.take(69).trimEnd()}..."
  }
  return StartCommand(
    threadId = threadId,
    command = buildJsonObject(
      "type" to JsonPrimitive("thread.turn.start"),
      "commandId" to JsonPrimitive(UUID.randomUUID().toString()),
      "threadId" to JsonPrimitive(threadId),
      "message" to buildJsonObject(
        "messageId" to JsonPrimitive(UUID.randomUUID().toString()),
        "role" to JsonPrimitive("user"),
        "text" to JsonPrimitive(prompt),
        "attachments" to JsonArray(emptyList()),
      ),
      "modelSelection" to modelSelection,
      "titleSeed" to JsonPrimitive(title),
      "runtimeMode" to JsonPrimitive("full-access"),
      "interactionMode" to JsonPrimitive("default"),
      "bootstrap" to buildJsonObject(
        "createThread" to buildJsonObject(
          "projectId" to JsonPrimitive(project.id),
          "title" to JsonPrimitive(title),
          "modelSelection" to modelSelection,
          "runtimeMode" to JsonPrimitive("full-access"),
          "interactionMode" to JsonPrimitive("default"),
          "branch" to JsonNull,
          "worktreePath" to JsonNull,
          "createdAt" to JsonPrimitive(timestamp),
        ),
      ),
      "createdAt" to JsonPrimitive(timestamp),
    ),
  )
}

fun interruptCommand(threadId: String, now: Instant = Instant.now()) = buildJsonObject(
  "type" to JsonPrimitive("thread.turn.interrupt"),
  "commandId" to JsonPrimitive(UUID.randomUUID().toString()),
  "threadId" to JsonPrimitive(threadId),
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
