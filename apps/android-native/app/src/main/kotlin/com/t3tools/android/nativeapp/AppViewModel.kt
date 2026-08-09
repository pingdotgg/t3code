package com.t3tools.android.nativeapp

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.ProjectChoice
import com.t3tools.android.protocol.StartCommand
import com.t3tools.android.protocol.WorktreeBootstrap
import com.t3tools.android.protocol.WorkspaceContentMatch
import com.t3tools.android.protocol.WorkspaceEntry
import com.t3tools.android.protocol.WorkspaceFile
import com.t3tools.android.protocol.approvalResponseCommand
import com.t3tools.android.protocol.atomicStartCommand
import com.t3tools.android.protocol.createProjectCommand
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
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
  data class OpenNewTask(val projectId: String) : AppEvent
  data class OpenThread(val threadId: String) : AppEvent
}

data class AddProjectUiState(
  val path: String = "~/",
  val parentPath: String? = null,
  val directories: List<com.t3tools.android.protocol.FilesystemEntry> = emptyList(),
  val browsing: Boolean = false,
  val submitting: Boolean = false,
  val error: String? = null,
)

enum class WorkspaceSearchMode { Files, Contents }

data class WorkspaceFilesUiState(
  val environmentId: String? = null,
  val threadId: String? = null,
  val cwd: String? = null,
  val projectTitle: String = "Files",
  val entries: List<WorkspaceEntry> = emptyList(),
  val entriesTruncated: Boolean = false,
  val searchMode: WorkspaceSearchMode = WorkspaceSearchMode.Files,
  val searchQuery: String = "",
  val searchEntries: List<WorkspaceEntry> = emptyList(),
  val contentMatches: List<WorkspaceContentMatch> = emptyList(),
  val searchTruncated: Boolean = false,
  val selectedPath: String? = null,
  val file: WorkspaceFile? = null,
  val assetUrl: String? = null,
  val loadingEntries: Boolean = false,
  val searching: Boolean = false,
  val loadingFile: Boolean = false,
  val error: String? = null,
  val fileError: String? = null,
)

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

  private val mutableAddProjectState = MutableStateFlow(AddProjectUiState())
  val addProjectState = mutableAddProjectState.asStateFlow()

  private val mutableWorkspaceFilesState = MutableStateFlow(WorkspaceFilesUiState())
  val workspaceFilesState = mutableWorkspaceFilesState.asStateFlow()

  private var browseProjectJob: Job? = null
  private var addProjectJob: Job? = null
  private var workspaceEntriesJob: Job? = null
  private var workspaceSearchJob: Job? = null
  private var workspaceFileJob: Job? = null

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

  fun resetAddProject() {
    browseProjectJob?.cancel()
    addProjectJob?.cancel()
    mutableAddProjectState.value = AddProjectUiState()
  }

  fun updateAddProjectPath(path: String) {
    mutableAddProjectState.update { it.copy(path = path, error = null) }
  }

  fun browseProjectPath(path: String = mutableAddProjectState.value.path) {
    val environmentId = runtime.value.environment?.environmentId
      ?: return failAddProject("Connect an environment before browsing projects.")
    val requestedPath = path.trim().ifEmpty { "~/" }
    browseProjectJob?.cancel()
    browseProjectJob = viewModelScope.launch {
      mutableAddProjectState.update {
        it.copy(path = requestedPath, browsing = true, error = null)
      }
      runCatching { repository.browseFilesystem(environmentId, requestedPath) }
        .onSuccess { result ->
          mutableAddProjectState.update { current ->
            if (current.path != requestedPath) current else current.copy(
              parentPath = result.parentPath,
              directories = result.entries,
              browsing = false,
            )
          }
        }
        .onFailure { error ->
          mutableAddProjectState.update { current ->
            if (current.path != requestedPath) current else current.copy(
              browsing = false,
              error = error.safeMessage(),
            )
          }
        }
    }
  }

  fun addProject(workspaceRoot: String, remoteUrl: String? = null) {
    val environmentId = runtime.value.environment?.environmentId
      ?: return failAddProject("Connect an environment before adding a project.")
    val path = workspaceRoot.trim()
    if (path.isEmpty()) return failAddProject("Enter a project path.")
    val existing = runtime.value.shell.projects.values.firstOrNull {
      it.workspaceRoot.trimEnd('/') == path.trimEnd('/')
    }
    if (existing != null) return failAddProject("${existing.title} is already added.")
    val remote = remoteUrl?.trim()?.takeIf(String::isNotEmpty)
    addProjectJob?.cancel()
    addProjectJob = viewModelScope.launch {
      mutableAddProjectState.update { it.copy(submitting = true, error = null) }
      val projectId = UUID.randomUUID().toString()
      runCatching {
        val resolvedPath = if (remote == null) path else {
          repository.cloneRepository(environmentId, remote, path).cwd
        }
        repository.dispatch(environmentId, createProjectCommand(resolvedPath, projectId))
      }.onSuccess {
        mutableAddProjectState.value = AddProjectUiState()
        mutableEvents.tryEmit(AppEvent.OpenNewTask(projectId))
      }.onFailure { error ->
        mutableAddProjectState.update {
          it.copy(submitting = false, error = error.safeMessage())
        }
      }
    }
  }

  fun openWorkspace(threadId: String, force: Boolean = false) {
    val state = runtime.value
    val environmentId = state.environment?.environmentId ?: return
    val summary = state.shell.threads[threadId] ?: state.thread.detail?.summary ?: return
    val project = state.shell.projects[summary.projectId] ?: return
    val cwd = summary.worktreePath ?: project.workspaceRoot
    val current = mutableWorkspaceFilesState.value
    if (!force && current.environmentId == environmentId && current.threadId == threadId &&
      current.cwd == cwd && current.entries.isNotEmpty()) return
    workspaceEntriesJob?.cancel()
    workspaceSearchJob?.cancel()
    workspaceFileJob?.cancel()
    val key = Triple(environmentId, threadId, cwd)
    mutableWorkspaceFilesState.value = WorkspaceFilesUiState(
      environmentId = environmentId,
      threadId = threadId,
      cwd = cwd,
      projectTitle = project.title,
      loadingEntries = true,
    )
    workspaceEntriesJob = viewModelScope.launch {
      runCatching { repository.listWorkspaceEntries(environmentId, cwd) }
        .onSuccess { result ->
          mutableWorkspaceFilesState.update { currentState ->
            if (currentState.workspaceKey() != key) currentState else currentState.copy(
              entries = result.entries,
              entriesTruncated = result.truncated,
              loadingEntries = false,
            )
          }
        }
        .onFailure { error -> updateWorkspaceFailure(key, error.safeMessage()) }
    }
  }

  fun searchWorkspace(query: String, mode: WorkspaceSearchMode) {
    val current = mutableWorkspaceFilesState.value
    val environmentId = current.environmentId ?: return
    val threadId = current.threadId ?: return
    val cwd = current.cwd ?: return
    val key = Triple(environmentId, threadId, cwd)
    workspaceSearchJob?.cancel()
    mutableWorkspaceFilesState.update {
      it.copy(
        searchQuery = query,
        searchMode = mode,
        searchEntries = emptyList(),
        contentMatches = emptyList(),
        searchTruncated = false,
        searching = query.isNotBlank(),
        error = null,
      )
    }
    if (query.isBlank()) return
    workspaceSearchJob = viewModelScope.launch {
      delay(250)
      runCatching {
        when (mode) {
          WorkspaceSearchMode.Files -> WorkspaceSearchLoad.Entries(
            repository.searchWorkspaceEntries(environmentId, cwd, query),
          )
          WorkspaceSearchMode.Contents -> WorkspaceSearchLoad.Contents(
            repository.searchWorkspaceContents(environmentId, cwd, query),
          )
        }
      }.onSuccess { result ->
        mutableWorkspaceFilesState.update { currentState ->
          if (currentState.workspaceKey() != key || currentState.searchQuery != query ||
            currentState.searchMode != mode) currentState else when (result) {
            is WorkspaceSearchLoad.Entries -> currentState.copy(
              searchEntries = result.value.entries,
              searchTruncated = result.value.truncated,
              searching = false,
            )
            is WorkspaceSearchLoad.Contents -> currentState.copy(
              contentMatches = result.value.matches,
              searchTruncated = result.value.truncated,
              searching = false,
              error = result.value.regexFallbackError,
            )
          }
        }
      }.onFailure { error -> updateWorkspaceFailure(key, error.safeMessage()) }
    }
  }

  fun openWorkspaceFile(path: String) {
    val current = mutableWorkspaceFilesState.value
    val environmentId = current.environmentId ?: return
    val threadId = current.threadId ?: return
    val cwd = current.cwd ?: return
    val key = Triple(environmentId, threadId, cwd)
    workspaceFileJob?.cancel()
    mutableWorkspaceFilesState.update {
      it.copy(selectedPath = path, file = null, assetUrl = null, loadingFile = true, fileError = null)
    }
    workspaceFileJob = viewModelScope.launch {
      runCatching {
        if (isImageWorkspacePath(path)) {
          WorkspaceFileLoad.Asset(repository.workspaceAssetUrl(environmentId, threadId, cwd, path))
        } else {
          WorkspaceFileLoad.Text(repository.readWorkspaceFile(environmentId, cwd, path))
        }
      }.onSuccess { loaded ->
        mutableWorkspaceFilesState.update { currentState ->
          if (currentState.workspaceKey() != key || currentState.selectedPath != path) currentState
          else when (loaded) {
            is WorkspaceFileLoad.Asset -> currentState.copy(
              assetUrl = loaded.url,
              loadingFile = false,
            )
            is WorkspaceFileLoad.Text -> currentState.copy(
              file = loaded.file,
              loadingFile = false,
            )
          }
        }
      }.onFailure { error ->
        mutableWorkspaceFilesState.update { currentState ->
          if (currentState.workspaceKey() != key || currentState.selectedPath != path) currentState
          else currentState.copy(loadingFile = false, fileError = error.safeMessage())
        }
      }
    }
  }

  fun closeWorkspaceFile() {
    workspaceFileJob?.cancel()
    mutableWorkspaceFilesState.update {
      it.copy(selectedPath = null, file = null, assetUrl = null, loadingFile = false, fileError = null)
    }
  }

  fun clearWorkspace() {
    workspaceEntriesJob?.cancel()
    workspaceSearchJob?.cancel()
    workspaceFileJob?.cancel()
    mutableWorkspaceFilesState.value = WorkspaceFilesUiState()
  }

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

  private fun failAddProject(message: String) {
    mutableAddProjectState.update { it.copy(submitting = false, browsing = false, error = message) }
  }

  private fun updateWorkspaceFailure(
    key: Triple<String, String, String>,
    message: String,
  ) {
    mutableWorkspaceFilesState.update { current ->
      if (current.workspaceKey() != key) current else current.copy(
        loadingEntries = false,
        searching = false,
        error = message,
      )
    }
  }

  private sealed interface WorkspaceFileLoad {
    data class Text(val file: WorkspaceFile) : WorkspaceFileLoad
    data class Asset(val url: String) : WorkspaceFileLoad
  }

  private sealed interface WorkspaceSearchLoad {
    data class Entries(
      val value: com.t3tools.android.protocol.WorkspaceEntries,
    ) : WorkspaceSearchLoad

    data class Contents(
      val value: com.t3tools.android.protocol.WorkspaceContentMatches,
    ) : WorkspaceSearchLoad
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

private fun WorkspaceFilesUiState.workspaceKey(): Triple<String, String, String>? {
  val environmentId = environmentId ?: return null
  val threadId = threadId ?: return null
  val cwd = cwd ?: return null
  return Triple(environmentId, threadId, cwd)
}

internal fun isImageWorkspacePath(path: String): Boolean = path.substringAfterLast('.', "")
  .lowercase() in setOf("avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp")

private fun Throwable.safeMessage() = message?.take(240) ?: "Unexpected failure."
