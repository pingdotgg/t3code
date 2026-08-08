package com.t3tools.android.nativeapp

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.ProjectChoice
import com.t3tools.android.protocol.StartCommand
import com.t3tools.android.protocol.WorktreeBootstrap
import com.t3tools.android.protocol.approvalResponseCommand
import com.t3tools.android.protocol.atomicStartCommand
import com.t3tools.android.protocol.interruptCommand
import com.t3tools.android.protocol.interactionModeCommand
import com.t3tools.android.protocol.runtimeModeCommand
import com.t3tools.android.protocol.stopSessionCommand
import com.t3tools.android.protocol.threadActionCommand
import com.t3tools.android.protocol.toJsonObject
import com.t3tools.android.protocol.turnStartCommand
import com.t3tools.android.protocol.userInputResponseCommand
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface DispatchState {
  data object Idle : DispatchState
  data object Sending : DispatchState
  data class Failed(val message: String) : DispatchState
}

sealed interface AppEvent {
  data object OpenHome : AppEvent
  data class OpenThread(val threadId: String) : AppEvent
}

data class WorktreeChoice(
  val enabled: Boolean,
  val baseBranch: String,
  val branch: String,
  val runSetupScript: Boolean,
)

class AppViewModel(
  private val repository: OnlineChatRepository,
  private val draftStore: DraftStore,
) : ViewModel() {
  val runtime: StateFlow<OnlineChatState> = repository.state

  private val mutableDispatchState = MutableStateFlow<DispatchState>(DispatchState.Idle)
  val dispatchState = mutableDispatchState.asStateFlow()

  private val mutableEvents = MutableSharedFlow<AppEvent>(extraBufferCapacity = 2)
  val events: SharedFlow<AppEvent> = mutableEvents.asSharedFlow()

  private val mutableDraftRevision = MutableStateFlow(0)
  val draftRevision = mutableDraftRevision.asStateFlow()

  private var retryable: RetryableDispatch? = null

  init {
    viewModelScope.launch { runCatching { repository.restore() } }
  }

  fun pair(host: String, code: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.pair(buildPairingUrl(host, code)) }
        .onSuccess {
          mutableDispatchState.value = DispatchState.Idle
          mutableEvents.tryEmit(AppEvent.OpenHome)
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun pairQrPayload(payload: String) {
    val pairingUrl = extractPairingUrl(payload)
    pair(pairingUrl, "")
  }

  fun retryConnection() {
    viewModelScope.launch {
      runCatching { repository.retry() }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun selectEnvironment(environmentId: String) {
    viewModelScope.launch {
      runCatching { repository.selectEnvironment(environmentId) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun updateEnvironment(label: String, httpBaseUrl: String) {
    viewModelScope.launch {
      runCatching { repository.updateEnvironment(label, httpBaseUrl) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun reportFailure(error: Throwable) = fail(error.safeMessage())

  fun clearDispatchFailure() {
    if (mutableDispatchState.value is DispatchState.Failed) {
      mutableDispatchState.value = DispatchState.Idle
    }
  }

  fun forgetEnvironment() {
    viewModelScope.launch {
      repository.forget()
      mutableDispatchState.value = DispatchState.Idle
    }
  }

  fun selectThread(threadId: String) = repository.selectThread(threadId)

  fun clearSelectedThread() = repository.clearSelectedThread()

  fun loadDraft(key: String) = draftStore.load(key)

  fun saveDraft(key: String, draft: ComposerDraft) = draftStore.save(key, draft)

  fun sendThreadTurn(threadId: String, draftKey: String, draft: ComposerDraft) {
    val summary = runtime.value.shell.threads[threadId]
      ?: runtime.value.thread.detail?.summary
      ?: return
    val selection = draft.modelSelectionOr(summary.modelSelection)
    val start = turnStartCommand(
      threadId = threadId,
      modelSelection = selection.toJsonObject(),
      prompt = draft.text,
      runtimeMode = draft.runtimeMode,
      interactionMode = draft.interactionMode,
    )
    val settings = buildList {
      if (summary.runtimeMode != draft.runtimeMode) {
        add(runtimeModeCommand(threadId, draft.runtimeMode))
      }
      if (summary.interactionMode != draft.interactionMode) {
        add(interactionModeCommand(threadId, draft.interactionMode))
      }
    }
    dispatchExisting(start, draftKey, settings, draft)
  }

  fun createTask(
    projectId: String,
    draftKey: String,
    draft: ComposerDraft,
    worktree: WorktreeChoice,
  ) {
    val state = runtime.value
    val project = state.shell.projects[projectId] ?: return
    val fallbackModel = project.defaultModelSelection
      ?: state.providerModels.firstOrNull()?.let { ModelSelection(it.instanceId, it.model) }
      ?: return fail("No ready model is available.")
    val selection = draft.modelSelectionOr(fallbackModel)
    val start = atomicStartCommand(
      project = ProjectChoice(
        id = project.id,
        title = project.title,
        workspaceRoot = project.workspaceRoot,
        defaultModelSelection = project.defaultModelSelection?.toJsonObject(),
      ),
      modelSelection = selection.toJsonObject(),
      prompt = draft.text,
      runtimeMode = draft.runtimeMode,
      interactionMode = draft.interactionMode,
      worktree = if (worktree.enabled) {
        WorktreeBootstrap(
          projectCwd = project.workspaceRoot,
          baseBranch = worktree.baseBranch.ifBlank { "main" },
          branch = worktree.branch.ifBlank { null },
          runSetupScript = worktree.runSetupScript,
        )
      } else {
        null
      },
    )
    dispatchNew(start, draftKey)
  }

  fun retryDispatch() {
    when (val pending = retryable) {
      is RetryableDispatch.Existing -> dispatchExisting(
        pending.start,
        pending.draftKey,
        pending.settings,
        pending.draft,
      )
      is RetryableDispatch.NewTask -> recoverNew(pending.start, pending.draftKey)
      is RetryableDispatch.Action -> dispatchAction(pending.command, pending.environmentId)
      null -> Unit
    }
  }

  fun respondApproval(threadId: String, requestId: String, decision: String) {
    dispatchAction(approvalResponseCommand(threadId, requestId, decision))
  }

  fun respondUserInput(threadId: String, requestId: String, answers: Map<String, String>) {
    dispatchAction(userInputResponseCommand(threadId, requestId, answers))
  }

  fun interrupt(threadId: String) = dispatchAction(interruptCommand(threadId))

  fun stop(threadId: String) = dispatchAction(stopSessionCommand(threadId))

  fun threadAction(type: String, threadId: String, value: String? = null) =
    dispatchAction(threadActionCommand(type, threadId, value))

  fun threadAction(
    environmentId: String,
    type: String,
    threadId: String,
    value: String? = null,
  ) = dispatchAction(threadActionCommand(type, threadId, value), environmentId)

  fun reorderPinned(assignments: List<PinOrderAssignment>) {
    if (assignments.isEmpty()) return
    viewModelScope.launch {
      runCatching {
        assignments.forEach { assignment ->
          repository.dispatch(
            threadActionCommand("thread.pin.reorder", assignment.threadId, assignment.orderKey),
          )
        }
      }.onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun editPending(messageId: String, text: String) {
    viewModelScope.launch {
      runCatching { repository.editPending(messageId, text) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun removePending(messageId: String) {
    viewModelScope.launch {
      runCatching { repository.removePending(messageId) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun retryPending(messageId: String) {
    viewModelScope.launch {
      runCatching { repository.retryPending(messageId) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun updateSettings(settings: AppSettings) {
    viewModelScope.launch {
      runCatching { repository.updateSettings(settings) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun clearCache() {
    viewModelScope.launch {
      runCatching { repository.clearCache() }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun startCloudEmailCode(email: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.startCloudEmailCode(email) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun resendCloudEmailCode(email: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.resendCloudEmailCode(email) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun cancelCloudEmailCode() {
    repository.cancelCloudEmailCode()
    mutableDispatchState.value = DispatchState.Idle
  }

  fun verifyCloudEmailCode(code: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.verifyCloudEmailCode(code) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun signInCloudOAuth(provider: CloudOAuthProvider) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.signInCloudOAuth(provider) }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun signOutCloud() {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.signOutCloud() }
        .onSuccess { mutableDispatchState.value = DispatchState.Idle }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun refreshCloudEnvironments() {
    viewModelScope.launch {
      runCatching { repository.refreshCloudEnvironments() }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun connectRelay(environmentId: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.connectRelay(environmentId) }
        .onSuccess {
          mutableDispatchState.value = DispatchState.Idle
          mutableEvents.tryEmit(AppEvent.OpenHome)
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun dispatchExisting(
    start: StartCommand,
    draftKey: String,
    settings: List<kotlinx.serialization.json.JsonObject>,
    draft: ComposerDraft,
  ) {
    retryable = RetryableDispatch.Existing(start, draftKey, settings, draft)
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching {
        repository.enqueue(
          start = start,
          draftKey = draftKey,
          settings = settings,
          createsThread = false,
          text = draft.text,
        )
      }
        .onSuccess {
          retryable = null
          val currentDraft = draftStore.load(draftKey)
          if (currentDraft == draft) draftStore.save(draftKey, draft.copy(text = ""))
          mutableDraftRevision.update { it + 1 }
          mutableDispatchState.value = DispatchState.Idle
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun dispatchNew(start: StartCommand, draftKey: String) {
    retryable = RetryableDispatch.NewTask(start, draftKey)
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching {
        repository.enqueue(
          start = start,
          draftKey = draftKey,
          settings = emptyList(),
          createsThread = true,
          text = draftStore.load(draftKey).text,
        )
      }
        .onSuccess { acceptNew(start, draftKey) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun recoverNew(start: StartCommand, draftKey: String) {
    dispatchNew(start, draftKey)
  }

  private fun acceptNew(start: StartCommand, draftKey: String) {
    retryable = null
    draftStore.clear(draftKey)
    mutableDraftRevision.update { it + 1 }
    mutableDispatchState.value = DispatchState.Idle
    repository.selectThread(start.threadId)
    mutableEvents.tryEmit(AppEvent.OpenThread(start.threadId))
  }

  private fun dispatchAction(
    command: kotlinx.serialization.json.JsonObject,
    environmentId: String? = null,
  ) {
    retryable = RetryableDispatch.Action(command, environmentId)
    viewModelScope.launch {
      runCatching {
        if (environmentId == null) repository.dispatch(command)
        else repository.dispatch(environmentId, command)
      }
        .onSuccess {
          retryable = null
          mutableDispatchState.value = DispatchState.Idle
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun fail(message: String) {
    mutableDispatchState.value = DispatchState.Failed(message)
  }

  override fun onCleared() {
    repository.close()
  }

  private sealed interface RetryableDispatch {
    data class Existing(
      val start: StartCommand,
      val draftKey: String,
      val settings: List<kotlinx.serialization.json.JsonObject>,
      val draft: ComposerDraft,
    ) : RetryableDispatch
    data class NewTask(val start: StartCommand, val draftKey: String) : RetryableDispatch
    data class Action(
      val command: kotlinx.serialization.json.JsonObject,
      val environmentId: String?,
    ) : RetryableDispatch
  }

  class Factory(private val graph: AppGraph) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
      AppViewModel(graph.chatRepository, graph.draftStore) as T
  }
}

internal fun buildPairingUrl(host: String, code: String): String {
  val trimmedHost = host.trim()
  require(trimmedHost.isNotEmpty()) { "Host is required." }
  if (code.isBlank()) return trimmedHost
  val withScheme = if ("://" in trimmedHost) trimmedHost else {
    val scheme = if (trimmedHost.substringBefore(':').matches(Regex("[0-9.]+")) ||
      trimmedHost.startsWith("localhost")) "http" else "https"
    "$scheme://$trimmedHost"
  }
  val base = withScheme.trimEnd('/').substringBefore("/pair")
  val token = URLEncoder.encode(code.trim(), StandardCharsets.UTF_8.name())
  return "$base/pair#token=$token"
}

internal fun extractPairingUrl(payload: String): String {
  val value = payload.trim()
  if (!value.startsWith("t3code://")) return value
  val query = URI(value).rawQuery.orEmpty()
  val encoded = query.split('&')
    .mapNotNull { part -> part.split('=', limit = 2).takeIf { it.size == 2 } }
    .firstOrNull { it[0] == "pairingUrl" }
    ?.get(1)
    ?: error("QR code does not contain a pairing URL.")
  return URLDecoder.decode(encoded, StandardCharsets.UTF_8.name())
}

private fun ComposerDraft.modelSelectionOr(fallback: ModelSelection) =
  if (modelInstanceId != null && model != null) ModelSelection(modelInstanceId, model) else fallback

private fun Throwable.safeMessage() = message?.take(240) ?: "Unexpected failure."
