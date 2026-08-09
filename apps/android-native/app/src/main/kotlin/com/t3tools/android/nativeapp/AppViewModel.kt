package com.t3tools.android.nativeapp

import android.content.Intent
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.GitActionProgressEvent
import com.t3tools.android.protocol.GitStackedAction
import com.t3tools.android.protocol.ProjectChoice
import com.t3tools.android.protocol.ReviewCheckpoint
import com.t3tools.android.protocol.ReviewDiffSource
import com.t3tools.android.protocol.StartCommand
import com.t3tools.android.protocol.TerminalAttachEvent
import com.t3tools.android.protocol.TerminalBufferState
import com.t3tools.android.protocol.TerminalMetadataEvent
import com.t3tools.android.protocol.TerminalStatus
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
import com.t3tools.android.protocol.reduceVcsStatus
import com.t3tools.android.protocol.reduceTerminalBuffer
import com.t3tools.android.protocol.reduceTerminalMetadata
import com.t3tools.android.protocol.updateThreadGitContextCommand
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface DispatchState {
  data object Idle : DispatchState
  data object Sending : DispatchState
  data class Failed(val message: String) : DispatchState
}

sealed interface AppEvent {
  data object OpenHome : AppEvent
  data object OpenAddEnvironment : AppEvent
  data class OpenNewTask(
    val projectId: String? = null,
    val clearEntryRoute: Boolean = false,
  ) : AppEvent
  data class OpenIncomingShare(val shareId: String) : AppEvent
  data class OpenThread(
    val threadId: String,
    val clearEntryRoute: Boolean = false,
  ) : AppEvent
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

private data class GitTarget(
  val environmentId: String,
  val threadId: String,
  val cwd: String,
  val projectRoot: String,
  val branch: String?,
  val worktreePath: String?,
)

private data class ReviewTarget(
  val environmentId: String,
  val threadId: String,
  val cwd: String,
) {
  val key get() = "$environmentId:$threadId:$cwd"
}

data class ReviewUiState(
  val environmentId: String? = null,
  val threadId: String? = null,
  val cwd: String? = null,
  val checkpoints: List<ReviewCheckpoint> = emptyList(),
  val gitSources: List<ReviewDiffSource> = emptyList(),
  val turnDiffs: Map<String, String> = emptyMap(),
  val sections: List<ReviewSection> = emptyList(),
  val selectedSectionId: String? = null,
  val parsed: ParsedReviewDiff = ParsedReviewDiff.Empty,
  val expandedFileIds: Set<String> = emptySet(),
  val viewedFileIds: Set<String> = emptySet(),
  val revealedLargeFileIds: Set<String> = emptySet(),
  val selection: ReviewSelection? = null,
  val loading: Boolean = false,
  val error: String? = null,
) {
  val selectedSection get() = sections.firstOrNull { it.id == selectedSectionId }
  val targetKey get() = listOfNotNull(environmentId, threadId, cwd).joinToString(":")
}

class AppViewModel(
  private val repository: OnlineChatRepository,
  private val draftStore: DraftStore,
  private val attachmentStore: AttachmentStore,
  private val incomingShareStore: IncomingShareStore,
  private val launcherShortcutStore: LauncherShortcutStore,
) : ViewModel() {
  val runtime: StateFlow<OnlineChatState> = repository.state

  private val mutableDispatchState = MutableStateFlow<DispatchState>(DispatchState.Idle)
  val dispatchState = mutableDispatchState.asStateFlow()

  private val mutableEvents = Channel<AppEvent>(Channel.BUFFERED)
  val events = mutableEvents.receiveAsFlow()

  private val mutableIncomingShares = MutableStateFlow(incomingShareStore.loadAll())
  val incomingShares = mutableIncomingShares.asStateFlow()

  private val mutableDraftRevision = MutableStateFlow(0)
  val draftRevision = mutableDraftRevision.asStateFlow()

  private val mutableAddProjectState = MutableStateFlow(AddProjectUiState())
  val addProjectState = mutableAddProjectState.asStateFlow()

  private val mutableWorkspaceFilesState = MutableStateFlow(WorkspaceFilesUiState())
  val workspaceFilesState = mutableWorkspaceFilesState.asStateFlow()

  private val mutableGitState = MutableStateFlow(GitUiState())
  val gitState = mutableGitState.asStateFlow()

  private val mutableTerminalState = MutableStateFlow(TerminalUiState())
  val terminalState = mutableTerminalState.asStateFlow()

  private val mutableReviewState = MutableStateFlow(ReviewUiState())
  val reviewState = mutableReviewState.asStateFlow()

  private val mutableAttachmentUrls = MutableStateFlow<Map<String, String>>(emptyMap())
  val attachmentUrls = mutableAttachmentUrls.asStateFlow()

  private val mutableTerminalRenderCommands = MutableSharedFlow<TerminalRenderCommand>(
    extraBufferCapacity = 256,
  )
  val terminalRenderCommands = mutableTerminalRenderCommands.asSharedFlow()

  private val mutableTerminalEvents = MutableSharedFlow<TerminalUiEvent>(extraBufferCapacity = 2)
  val terminalEvents = mutableTerminalEvents.asSharedFlow()

  private var browseProjectJob: Job? = null
  private var addProjectJob: Job? = null
  private var workspaceEntriesJob: Job? = null
  private var workspaceSearchJob: Job? = null
  private var workspaceFileJob: Job? = null
  private var gitStatusJob: Job? = null
  private var gitMutationJob: Job? = null
  private var terminalMetadataJob: Job? = null
  private var terminalAttachJob: Job? = null
  private var terminalWriteJob: Job? = null
  private var terminalResizeJob: Job? = null
  private var terminalLifecycleJob: Job? = null
  private var reviewPreviewJob: Job? = null
  private var reviewTurnJob: Job? = null
  private var terminalWrites: Channel<String>? = null
  private var terminalBuffer = TerminalBufferState()
  private var terminalMetadata = emptyList<com.t3tools.android.protocol.TerminalSummary>()
  private var terminalExitReported = false
  private val reviewExpandedBySection = mutableMapOf<String, Set<String>>()
  private val reviewViewedBySection = mutableMapOf<String, Set<String>>()
  private val reviewRevealedBySection = mutableMapOf<String, Set<String>>()

  private var retryable: RetryableDispatch? = null

  private val restoreJob = viewModelScope.launch { runCatching { repository.restore() } }

  fun handleSystemIntent(intent: Intent) {
    val shareRequest = intent.incomingShareRequest()
    if (shareRequest != null) {
      viewModelScope.launch {
        runCatching { incomingShareStore.ingest(shareRequest) }
          .onSuccess { share ->
            mutableIncomingShares.value = incomingShareStore.loadAll()
            mutableEvents.trySend(AppEvent.OpenIncomingShare(share.id))
          }
          .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
      }
      return
    }
    val route = if (intent.action == Intent.ACTION_VIEW) {
      parseSystemRoute(intent.dataString)
    } else {
      null
    } ?: return
    viewModelScope.launch {
      restoreJob.join()
      when (route) {
        SystemRoute.AddEnvironment -> mutableEvents.trySend(AppEvent.OpenAddEnvironment)
        SystemRoute.NewTask -> {
          if (runtime.value.environment == null) {
            mutableEvents.trySend(AppEvent.OpenAddEnvironment)
          } else {
            mutableEvents.trySend(AppEvent.OpenNewTask(clearEntryRoute = true))
          }
        }
        is SystemRoute.Thread -> runCatching {
          require(runtime.value.environments.any { it.environmentId == route.environmentId }) {
            "This shortcut belongs to an environment that is no longer saved."
          }
          repository.selectEnvironment(route.environmentId)
        }.onSuccess {
          mutableEvents.trySend(AppEvent.OpenThread(route.threadId, clearEntryRoute = true))
        }.onFailure {
          mutableDispatchState.value = DispatchState.Failed(it.safeMessage())
        }
      }
    }
  }

  fun acceptIncomingShare(shareId: String, environmentId: String) {
    viewModelScope.launch {
      restoreJob.join()
      mutableDispatchState.value = DispatchState.Sending
      var imported = emptyList<DraftImageAttachment>()
      var draftSaved = false
      runCatching {
        require(runtime.value.environments.any { it.environmentId == environmentId }) {
          "Choose a saved environment."
        }
        val share = requireNotNull(incomingShareStore.load(shareId)) {
          "The shared content is no longer available."
        }
        repository.selectEnvironment(environmentId)
        val draftKey = DraftStore.newTaskKey(environmentId)
        val current = draftStore.load(draftKey)
        val attachmentResult = if (share.images.isEmpty()) {
          AttachmentImportResult(emptyList())
        } else {
          attachmentStore.importIncoming(environmentId, share.images, current.attachments.size)
        }
        imported = attachmentResult.attachments
        draftStore.save(
          draftKey,
          current.copy(
            text = mergeSharedText(current.text, share.text),
            attachments = current.attachments + attachmentResult.attachments,
          ),
        )
        draftSaved = true
        incomingShareStore.remove(shareId)
        listOfNotNull(share.warning, attachmentResult.error).joinToString(" ").ifBlank { null }
      }.onSuccess { warning ->
        mutableIncomingShares.value = incomingShareStore.loadAll()
        mutableDraftRevision.update { it + 1 }
        mutableDispatchState.value = warning?.let(DispatchState::Failed) ?: DispatchState.Idle
        mutableEvents.trySend(AppEvent.OpenNewTask(clearEntryRoute = true))
      }.onFailure { failure ->
        if (!draftSaved) attachmentStore.delete(imported)
        mutableDispatchState.value = DispatchState.Failed(failure.safeMessage())
      }
    }
  }

  fun discardIncomingShare(shareId: String) {
    viewModelScope.launch(Dispatchers.IO) {
      runCatching { incomingShareStore.remove(shareId) }
        .onSuccess {
          mutableIncomingShares.value = incomingShareStore.loadAll()
          mutableEvents.trySend(AppEvent.OpenHome)
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun pair(host: String, code: String) {
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching { repository.pair(buildPairingUrl(host, code)) }
        .onSuccess {
          mutableDispatchState.value = DispatchState.Idle
          mutableEvents.trySend(
            incomingShareStore.loadAll().firstOrNull()?.let {
              AppEvent.OpenIncomingShare(it.id)
            } ?: AppEvent.OpenHome,
          )
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
    val environmentId = runtime.value.environment?.environmentId
    viewModelScope.launch {
      repository.forget()
      environmentId?.let(launcherShortcutStore::removeEnvironment)
      mutableDispatchState.value = DispatchState.Idle
    }
  }

  fun selectThread(threadId: String) {
    val state = runtime.value
    val environmentId = state.environment?.environmentId
    val thread = state.shell.threads[threadId] ?: state.thread.detail?.summary
    if (environmentId != null && thread != null) {
      launcherShortcutStore.record(
        RecentThreadShortcut(environmentId, threadId, thread.title),
      )
    }
    repository.selectThread(threadId)
  }

  fun clearSelectedThread() {
    repository.clearSelectedThread()
    gitStatusJob?.cancel()
    if (gitMutationJob?.isActive != true) mutableGitState.value = GitUiState()
  }

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
        mutableEvents.trySend(AppEvent.OpenNewTask(projectId))
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

  fun observeGit(threadId: String, force: Boolean = false) {
    val target = resolveGitTarget(threadId) ?: return
    val current = mutableGitState.value
    if (!force && current.environmentId == target.environmentId && current.threadId == threadId &&
      current.cwd == target.cwd && gitStatusJob?.isActive == true) return
    startGitStatus(target, current.status.takeIf {
      current.environmentId == target.environmentId && current.cwd == target.cwd
    })
  }

  fun refreshGitStatus() {
    val target = currentGitTarget() ?: return
    viewModelScope.launch {
      mutableGitState.update { it.copy(loading = true, error = null) }
      runCatching { refreshGitStatusNow(target) }
        .onFailure { error ->
          mutableGitState.update { it.copy(loading = false, error = error.safeMessage()) }
        }
    }
  }

  fun loadGitRefs() {
    val target = currentGitTarget() ?: return
    viewModelScope.launch {
      mutableGitState.update { it.copy(refsLoading = true, error = null) }
      runCatching { repository.listVcsRefs(target.environmentId, target.projectRoot) }
        .onSuccess { result ->
          mutableGitState.update { current ->
            if (current.environmentId != target.environmentId || current.threadId != target.threadId) current
            else current.copy(refs = result.refs.filterNot { it.isRemote }, refsLoading = false)
          }
        }
        .onFailure { error ->
          mutableGitState.update { it.copy(refsLoading = false, error = error.safeMessage()) }
        }
    }
  }

  fun pullGit() = launchGitMutation("Pulling latest changes") { target ->
    val result = repository.pullVcs(target.environmentId, target.cwd)
    refreshGitStatusNow(target)
    mutableGitState.update {
      it.copy(
        progress = GitProgressUiState(
          phase = "success",
          label = if (result.status == "skipped_up_to_date") {
            "Already up to date"
          } else {
            "Pulled latest on ${result.refName}"
          },
        ),
      )
    }
  }

  fun createGitBranch(rawName: String) {
    val name = sanitizeFeatureBranchName(rawName)
    launchGitMutation("Creating branch") { target ->
      val refName = repository.createVcsRef(target.environmentId, target.cwd, name)
      repository.dispatch(
        target.environmentId,
        updateThreadGitContextCommand(
          threadId = target.threadId,
          branch = refName,
          worktreePath = target.worktreePath,
          expectedBranch = target.branch,
        ),
      )
      refreshGitStatusNow(target)
      refreshGitRefsNow(target)
    }
  }

  fun switchGitBranch(refName: String) = launchGitMutation("Switching branch") { target ->
    val branch = repository.switchVcsRef(target.environmentId, target.cwd, refName) ?: refName
    repository.dispatch(
      target.environmentId,
      updateThreadGitContextCommand(
        threadId = target.threadId,
        branch = branch,
        worktreePath = target.worktreePath,
        expectedBranch = target.branch,
      ),
    )
    refreshGitStatusNow(target)
    refreshGitRefsNow(target)
  }

  fun createGitWorktree(baseRef: String, rawNewRef: String) {
    val newRef = sanitizeFeatureBranchName(rawNewRef)
    launchGitMutation("Creating worktree") { target ->
      val worktree = repository.createVcsWorktree(
        target.environmentId,
        target.projectRoot,
        baseRef,
        newRef,
      )
      repository.dispatch(
        target.environmentId,
        updateThreadGitContextCommand(
          threadId = target.threadId,
          branch = worktree.refName,
          worktreePath = worktree.path,
          expectedBranch = target.branch,
        ),
      )
      startGitStatus(target.copy(
        cwd = worktree.path,
        branch = worktree.refName,
        worktreePath = worktree.path,
      ))
      refreshGitRefsNow(target)
    }
  }

  fun runGitAction(
    action: GitStackedAction,
    commitMessage: String? = null,
    filePaths: List<String>? = null,
    useFeatureBranch: Boolean = false,
  ) {
    if (gitMutationJob?.isActive == true) return
    val target = currentGitTarget() ?: return
    gitMutationJob = viewModelScope.launch {
      mutableGitState.update {
        it.copy(
          operation = "Running source control action",
          error = null,
          progress = GitProgressUiState("running", "Starting Git action…"),
        )
      }
      var terminal = false
      var actionStreamStarted = false
      try {
        val featureBranch = useFeatureBranch && action in setOf(
          GitStackedAction.Commit,
          GitStackedAction.CommitPush,
          GitStackedAction.CommitPushPr,
        )
        if (useFeatureBranch && !featureBranch) {
          val refs = repository.listVcsRefs(target.environmentId, target.projectRoot).refs
          val branch = resolveAutoFeatureBranchName(refs)
          repository.createVcsRef(target.environmentId, target.cwd, branch)
          repository.dispatch(
            target.environmentId,
            updateThreadGitContextCommand(
              threadId = target.threadId,
              branch = branch,
              worktreePath = target.worktreePath,
              expectedBranch = target.branch,
            ),
          )
        }
        actionStreamStarted = true
        repository.runGitAction(
          environmentId = target.environmentId,
          actionId = UUID.randomUUID().toString(),
          cwd = target.cwd,
          action = action,
          commitMessage = commitMessage,
          featureBranch = featureBranch,
          filePaths = filePaths,
        ).collect { event ->
          when (event) {
            is GitActionProgressEvent.ActionStarted -> mutableGitState.update {
              it.copy(progress = it.progress?.copy(
                label = "Running ${actionLabel(action)}",
                description = event.phases.joinToString(" → "),
              ))
            }
            is GitActionProgressEvent.PhaseStarted -> mutableGitState.update {
              it.copy(progress = it.progress?.copy(label = event.label))
            }
            is GitActionProgressEvent.HookStarted -> mutableGitState.update {
              it.copy(progress = it.progress?.copy(description = "Running ${event.hookName}"))
            }
            is GitActionProgressEvent.HookOutput -> mutableGitState.update { current ->
              val progress = current.progress ?: return@update current
              current.copy(progress = progress.copy(
                description = event.text.lineSequence().lastOrNull()?.take(180),
                output = (progress.output + event.text).takeLast(12),
              ))
            }
            is GitActionProgressEvent.HookFinished -> mutableGitState.update {
              it.copy(progress = it.progress?.copy(
                description = "${event.hookName} finished${event.exitCode?.let { code -> " ($code)" }.orEmpty()}",
              ))
            }
            is GitActionProgressEvent.ActionFinished -> {
              terminal = true
              if (event.result.branchStatus == "created" && event.result.branchName != null) {
                runCatching {
                  repository.dispatch(
                    target.environmentId,
                    updateThreadGitContextCommand(
                      threadId = target.threadId,
                      branch = event.result.branchName,
                      worktreePath = target.worktreePath,
                      expectedBranch = target.branch,
                    ),
                  )
                }.onFailure { metadataError ->
                  mutableGitState.update { it.copy(error = metadataError.safeMessage()) }
                }
              }
              mutableGitState.update { it.copy(progress = event.result.toProgress()) }
            }
            is GitActionProgressEvent.ActionFailed -> {
              terminal = true
              mutableGitState.update {
                it.copy(
                  progress = GitProgressUiState("error", "Git action failed", event.message),
                  error = event.message,
                )
              }
            }
          }
        }
        if (!terminal) error("Git action ended before reporting a result.")
        runCatching { refreshGitStatusNow(target) }
        runCatching { refreshGitRefsNow(target) }
      } catch (error: Throwable) {
        runCatching { refreshGitStatusNow(target) }
        val message = error.safeMessage()
        val uncertain = actionStreamStarted && !terminal
        mutableGitState.update {
          it.copy(
            progress = GitProgressUiState(
              "error",
              if (uncertain) "Git result needs verification" else "Git action failed",
              if (uncertain) {
                "The connection changed during the action. Status was refreshed; verify the repository before retrying."
              } else {
                message
              },
            ),
            error = message,
          )
        }
      } finally {
        mutableGitState.update { it.copy(operation = null) }
      }
    }
  }

  fun dismissGitProgress() {
    if (mutableGitState.value.progress?.phase != "running") {
      mutableGitState.update { it.copy(progress = null) }
    }
  }

  private fun launchGitMutation(label: String, block: suspend (GitTarget) -> Unit) {
    if (gitMutationJob?.isActive == true) return
    val target = currentGitTarget() ?: return
    gitMutationJob = viewModelScope.launch {
      mutableGitState.update { it.copy(operation = label, error = null) }
      runCatching { block(target) }
        .onFailure { error -> mutableGitState.update { it.copy(error = error.safeMessage()) } }
      mutableGitState.update { it.copy(operation = null) }
    }
  }

  private fun resolveGitTarget(threadId: String): GitTarget? {
    val state = runtime.value
    val environmentId = state.environment?.environmentId ?: return null
    val summary = state.shell.threads[threadId] ?: state.thread.detail?.summary ?: return null
    val project = state.shell.projects[summary.projectId] ?: return null
    return GitTarget(
      environmentId = environmentId,
      threadId = threadId,
      cwd = summary.worktreePath ?: project.workspaceRoot,
      projectRoot = project.workspaceRoot,
      branch = summary.branch,
      worktreePath = summary.worktreePath,
    )
  }

  private fun currentGitTarget(): GitTarget? {
    val state = mutableGitState.value
    val environmentId = state.environmentId ?: return null
    val threadId = state.threadId ?: return null
    val cwd = state.cwd ?: return null
    val projectRoot = state.projectRoot ?: return null
    val summary = runtime.value.shell.threads[threadId] ?: runtime.value.thread.detail?.summary
    return GitTarget(
      environmentId,
      threadId,
      cwd,
      projectRoot,
      state.status?.refName ?: summary?.branch,
      summary?.worktreePath ?: cwd.takeIf { it != projectRoot },
    )
  }

  private fun startGitStatus(target: GitTarget, retainedStatus: com.t3tools.android.protocol.VcsStatus? = null) {
    gitStatusJob?.cancel()
    val previous = mutableGitState.value
    mutableGitState.value = GitUiState(
      environmentId = target.environmentId,
      threadId = target.threadId,
      cwd = target.cwd,
      projectRoot = target.projectRoot,
      status = retainedStatus,
      refs = previous.refs,
      loading = retainedStatus == null,
      refsLoading = previous.refsLoading,
      operation = previous.operation,
      progress = previous.progress,
      error = previous.error,
    )
    gitStatusJob = viewModelScope.launch {
      var status = retainedStatus
      runCatching {
        repository.observeVcsStatus(target.environmentId, target.cwd).collect { event ->
          status = reduceVcsStatus(status, event)
          mutableGitState.update { current ->
            if (current.environmentId != target.environmentId || current.cwd != target.cwd) current
            else current.copy(status = status, loading = false, error = null)
          }
        }
      }.onFailure { error ->
        mutableGitState.update { it.copy(loading = false, error = error.safeMessage()) }
      }
    }
  }

  private suspend fun refreshGitStatusNow(target: GitTarget) {
    val status = repository.refreshVcsStatus(target.environmentId, target.cwd)
    mutableGitState.update { current ->
      if (current.environmentId != target.environmentId || current.cwd != target.cwd) current
      else current.copy(status = status, loading = false, error = null)
    }
  }

  private suspend fun refreshGitRefsNow(target: GitTarget) {
    val refs = repository.listVcsRefs(target.environmentId, target.projectRoot)
    mutableGitState.update { current ->
      if (current.environmentId != target.environmentId || current.threadId != target.threadId) current
      else current.copy(refs = refs.refs.filterNot { it.isRemote }, refsLoading = false)
    }
  }

  private fun actionLabel(action: GitStackedAction) = when (action) {
    GitStackedAction.Commit -> "commit"
    GitStackedAction.Push -> "push"
    GitStackedAction.CreatePr -> "pull request"
    GitStackedAction.CommitPush -> "commit and push"
    GitStackedAction.CommitPushPr -> "commit, push and pull request"
  }

  fun openReview(threadId: String, force: Boolean = false) {
    val target = resolveReviewTarget(threadId) ?: return
    val current = mutableReviewState.value
    if (!force && current.targetKey == target.key && current.sections.isNotEmpty()) return
    reviewPreviewJob?.cancel()
    reviewTurnJob?.cancel()
    val detail = runtime.value.thread.detail?.takeIf { it.summary.id == threadId }
    val retained = current.takeIf { it.targetKey == target.key }
    mutableReviewState.value = ReviewUiState(
      environmentId = target.environmentId,
      threadId = target.threadId,
      cwd = target.cwd,
      checkpoints = detail?.checkpoints.orEmpty(),
      gitSources = retained?.gitSources.orEmpty(),
      turnDiffs = retained?.turnDiffs.orEmpty(),
      selectedSectionId = retained?.selectedSectionId,
      parsed = retained?.parsed ?: ParsedReviewDiff.Empty,
      expandedFileIds = retained?.expandedFileIds.orEmpty(),
      viewedFileIds = retained?.viewedFileIds.orEmpty(),
      revealedLargeFileIds = retained?.revealedLargeFileIds.orEmpty(),
      loading = true,
    )
    rebuildReviewSections(target)
    loadSelectedReviewTurn(target)
    reviewPreviewJob = viewModelScope.launch {
      runCatching { repository.reviewDiffPreview(target.environmentId, target.cwd) }
        .onSuccess { preview ->
          mutableReviewState.update { state ->
            if (state.targetKey != target.key) state else state.copy(
              gitSources = preview.sources,
              loading = false,
              error = null,
            )
          }
          rebuildReviewSections(target)
        }
        .onFailure { error ->
          if (error !is CancellationException) {
            mutableReviewState.update { state ->
              if (state.targetKey != target.key) state
              else state.copy(loading = false, error = error.safeMessage())
            }
          }
        }
    }
  }

  fun syncReviewCheckpoints(threadId: String) {
    val target = currentReviewTarget()?.takeIf { it.threadId == threadId } ?: return
    val checkpoints = runtime.value.thread.detail
      ?.takeIf { it.summary.id == threadId }
      ?.checkpoints
      ?: return
    if (checkpoints == mutableReviewState.value.checkpoints) return
    mutableReviewState.update { state ->
      if (state.targetKey != target.key) state else state.copy(checkpoints = checkpoints)
    }
    rebuildReviewSections(target)
    loadSelectedReviewTurn(target)
  }

  fun selectReviewSection(sectionId: String) {
    val state = mutableReviewState.value
    if (state.sections.none { it.id == sectionId }) return
    mutableReviewState.update { it.copy(selectedSectionId = sectionId, selection = null, error = null) }
    applySelectedReviewSection()
    currentReviewTarget()?.let(::loadSelectedReviewTurn)
  }

  fun refreshReview() {
    val target = currentReviewTarget() ?: return
    if (mutableReviewState.value.selectedSection?.kind == ReviewSectionKind.Turn) {
      loadSelectedReviewTurn(target, force = true)
    } else {
      openReview(target.threadId, force = true)
    }
  }

  fun toggleReviewFile(fileId: String) {
    val state = mutableReviewState.value
    val scopeKey = reviewSectionScopeKey(state) ?: return
    val next = state.expandedFileIds.toMutableSet().apply {
      if (!add(fileId)) remove(fileId)
    }
    reviewExpandedBySection[scopeKey] = next
    mutableReviewState.update { it.copy(expandedFileIds = next, selection = null) }
  }

  fun toggleReviewViewed(fileId: String) {
    val state = mutableReviewState.value
    val scopeKey = reviewSectionScopeKey(state) ?: return
    val nextViewed = state.viewedFileIds.toMutableSet().apply {
      if (!add(fileId)) remove(fileId)
    }
    val nextExpanded = if (fileId in nextViewed) state.expandedFileIds - fileId
    else state.expandedFileIds
    reviewViewedBySection[scopeKey] = nextViewed
    reviewExpandedBySection[scopeKey] = nextExpanded
    mutableReviewState.update {
      it.copy(viewedFileIds = nextViewed, expandedFileIds = nextExpanded, selection = null)
    }
  }

  fun revealLargeReviewFile(fileId: String) {
    val state = mutableReviewState.value
    val scopeKey = reviewSectionScopeKey(state) ?: return
    val next = state.revealedLargeFileIds + fileId
    reviewRevealedBySection[scopeKey] = next
    mutableReviewState.update { it.copy(revealedLargeFileIds = next) }
  }

  fun selectReviewLine(rowId: String, extend: Boolean) {
    val state = mutableReviewState.value
    val section = state.selectedSection ?: return
    val files = (state.parsed as? ParsedReviewDiff.Files)?.files ?: return
    val file = files.firstOrNull { candidate -> candidate.lines.any { it.id == rowId } } ?: return
    val line = file.lines.first { it.id == rowId }
    mutableReviewState.update {
      it.copy(selection = updateReviewSelection(it.selection, section, file, line.lineIndex, extend))
    }
  }

  fun clearReviewSelection() {
    mutableReviewState.update { it.copy(selection = null) }
  }

  fun appendReviewComment(comment: String) {
    val state = mutableReviewState.value
    val environmentId = state.environmentId ?: return
    val threadId = state.threadId ?: return
    val selection = state.selection ?: return
    if (comment.isBlank()) return
    val key = DraftStore.threadKey(environmentId, threadId)
    val draft = draftStore.load(key)
    val context = formatReviewComment(selection, comment)
    val text = listOf(draft.text.trimEnd(), context).filter(String::isNotBlank).joinToString("\n\n")
    draftStore.save(key, draft.copy(text = text))
    mutableDraftRevision.value += 1
    mutableReviewState.update { it.copy(selection = null) }
  }

  fun stopReviewRoute(targetKey: String) {
    if (mutableReviewState.value.targetKey != targetKey) return
    reviewPreviewJob?.cancel()
    reviewTurnJob?.cancel()
  }

  private fun rebuildReviewSections(target: ReviewTarget) {
    mutableReviewState.update { state ->
      if (state.targetKey != target.key) return@update state
      val sections = buildReviewSections(state.checkpoints, state.gitSources, state.turnDiffs)
      val selectedId = state.selectedSectionId?.takeIf { id -> sections.any { it.id == id } }
        ?: sections.firstOrNull()?.id
      state.copy(sections = sections, selectedSectionId = selectedId)
    }
    applySelectedReviewSection()
  }

  private fun applySelectedReviewSection() {
    mutableReviewState.update { state ->
      val section = state.selectedSection ?: return@update state.copy(parsed = ParsedReviewDiff.Empty)
      val source = state.gitSources.firstOrNull { "git:${it.kind.wireValue}" == section.id }
      val parsed = parseReviewDiff(section.diff, source?.truncated == true)
      val files = (parsed as? ParsedReviewDiff.Files)?.files.orEmpty()
      val scopeKey = reviewSectionScopeKey(state) ?: return@update state.copy(parsed = parsed)
      val validIds = files.map(ReviewFile::id).toSet()
      val expanded = reviewExpandedBySection[scopeKey]?.intersect(validIds) ?: validIds
      val viewed = reviewViewedBySection[scopeKey].orEmpty().intersect(validIds)
      val revealed = reviewRevealedBySection[scopeKey].orEmpty().intersect(validIds)
      state.copy(
        parsed = parsed,
        expandedFileIds = expanded,
        viewedFileIds = viewed,
        revealedLargeFileIds = revealed,
        selection = null,
      )
    }
  }

  private fun loadSelectedReviewTurn(target: ReviewTarget, force: Boolean = false) {
    val state = mutableReviewState.value
    val section = state.selectedSection?.takeIf { it.kind == ReviewSectionKind.Turn } ?: return
    if (!force && section.diff != null) return
    val checkpoint = state.checkpoints.firstOrNull { "turn:${it.turnId}" == section.id } ?: return
    reviewTurnJob?.cancel()
    reviewTurnJob = viewModelScope.launch {
      mutableReviewState.update { current ->
        if (current.targetKey != target.key) current else current.copy(loading = true, error = null)
      }
      runCatching {
        repository.reviewTurnDiff(
          target.environmentId,
          target.threadId,
          (checkpoint.checkpointTurnCount - 1).coerceAtLeast(0),
          checkpoint.checkpointTurnCount,
        )
      }.onSuccess { result ->
        mutableReviewState.update { current ->
          if (current.targetKey != target.key) current else current.copy(
            turnDiffs = current.turnDiffs + (section.id to result.diff),
            loading = false,
            error = null,
          )
        }
        rebuildReviewSections(target)
      }.onFailure { error ->
        if (error !is CancellationException) {
          mutableReviewState.update { current ->
            if (current.targetKey != target.key) current
            else current.copy(loading = false, error = error.safeMessage())
          }
        }
      }
    }
  }

  private fun resolveReviewTarget(threadId: String): ReviewTarget? {
    val state = runtime.value
    val environmentId = state.environment?.environmentId ?: return null
    val summary = state.shell.threads[threadId]
      ?: state.thread.detail?.summary?.takeIf { it.id == threadId }
      ?: return null
    val project = state.shell.projects[summary.projectId] ?: return null
    return ReviewTarget(environmentId, threadId, summary.worktreePath ?: project.workspaceRoot)
  }

  private fun currentReviewTarget(): ReviewTarget? {
    val state = mutableReviewState.value
    return ReviewTarget(
      state.environmentId ?: return null,
      state.threadId ?: return null,
      state.cwd ?: return null,
    )
  }

  private fun reviewSectionScopeKey(state: ReviewUiState): String? {
    val sectionId = state.selectedSectionId ?: return null
    return "${state.targetKey}:$sectionId"
  }

  fun openTerminalRoute(threadId: String, terminalId: String) {
    val target = resolveTerminalTarget(threadId, terminalId) ?: return
    if (mutableTerminalState.value.target == target && terminalAttachJob?.isActive == true) return
    if (mutableTerminalState.value.target?.environmentId != target.environmentId) {
      terminalMetadata = emptyList()
    }
    stopTerminalJobs()
    terminalExitReported = false
    terminalBuffer = TerminalBufferState()
    val retainedSessions = terminalSessionsForThread(terminalMetadata, threadId)
    mutableTerminalState.value = TerminalUiState(
      target = target,
      sessions = retainedSessions,
      loading = true,
    )

    val writes = Channel<String>(Channel.UNLIMITED)
    terminalWrites = writes
    terminalWriteJob = viewModelScope.launch {
      for (data in writes) {
        runCatching {
          repository.writeTerminal(
            target.environmentId,
            target.threadId,
            target.terminalId,
            data,
          )
        }.onFailure { error ->
          if (error !is CancellationException) updateTerminalError(target.key, error.safeMessage())
        }
      }
    }

    terminalMetadataJob = viewModelScope.launch {
      try {
        repository.observeTerminalMetadata(target.environmentId).collect { event ->
          terminalMetadata = reduceTerminalMetadata(terminalMetadata, event)
          val sessions = terminalSessionsForThread(terminalMetadata, target.threadId)
          val active = sessions.firstOrNull { it.terminalId == target.terminalId }
          mutableTerminalState.update { current ->
            if (current.target?.key != target.key) current else current.copy(
              sessions = sessions,
              status = active?.status ?: current.status,
              label = active?.label ?: current.label,
              hasRunningSubprocess = active?.hasRunningSubprocess ?: false,
              target = active?.let {
                current.target.copy(cwd = it.cwd, worktreePath = it.worktreePath)
              } ?: current.target,
            )
          }
        }
      } catch (error: Throwable) {
        if (error is CancellationException) throw error
        updateTerminalError(target.key, error.safeMessage())
      }
    }

    terminalAttachJob = viewModelScope.launch {
      try {
        repository.attachTerminal(
          environmentId = target.environmentId,
          threadId = target.threadId,
          terminalId = target.terminalId,
          cwd = target.cwd,
          worktreePath = target.worktreePath,
          cols = mutableTerminalState.value.cols,
          rows = mutableTerminalState.value.rows,
          restartIfNotRunning = true,
        ).collect { event -> handleTerminalAttachEvent(target.key, event) }
      } catch (error: Throwable) {
        if (error is CancellationException) throw error
        updateTerminalError(target.key, error.safeMessage())
      }
    }
  }

  fun stopTerminalRoute(targetKey: String) {
    if (mutableTerminalState.value.target?.key != targetKey) return
    stopTerminalJobs()
    mutableTerminalState.value = TerminalUiState()
    terminalBuffer = TerminalBufferState()
  }

  fun terminalReplayBuffer(targetKey: String): String =
    terminalBuffer.buffer.takeIf { mutableTerminalState.value.target?.key == targetKey }.orEmpty()

  fun writeTerminal(data: String) {
    if (data.isNotEmpty()) terminalWrites?.trySend(data)
  }

  fun resizeTerminal(cols: Int, rows: Int) {
    val safeCols = cols.coerceIn(1, 1000)
    val safeRows = rows.coerceIn(1, 500)
    val current = mutableTerminalState.value
    val target = current.target ?: return
    if (current.cols == safeCols && current.rows == safeRows) return
    mutableTerminalState.update { state ->
      if (state.target?.key == target.key) state.copy(cols = safeCols, rows = safeRows) else state
    }
    if (current.loading || current.status !in setOf(TerminalStatus.Starting, TerminalStatus.Running)) return
    resizeTerminalNow(target, safeCols, safeRows)
  }

  fun clearTerminal() = runTerminalLifecycle("Clearing") { target ->
    repository.clearTerminal(target.environmentId, target.threadId, target.terminalId)
  }

  fun restartTerminal() = runTerminalLifecycle("Restarting") { target ->
    val state = mutableTerminalState.value
    repository.restartTerminal(
      target.environmentId,
      target.threadId,
      target.terminalId,
      target.cwd,
      target.worktreePath,
      state.cols,
      state.rows,
    )
  }

  fun closeTerminal(deleteHistory: Boolean = false) = runTerminalLifecycle("Closing") { target ->
    repository.closeTerminal(
      target.environmentId,
      target.threadId,
      target.terminalId,
      deleteHistory,
    )
    reportTerminalEnded(target)
  }

  fun retryTerminal() {
    val target = mutableTerminalState.value.target ?: return
    stopTerminalJobs()
    openTerminalRoute(target.threadId, target.terminalId)
  }

  fun updateTerminalFontSize(value: Float) {
    updateSettings(runtime.value.settings.copy(terminalFontSize = value.coerceIn(6f, 14f)))
  }

  private fun resolveTerminalTarget(threadId: String, terminalId: String): TerminalTarget? {
    val state = runtime.value
    val environmentId = state.environment?.environmentId ?: return null
    val summary = state.shell.threads[threadId]
      ?: state.thread.detail?.summary?.takeIf { it.id == threadId }
      ?: return null
    val project = state.shell.projects[summary.projectId] ?: return null
    val known = terminalMetadata.firstOrNull {
      it.threadId == threadId && it.terminalId == terminalId
    }
    return TerminalTarget(
      environmentId = environmentId,
      threadId = threadId,
      terminalId = terminalId,
      cwd = known?.cwd ?: summary.worktreePath ?: project.workspaceRoot,
      worktreePath = known?.worktreePath ?: summary.worktreePath,
    )
  }

  private suspend fun handleTerminalAttachEvent(targetKey: String, event: TerminalAttachEvent) {
    val current = mutableTerminalState.value
    val target = current.target ?: return
    if (target.key != targetKey) return
    val previousStatus = terminalBuffer.status
    terminalBuffer = reduceTerminalBuffer(terminalBuffer, event)
    when (event) {
      is TerminalAttachEvent.Snapshot -> {
        mutableTerminalRenderCommands.emit(TerminalRenderCommand.Reset(targetKey, terminalBuffer.buffer))
        updateTerminalSnapshot(targetKey, event.snapshot)
        resizeTerminalNow(target, current.cols, current.rows)
      }
      is TerminalAttachEvent.Restarted -> {
        mutableTerminalRenderCommands.emit(TerminalRenderCommand.Reset(targetKey, terminalBuffer.buffer))
        updateTerminalSnapshot(targetKey, event.snapshot)
      }
      is TerminalAttachEvent.Output -> {
        mutableTerminalRenderCommands.emit(TerminalRenderCommand.Append(targetKey, event.data))
      }
      TerminalAttachEvent.Cleared -> {
        mutableTerminalRenderCommands.emit(TerminalRenderCommand.Clear(targetKey))
      }
      is TerminalAttachEvent.Exited -> {
        mutableTerminalState.update { it.copy(status = TerminalStatus.Exited, loading = false) }
        if (previousStatus in setOf(TerminalStatus.Starting, TerminalStatus.Running)) {
          reportTerminalEnded(target)
        }
      }
      TerminalAttachEvent.Closed -> {
        mutableTerminalState.update { it.copy(status = TerminalStatus.Closed, loading = false) }
        if (previousStatus in setOf(TerminalStatus.Starting, TerminalStatus.Running)) {
          reportTerminalEnded(target)
        }
      }
      is TerminalAttachEvent.Error -> mutableTerminalState.update {
        it.copy(status = TerminalStatus.Error, loading = false, error = event.message)
      }
      is TerminalAttachEvent.Activity -> mutableTerminalState.update {
        it.copy(label = event.label, hasRunningSubprocess = event.hasRunningSubprocess)
      }
    }
  }

  private fun updateTerminalSnapshot(
    targetKey: String,
    snapshot: com.t3tools.android.protocol.TerminalSnapshot,
  ) {
    mutableTerminalState.update { current ->
      val target = current.target ?: return@update current
      if (target.key != targetKey) current else current.copy(
        target = target.copy(cwd = snapshot.cwd, worktreePath = snapshot.worktreePath),
        status = snapshot.status,
        label = snapshot.label,
        loading = false,
        error = null,
      )
    }
  }

  private fun resizeTerminalNow(target: TerminalTarget, cols: Int, rows: Int) {
    terminalResizeJob?.cancel()
    terminalResizeJob = viewModelScope.launch {
      runCatching {
        repository.resizeTerminal(
          target.environmentId,
          target.threadId,
          target.terminalId,
          cols,
          rows,
        )
      }.onFailure { error ->
        if (error !is CancellationException) updateTerminalError(target.key, error.safeMessage())
      }
    }
  }

  private fun runTerminalLifecycle(
    label: String,
    block: suspend (TerminalTarget) -> Unit,
  ) {
    if (terminalLifecycleJob?.isActive == true) return
    val target = mutableTerminalState.value.target ?: return
    terminalLifecycleJob = viewModelScope.launch {
      mutableTerminalState.update { it.copy(operation = label, error = null) }
      runCatching { block(target) }.onFailure { error ->
        if (error !is CancellationException) updateTerminalError(target.key, error.safeMessage())
      }
      mutableTerminalState.update { current ->
        if (current.target?.key == target.key) current.copy(operation = null) else current
      }
    }
  }

  private fun reportTerminalEnded(target: TerminalTarget) {
    if (terminalExitReported) return
    terminalExitReported = true
    mutableTerminalEvents.tryEmit(TerminalUiEvent.SessionEnded(target.threadId, target.terminalId))
  }

  private fun updateTerminalError(targetKey: String, message: String) {
    mutableTerminalState.update { current ->
      if (current.target?.key == targetKey) current.copy(loading = false, error = message) else current
    }
  }

  private fun stopTerminalJobs() {
    terminalWrites?.close()
    terminalWrites = null
    terminalMetadataJob?.cancel()
    terminalAttachJob?.cancel()
    terminalWriteJob?.cancel()
    terminalResizeJob?.cancel()
    terminalLifecycleJob?.cancel()
    terminalMetadataJob = null
    terminalAttachJob = null
    terminalWriteJob = null
    terminalResizeJob = null
    terminalLifecycleJob = null
  }

  fun loadDraft(key: String) = draftStore.load(key)

  fun saveDraft(key: String, draft: ComposerDraft) = draftStore.save(key, draft)

  fun importDraftAttachments(draftKey: String, uris: List<Uri>) {
    val environmentId = runtime.value.environment?.environmentId ?: return
    viewModelScope.launch {
      val current = draftStore.load(draftKey)
      var imported = emptyList<DraftImageAttachment>()
      runCatching {
        attachmentStore.import(environmentId, uris, current.attachments.size).also { result ->
          imported = result.attachments
          if (result.attachments.isNotEmpty()) {
            draftStore.save(
              draftKey,
              current.copy(attachments = current.attachments + result.attachments),
            )
          }
        }
      }
        .onSuccess { result ->
          if (result.attachments.isNotEmpty()) {
            mutableDraftRevision.update { it + 1 }
          }
          result.error?.let { mutableDispatchState.value = DispatchState.Failed(it) }
        }
        .onFailure {
          attachmentStore.delete(imported)
          mutableDispatchState.value = DispatchState.Failed(it.safeMessage())
        }
    }
  }

  fun removeDraftAttachment(draftKey: String, attachmentId: String) {
    val current = draftStore.load(draftKey)
    val removed = current.attachments.filter { it.id == attachmentId }
    if (removed.isEmpty()) return
    draftStore.save(
      draftKey,
      current.copy(attachments = current.attachments.filterNot { it.id == attachmentId }),
    )
    mutableDraftRevision.update { it + 1 }
    viewModelScope.launch { repository.cleanupAttachments() }
  }

  fun loadAttachmentUrl(environmentId: String, attachmentId: String) {
    val key = "$environmentId:$attachmentId"
    if (mutableAttachmentUrls.value.containsKey(key)) return
    viewModelScope.launch {
      runCatching { repository.attachmentAssetUrl(environmentId, attachmentId) }
        .onSuccess { url -> mutableAttachmentUrls.update { it + (key to url) } }
    }
  }

  fun sendThreadTurn(threadId: String, draftKey: String, draft: ComposerDraft) {
    val summary = runtime.value.shell.threads[threadId]
      ?: runtime.value.thread.detail?.summary
      ?: return
    val selection = draft.modelSelectionOr(summary.modelSelection)
    val start = turnStartCommand(
      threadId = threadId,
      modelSelection = selection.toJsonObject(),
      prompt = draft.text,
      pendingAttachmentNames = draft.attachments.map(DraftImageAttachment::name),
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
      pendingAttachmentNames = draft.attachments.map(DraftImageAttachment::name),
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
    dispatchNew(start, draftKey, draft)
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

  fun importPendingAttachments(messageId: String, uris: List<Uri>) {
    viewModelScope.launch {
      runCatching { repository.importPendingAttachments(messageId, uris) }
        .onSuccess { error -> error?.let { mutableDispatchState.value = DispatchState.Failed(it) } }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  fun removePendingAttachment(messageId: String, attachmentId: String) {
    viewModelScope.launch {
      runCatching { repository.removePendingAttachment(messageId, attachmentId) }
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
          mutableEvents.trySend(AppEvent.OpenHome)
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
          attachments = draft.attachments,
        )
      }
        .onSuccess {
          retryable = null
          val currentDraft = draftStore.load(draftKey)
          val sentAttachmentIds = draft.attachments.mapTo(mutableSetOf(), DraftImageAttachment::id)
          val nextDraft = if (currentDraft == draft) {
            draft.copy(text = "", attachments = emptyList())
          } else {
            currentDraft.copy(
              attachments = currentDraft.attachments.filterNot { it.id in sentAttachmentIds },
            )
          }
          draftStore.save(draftKey, nextDraft)
          repository.cleanupAttachments()
          mutableDraftRevision.update { it + 1 }
          mutableDispatchState.value = DispatchState.Idle
        }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun dispatchNew(start: StartCommand, draftKey: String, draft: ComposerDraft) {
    retryable = RetryableDispatch.NewTask(start, draftKey)
    viewModelScope.launch {
      mutableDispatchState.value = DispatchState.Sending
      runCatching {
        repository.enqueue(
          start = start,
          draftKey = draftKey,
          settings = emptyList(),
          createsThread = true,
          text = draft.text,
          attachments = draft.attachments,
        )
      }
        .onSuccess { acceptNew(start, draftKey) }
        .onFailure { mutableDispatchState.value = DispatchState.Failed(it.safeMessage()) }
    }
  }

  private fun recoverNew(start: StartCommand, draftKey: String) {
    dispatchNew(start, draftKey, draftStore.load(draftKey))
  }

  private fun acceptNew(start: StartCommand, draftKey: String) {
    retryable = null
    draftStore.clear(draftKey)
    mutableDraftRevision.update { it + 1 }
    viewModelScope.launch { repository.cleanupAttachments() }
    mutableDispatchState.value = DispatchState.Idle
    repository.selectThread(start.threadId)
    mutableEvents.trySend(AppEvent.OpenThread(start.threadId))
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
      AppViewModel(
        graph.chatRepository,
        graph.draftStore,
        graph.attachmentStore,
        graph.incomingShareStore,
        graph.launcherShortcutStore,
      ) as T
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

private fun ComposerDraft.modelSelectionOr(fallback: ModelSelection): ModelSelection {
  if (modelInstanceId == null || model == null) return fallback
  val options = modelOptions ?: fallback.options.takeIf {
    modelInstanceId == fallback.instanceId && model == fallback.model
  }
  return ModelSelection(modelInstanceId, model, options)
}

private fun WorkspaceFilesUiState.workspaceKey(): Triple<String, String, String>? {
  val environmentId = environmentId ?: return null
  val threadId = threadId ?: return null
  val cwd = cwd ?: return null
  return Triple(environmentId, threadId, cwd)
}

internal fun isImageWorkspacePath(path: String): Boolean = path.substringAfterLast('.', "")
  .lowercase() in setOf("avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp")

private fun Throwable.safeMessage() = message?.take(240) ?: "Unexpected failure."
