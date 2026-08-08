package com.t3tools.android.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class ModelSelection(
  val instanceId: String,
  val model: String,
  val options: JsonElement? = null,
)

fun ModelSelection.toJsonObject() = buildJsonObject(
  "instanceId" to JsonPrimitive(instanceId),
  "model" to JsonPrimitive(model),
  "options" to options,
)

data class Project(
  val id: String,
  val title: String,
  val workspaceRoot: String,
  val defaultModelSelection: ModelSelection?,
  val scripts: List<ProjectScript>,
)

data class ProjectScript(
  val name: String,
  val command: String,
)

data class LatestTurn(
  val id: String,
  val state: String,
)

data class ThreadSession(
  val status: String,
  val activeTurnId: String?,
  val lastError: String?,
)

data class ThreadSummary(
  val id: String,
  val projectId: String,
  val title: String,
  val modelSelection: ModelSelection,
  val runtimeMode: String,
  val interactionMode: String,
  val branch: String?,
  val worktreePath: String?,
  val latestTurn: LatestTurn?,
  val session: ThreadSession?,
  val updatedAt: String,
  val archivedAt: String?,
  val hasPendingApprovals: Boolean,
  val hasPendingUserInput: Boolean,
)

data class ChatMessage(
  val id: String,
  val role: String,
  val text: String,
  val turnId: String?,
  val streaming: Boolean,
  val createdAt: String,
  val updatedAt: String,
)

data class ThreadActivity(
  val id: String,
  val tone: String,
  val kind: String,
  val summary: String,
  val payload: JsonElement,
  val turnId: String?,
  val createdAt: String,
)

data class PendingApproval(
  val requestId: String,
  val requestKind: String,
  val detail: String?,
  val createdAt: String,
)

data class UserInputOption(
  val label: String,
  val description: String,
)

data class UserInputQuestion(
  val id: String,
  val header: String,
  val question: String,
  val options: List<UserInputOption>,
  val multiSelect: Boolean,
)

data class PendingUserInput(
  val requestId: String,
  val questions: List<UserInputQuestion>,
  val createdAt: String,
)

data class ThreadDetail(
  val summary: ThreadSummary,
  val messages: List<ChatMessage>,
  val activities: List<ThreadActivity>,
) {
  val approvals: List<PendingApproval> get() = derivePendingApprovals(activities)
  val userInputs: List<PendingUserInput> get() = derivePendingUserInputs(activities)
}

data class ShellState(
  val sequence: Long = -1,
  val projects: Map<String, Project> = emptyMap(),
  val threads: Map<String, ThreadSummary> = emptyMap(),
  val synchronized: Boolean = false,
)

data class ThreadState(
  val sequence: Long = -1,
  val detail: ThreadDetail? = null,
  val synchronized: Boolean = false,
)

data class ProviderModel(
  val instanceId: String,
  val providerLabel: String,
  val model: String,
  val modelLabel: String,
  val isDefault: Boolean,
  val rawSelection: JsonObject,
)
