package com.t3tools.android.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
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

@Serializable
data class Project(
  val id: String,
  val title: String,
  val workspaceRoot: String,
  val defaultModelSelection: ModelSelection?,
  val scripts: List<ProjectScript>,
)

@Serializable
data class ProjectScript(
  val name: String,
  val command: String,
)

@Serializable
data class LatestTurn(
  val id: String,
  val state: String,
  val completedAt: String? = null,
  val startedAt: String? = null,
)

@Serializable
data class ThreadSession(
  val status: String,
  val activeTurnId: String?,
  val lastError: String?,
  val updatedAt: String? = null,
)

@Serializable
data class ThreadTitleRegeneration(
  val requestId: String,
  val startedAt: String,
)

@Serializable
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
  val createdAt: String = "",
  val updatedAt: String,
  val archivedAt: String?,
  val settledOverride: String? = null,
  val settledAt: String? = null,
  val snoozedUntil: String? = null,
  val snoozedAt: String? = null,
  val pinnedAt: String? = null,
  val pinOrderKey: String? = null,
  val titleRegeneration: ThreadTitleRegeneration? = null,
  val hasPendingApprovals: Boolean,
  val hasPendingUserInput: Boolean,
)

@Serializable
data class ChatMessage(
  val id: String,
  val role: String,
  val text: String,
  val attachments: List<ChatImageAttachment> = emptyList(),
  val turnId: String?,
  val streaming: Boolean,
  val createdAt: String,
  val updatedAt: String,
)

@Serializable
data class ChatImageAttachment(
  val id: String,
  val type: String = "image",
  val name: String,
  val mimeType: String,
  val sizeBytes: Long,
)

data class UploadChatImageAttachment(
  val name: String,
  val mimeType: String,
  val sizeBytes: Long,
  val dataUrl: String,
)

@Serializable
data class ThreadActivity(
  val id: String,
  val tone: String,
  val kind: String,
  val summary: String,
  val payload: JsonElement,
  val turnId: String?,
  val createdAt: String,
  val sequence: Long? = null,
)

@Serializable
data class PendingApproval(
  val requestId: String,
  val requestKind: String,
  val detail: String?,
  val createdAt: String,
)

@Serializable
data class UserInputOption(
  val label: String,
  val description: String,
)

@Serializable
data class UserInputQuestion(
  val id: String,
  val header: String,
  val question: String,
  val options: List<UserInputOption>,
  val multiSelect: Boolean,
)

@Serializable
data class PendingUserInput(
  val requestId: String,
  val questions: List<UserInputQuestion>,
  val createdAt: String,
)

@Serializable
data class ThreadDetail(
  val summary: ThreadSummary,
  val messages: List<ChatMessage>,
  val activities: List<ThreadActivity>,
  val checkpoints: List<ReviewCheckpoint> = emptyList(),
) {
  val approvals: List<PendingApproval> get() = derivePendingApprovals(activities)
  val userInputs: List<PendingUserInput> get() = derivePendingUserInputs(activities)
}

@Serializable
data class ShellState(
  val sequence: Long = -1,
  val projects: Map<String, Project> = emptyMap(),
  val threads: Map<String, ThreadSummary> = emptyMap(),
  val synchronized: Boolean = false,
)

@Serializable
data class ThreadState(
  val sequence: Long = -1,
  val detail: ThreadDetail? = null,
  val synchronized: Boolean = false,
  val page: ThreadPage? = null,
  val loadedTurnLimit: Int = INITIAL_THREAD_USER_TURN_LIMIT,
)

@Serializable
data class ThreadPage(
  val beforeCursor: String? = null,
  val hasMore: Boolean = false,
  val loadingOlder: Boolean = false,
)

const val INITIAL_THREAD_USER_TURN_LIMIT = 10
const val OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20

fun ShellState.awaitingSynchronization() = copy(synchronized = false)

fun ThreadState.awaitingSynchronization() = copy(synchronized = false)

@Serializable
data class ProviderOptionChoice(
  val id: String,
  val label: String,
  val isDefault: Boolean = false,
)

@Serializable
data class ProviderOptionDescriptor(
  val id: String,
  val label: String,
  val type: String,
  val choices: List<ProviderOptionChoice> = emptyList(),
  val currentValue: JsonPrimitive? = null,
  val promptInjectedValues: List<String> = emptyList(),
)

@Serializable
data class ProviderSlashCommand(
  val name: String,
  val description: String? = null,
  val inputHint: String? = null,
)

@Serializable
data class ProviderModel(
  val instanceId: String,
  val providerLabel: String,
  val model: String,
  val modelLabel: String,
  val isDefault: Boolean,
  val isLegacy: Boolean = false,
  val rawSelection: JsonObject,
  val optionDescriptors: List<ProviderOptionDescriptor> = emptyList(),
  val slashCommands: List<ProviderSlashCommand> = emptyList(),
)
