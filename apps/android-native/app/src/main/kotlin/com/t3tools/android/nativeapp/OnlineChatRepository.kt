package com.t3tools.android.nativeapp

import com.clerk.api.Clerk
import com.clerk.api.network.model.error.ClerkErrorResponse
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.signin.SignIn
import com.clerk.api.signin.sendCode
import com.clerk.api.signin.verifyCode
import com.clerk.api.sso.OAuthProvider
import com.t3tools.android.protocol.AtomicStartResult
import com.t3tools.android.protocol.ClonedRepository
import com.t3tools.android.protocol.ConnectedEnvironment
import com.t3tools.android.protocol.FilesystemBrowseResult
import com.t3tools.android.protocol.GitActionProgressEvent
import com.t3tools.android.protocol.GitStackedAction
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.StartCommand
import com.t3tools.android.protocol.T3ProtocolClient
import com.t3tools.android.protocol.ThreadState
import com.t3tools.android.protocol.WorkspaceContentMatches
import com.t3tools.android.protocol.WorkspaceEntries
import com.t3tools.android.protocol.WorkspaceFile
import com.t3tools.android.protocol.awaitingSynchronization
import com.t3tools.android.protocol.editStartCommand
import com.t3tools.android.protocol.parseProviderModels
import com.t3tools.android.protocol.reduce
import com.t3tools.android.protocol.startCommand
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

enum class ConnectionPhase { Empty, Offline, Connecting, Backoff, Connected, Blocked, Error }
enum class SyncPhase { Idle, Cached, Synchronizing, Synchronized, Error }
enum class CloudOAuthProvider { Google, GitHub, Microsoft, Apple }

data class EnvironmentConnectionStatus(
  val environment: SavedEnvironment,
  val connectionPhase: ConnectionPhase,
  val shellSyncPhase: SyncPhase,
  val error: String?,
)

data class ThreadCapabilities(
  val settlement: Boolean = false,
  val snooze: Boolean = false,
  val pinning: Boolean = false,
  val pinReorder: Boolean = false,
)

data class CloudAuthState(
  val signedIn: Boolean = false,
  val accountId: String? = null,
  val accountLabel: String? = null,
  val relayEnvironments: List<RelayEnvironment> = emptyList(),
  val lastError: String? = null,
  /** Email waiting for OTP after a successful send (not signed in yet). */
  val pendingEmailCode: String? = null,
)

data class OnlineChatState(
  val environments: List<SavedEnvironment> = emptyList(),
  val environmentStatuses: Map<String, EnvironmentConnectionStatus> = emptyMap(),
  val environment: SavedEnvironment? = null,
  val connectionPhase: ConnectionPhase = ConnectionPhase.Empty,
  val shellSyncPhase: SyncPhase = SyncPhase.Idle,
  val threadSyncPhase: SyncPhase = SyncPhase.Idle,
  val shell: ShellState = ShellState(),
  val environmentShells: Map<String, ShellState> = emptyMap(),
  val selectedThreadId: String? = null,
  val thread: ThreadState = ThreadState(),
  val providerModels: List<com.t3tools.android.protocol.ProviderModel> = emptyList(),
  val projectFavicons: Map<String, String> = emptyMap(),
  val pendingTasks: List<PendingTask> = emptyList(),
  val threadCapabilities: ThreadCapabilities = ThreadCapabilities(),
  val settings: AppSettings = AppSettings(),
  val cloud: CloudAuthState = CloudAuthState(),
  val error: String? = null,
)

class OnlineChatRepository(
  private val client: T3ProtocolClient,
  private val connectClient: T3ConnectClient,
  private val credentialStore: AndroidCredentialStore,
  private val environmentStore: EnvironmentStore,
  private val draftStore: DraftStore,
  private val database: NativeDatabase,
  private val connectivity: AndroidConnectivity,
) : AutoCloseable {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Any()
  private val runtimes = linkedMapOf<String, EnvironmentRuntime>()
  private val supervisors = mutableMapOf<String, Job>()
  private val signals = mutableMapOf<String, Channel<SupervisorSignal>>()
  private val drainJobs = ConcurrentHashMap<String, Job>()
  private val outboxMutex = Mutex()
  private val pending = linkedMapOf<String, PendingTask>()
  private var appSettings = database.appSettings()
  private var cloud = CloudAuthState()
  private val mutableState = MutableStateFlow(
    OnlineChatState(
      environments = environmentStore.loadAll(),
      environment = environmentStore.load(),
      settings = appSettings,
      cloud = cloud,
    ),
  )
  val state: StateFlow<OnlineChatState> = mutableState.asStateFlow()

  private var activeEnvironmentId: String? = null
  private var activeThreadJob: Job? = null
  private var backgroundedAt: Long? = null
  private var restored = false

  init {
    scope.launch {
      connectivity.status.collect { status ->
        synchronized(lock) {
          runtimes.values.forEach { runtime ->
            if (status == ConnectivityStatus.Offline) {
              runtime.connection?.session?.abort()
            }
            signals[runtime.environment.environmentId]?.trySend(SupervisorSignal.Connectivity)
          }
        }
      }
    }
  }

  suspend fun restore() = withContext(Dispatchers.IO) {
    if (restored) return@withContext
    val environments = environmentStore.loadAll()
    synchronized(lock) {
      environments.forEach { environment ->
        runtimes[environment.environmentId] = EnvironmentRuntime(
          environment = environment,
          shell = database.loadShell(environment.environmentId) ?: ShellState(),
        ).apply {
          if (shell.sequence >= 0) shellSyncPhase = SyncPhase.Cached
          database.loadServerConfig(environment.environmentId)?.let { cached ->
            providerModels = parseProviderModels(cached.config)
            capabilities = cached.capabilities.toThreadCapabilities()
          }
        }
      }
      database.pending().forEach {
        pending[it.messageId] = it.copy(status = OutboxPolicy.normalizeRestoredStatus(it.status))
      }
      activeEnvironmentId = environmentStore.load()?.environmentId
      restored = true
      publishLocked()
    }
    refreshCloudAuth(refreshRelayList = true)
    environments.filter(SavedEnvironment::desired).forEach(::ensureSupervisor)
    scheduleAllDrains()
  }

  suspend fun pair(pairingUrl: String) = withContext(Dispatchers.IO) {
    val connected = client.pairAndConnect(pairingUrl)
    val saved = SavedEnvironment(
      environmentId = connected.descriptor.environmentId,
      label = connected.descriptor.label,
      httpBaseUrl = pairingUrl.substringBefore("/pair").substringBefore('#'),
    )
    environmentStore.loadAll()
      .filter {
        it.kind == EnvironmentKind.Bearer &&
          it.environmentId != saved.environmentId &&
          it.httpBaseUrl.trimEnd('/') == saved.httpBaseUrl.trimEnd('/')
      }
      .forEach { forget(it.environmentId) }
    environmentStore.save(saved)
    activateConnectedEnvironment(saved, connected)
  }

  /**
   * Start T3 Connect email OTP (same strategy as official mobile AuthView).
   * Does not finish the session — call [verifyCloudEmailCode] with the emailed code.
   */
  suspend fun startCloudEmailCode(email: String) = withContext(Dispatchers.IO) {
    val identifier = email.trim()
    require(identifier.isNotEmpty()) { "Email is required." }
    when (
      val result = Clerk.auth.signInWithOtp {
        this.email = identifier
      }
    ) {
      is ClerkResult.Success -> Unit
      is ClerkResult.Failure -> error(result.clerkMessage("Could not send sign-in code."))
    }
    synchronized(lock) {
      cloud = cloud.copy(pendingEmailCode = identifier, lastError = null)
      publishLocked()
    }
  }

  suspend fun resendCloudEmailCode(email: String) = withContext(Dispatchers.IO) {
    val identifier = email.trim().ifEmpty { cloud.pendingEmailCode.orEmpty() }
    require(identifier.isNotEmpty()) { "Email is required." }
    val signIn = Clerk.auth.currentSignIn
    if (signIn == null) {
      startCloudEmailCode(identifier)
      return@withContext
    }
    when (
      val result = signIn.sendCode {
        this.email = identifier
      }
    ) {
      is ClerkResult.Success -> Unit
      is ClerkResult.Failure -> error(result.clerkMessage("Could not resend sign-in code."))
    }
    synchronized(lock) {
      cloud = cloud.copy(pendingEmailCode = identifier, lastError = null)
      publishLocked()
    }
  }

  fun cancelCloudEmailCode() {
    synchronized(lock) {
      cloud = cloud.copy(pendingEmailCode = null)
      publishLocked()
    }
  }

  suspend fun verifyCloudEmailCode(code: String) = withContext(Dispatchers.IO) {
    val otp = code.filter(Char::isDigit)
    require(otp.isNotEmpty()) { "Enter the code from your email." }
    val signIn = requireNotNull(Clerk.auth.currentSignIn) {
      "Start with your email before entering the code."
    }
    val verified = when (val result = signIn.verifyCode(otp)) {
      is ClerkResult.Success -> result.value
      is ClerkResult.Failure -> error(result.clerkMessage("Invalid or expired code."))
    }
    when (verified.status) {
      SignIn.Status.COMPLETE -> {
        val sessionId = verified.createdSessionId
        if (sessionId != null && Clerk.activeSession?.id != sessionId) {
          when (val active = Clerk.auth.setActive(sessionId = sessionId)) {
            is ClerkResult.Success -> Unit
            is ClerkResult.Failure -> error(active.clerkMessage("Signed in, but session activation failed."))
          }
        }
      }
      SignIn.Status.NEEDS_SECOND_FACTOR ->
        error("This account requires a second factor. Use the official T3 app or complete MFA there first.")
      else -> error("Sign-in is not complete yet (${verified.status}). Try a new code.")
    }
    synchronized(lock) {
      cloud = cloud.copy(pendingEmailCode = null)
    }
    refreshCloudAuth(refreshRelayList = true)
  }

  suspend fun signInCloudOAuth(provider: CloudOAuthProvider) = withContext(Dispatchers.IO) {
    val clerkProvider = when (provider) {
      CloudOAuthProvider.Google -> OAuthProvider.GOOGLE
      CloudOAuthProvider.GitHub -> OAuthProvider.GITHUB
      CloudOAuthProvider.Microsoft -> OAuthProvider.MICROSOFT
      CloudOAuthProvider.Apple -> OAuthProvider.APPLE
    }
    when (val result = Clerk.auth.signInWithOAuth(clerkProvider)) {
      is ClerkResult.Success -> Unit
      is ClerkResult.Failure -> error(result.clerkMessage("T3 Connect OAuth failed."))
    }
    refreshCloudAuth(refreshRelayList = true)
  }

  suspend fun signOutCloud() = withContext(Dispatchers.IO) {
    when (val result = Clerk.auth.signOut()) {
      is ClerkResult.Success -> Unit
      is ClerkResult.Failure -> error(result.clerkMessage("T3 Connect sign-out failed."))
    }
    connectClient.reset()
    val relayIds = synchronized(lock) {
      runtimes.values
        .map { it.environment }
        .filter { it.kind == EnvironmentKind.Relay }
        .map { it.environmentId }
    }
    relayIds.forEach { forget(it) }
    synchronized(lock) {
      cloud = CloudAuthState()
      publishLocked()
    }
  }

  suspend fun refreshCloudEnvironments() = withContext(Dispatchers.IO) {
    refreshCloudAuth(refreshRelayList = true)
  }

  suspend fun connectRelay(environmentId: String) = withContext(Dispatchers.IO) {
    val accountId = requireNotNull(cloud.accountId ?: Clerk.user?.id) {
      "Sign in to T3 Connect first."
    }
    val listed = cloud.relayEnvironments.firstOrNull { it.environmentId == environmentId }
      ?: connectClient.listEnvironments().firstOrNull { it.environmentId == environmentId }
      ?: error("Relay environment is not available.")
    val connected = connectClient.connect(environmentId, accountId)
    val saved = SavedEnvironment(
      environmentId = connected.descriptor.environmentId,
      label = listed.label.ifBlank { connected.descriptor.label },
      httpBaseUrl = listed.endpoint.httpBaseUrl,
      kind = EnvironmentKind.Relay,
      desired = true,
    )
    environmentStore.save(saved)
    activateConnectedEnvironment(saved, connected)
  }

  suspend fun retry() {
    val environmentId = requireNotNull(activeEnvironmentId) { "No saved environment." }
    signals[environmentId]?.trySend(SupervisorSignal.Retry)
  }

  suspend fun selectEnvironment(environmentId: String) = withContext(Dispatchers.IO) {
    val environment = requireNotNull(environmentStore.load(environmentId)) {
      "Unknown environment: $environmentId"
    }
    environmentStore.select(environmentId)
    synchronized(lock) {
      activeThreadJob?.cancel()
      activeThreadJob = null
      activeEnvironmentId = environment.environmentId
      publishLocked()
    }
  }

  suspend fun updateEnvironment(label: String, httpBaseUrl: String) = withContext(Dispatchers.IO) {
    val environmentId = requireNotNull(activeEnvironmentId) { "No saved environment." }
    val environment = requireNotNull(environmentStore.load(environmentId)) { "No saved environment." }
    require(environment.kind == EnvironmentKind.Bearer) { "Relay environments are managed by T3 Connect." }
    val credential = requireNotNull(credentialStore.load(environment.environmentId)) {
      "No saved credential."
    }
    val updated = environment.copy(label = label.trim(), httpBaseUrl = httpBaseUrl.trim())
    credentialStore.save(credential.copy(httpBaseUrl = updated.httpBaseUrl))
    environmentStore.save(updated)
    synchronized(lock) {
      runtimes[environmentId]?.environment = updated
      publishLocked()
    }
    reconnect(environmentId)
  }

  suspend fun forget() {
    activeEnvironmentId?.let { forget(it) }
  }

  suspend fun forget(environmentId: String) = withContext(Dispatchers.IO) {
    val supervisor = synchronized(lock) {
      signals.remove(environmentId)?.trySend(SupervisorSignal.Stop)
      supervisors.remove(environmentId)
    }
    supervisor?.cancel()
    outboxMutex.withLock {
      synchronized(lock) {
        runtimes.remove(environmentId)?.connection?.session?.close()
        pending.values.filter { it.environmentId == environmentId }.forEach {
          pending.remove(it.messageId)
        }
        if (activeEnvironmentId == environmentId) {
          activeThreadJob?.cancel()
          activeThreadJob = null
          activeEnvironmentId = environmentStore.loadAll()
            .firstOrNull { it.environmentId != environmentId }
            ?.environmentId
        }
      }
      environmentStore.remove(environmentId)
    }
    credentialStore.clear(environmentId)
    draftStore.clearEnvironment(environmentId)
    activeEnvironmentId?.let(environmentStore::select)
    synchronized(lock) { publishLocked() }
  }

  fun selectThread(threadId: String) {
    val runtime = synchronized(lock) {
      val current = activeRuntimeLocked() ?: return
      if (current.selectedThreadId == threadId && activeThreadJob?.isActive == true) return
      activeThreadJob?.cancel()
      activeThreadJob = null
      current.selectedThreadId = threadId
      current.thread = database.loadThread(current.environment.environmentId, threadId) ?: ThreadState()
      current.threadSyncPhase = if (current.thread.sequence >= 0) SyncPhase.Cached else SyncPhase.Synchronizing
      publishLocked()
      current.takeIf { threadId in it.shell.threads }
    }
    if (runtime != null) startThreadSubscription(runtime)
  }

  fun clearSelectedThread() {
    activeThreadJob?.cancel()
    activeThreadJob = null
    synchronized(lock) {
      activeRuntimeLocked()?.apply {
        selectedThreadId = null
        thread = ThreadState()
        threadSyncPhase = SyncPhase.Idle
      }
      publishLocked()
    }
  }

  suspend fun dispatch(command: JsonObject): Long = withContext(Dispatchers.IO) {
    val runtime = connectedActiveRuntime()
    client.dispatch(requireNotNull(runtime.connection).session, command)
  }

  suspend fun dispatch(environmentId: String, command: JsonObject): Long = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.dispatch(requireNotNull(runtime.connection).session, command)
  }

  suspend fun browseFilesystem(
    environmentId: String,
    partialPath: String,
  ): FilesystemBrowseResult = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.browseFilesystem(requireNotNull(runtime.connection).session, partialPath)
  }

  suspend fun listWorkspaceEntries(
    environmentId: String,
    cwd: String,
  ): WorkspaceEntries = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.listWorkspaceEntries(requireNotNull(runtime.connection).session, cwd)
  }

  suspend fun searchWorkspaceEntries(
    environmentId: String,
    cwd: String,
    query: String,
  ): WorkspaceEntries = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.searchWorkspaceEntries(requireNotNull(runtime.connection).session, cwd, query)
  }

  suspend fun searchWorkspaceContents(
    environmentId: String,
    cwd: String,
    query: String,
  ): WorkspaceContentMatches = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.searchWorkspaceContents(requireNotNull(runtime.connection).session, cwd, query)
  }

  suspend fun readWorkspaceFile(
    environmentId: String,
    cwd: String,
    relativePath: String,
  ): WorkspaceFile = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.readWorkspaceFile(requireNotNull(runtime.connection).session, cwd, relativePath)
  }

  suspend fun cloneRepository(
    environmentId: String,
    remoteUrl: String,
    destinationPath: String,
  ): ClonedRepository = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.cloneRepository(
      requireNotNull(runtime.connection).session,
      remoteUrl,
      destinationPath,
    )
  }

  suspend fun workspaceAssetUrl(
    environmentId: String,
    threadId: String,
    cwd: String,
    relativePath: String,
  ): String = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    val asset = client.createWorkspaceAssetUrl(
      requireNotNull(runtime.connection).session,
      threadId,
      resolveWorkspaceFilePath(cwd, relativePath),
    )
    val base = runtime.environment.httpBaseUrl.trimEnd('/')
    val relative = asset.relativeUrl
    if (relative.startsWith("http://") || relative.startsWith("https://")) relative
    else URI("$base/").resolve(relative.removePrefix("/")).toString()
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  fun observeVcsStatus(environmentId: String, cwd: String) = mutableState
    .map { state ->
      state.environment?.environmentId == environmentId &&
        state.connectionPhase == ConnectionPhase.Connected
    }
    .distinctUntilChanged()
    .flatMapLatest { connected ->
      if (!connected) emptyFlow() else flow {
        val runtime = connectedRuntime(environmentId)
        client.vcsStatus(requireNotNull(runtime.connection).session, cwd).collect(::emit)
      }
    }

  suspend fun refreshVcsStatus(environmentId: String, cwd: String) = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.refreshVcsStatus(requireNotNull(runtime.connection).session, cwd)
  }

  suspend fun listVcsRefs(environmentId: String, cwd: String) = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.listVcsRefs(requireNotNull(runtime.connection).session, cwd)
  }

  suspend fun pullVcs(environmentId: String, cwd: String) = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.pullVcs(requireNotNull(runtime.connection).session, cwd)
  }

  suspend fun createVcsRef(environmentId: String, cwd: String, refName: String) =
    withContext(Dispatchers.IO) {
      val runtime = connectedRuntime(environmentId)
      client.createVcsRef(requireNotNull(runtime.connection).session, cwd, refName)
    }

  suspend fun switchVcsRef(environmentId: String, cwd: String, refName: String) =
    withContext(Dispatchers.IO) {
      val runtime = connectedRuntime(environmentId)
      client.switchVcsRef(requireNotNull(runtime.connection).session, cwd, refName)
    }

  suspend fun createVcsWorktree(
    environmentId: String,
    cwd: String,
    baseRef: String,
    newRef: String,
  ) = withContext(Dispatchers.IO) {
    val runtime = connectedRuntime(environmentId)
    client.createVcsWorktree(
      requireNotNull(runtime.connection).session,
      cwd,
      baseRef,
      newRef,
    )
  }

  fun runGitAction(
    environmentId: String,
    actionId: String,
    cwd: String,
    action: GitStackedAction,
    commitMessage: String?,
    featureBranch: Boolean,
    filePaths: List<String>?,
  ): Flow<GitActionProgressEvent> = flow {
    val runtime = connectedRuntime(environmentId)
    client.runGitAction(
      requireNotNull(runtime.connection).session,
      actionId,
      cwd,
      action,
      commitMessage,
      featureBranch,
      filePaths,
    ).collect(::emit)
  }

  suspend fun dispatchAtomicStart(start: StartCommand): AtomicStartResult = withContext(Dispatchers.IO) {
    val runtime = connectedActiveRuntime()
    client.dispatchAtomicStart(requireNotNull(runtime.connection).session, start)
  }

  suspend fun recoverAtomicStart(start: StartCommand): AtomicStartResult = withContext(Dispatchers.IO) {
    val runtime = connectedActiveRuntime()
    client.recoverAtomicStart(requireNotNull(runtime.connection).session, start)
  }

  suspend fun enqueue(
    start: StartCommand,
    draftKey: String,
    settings: List<JsonObject>,
    createsThread: Boolean,
    text: String,
  ) = withContext(Dispatchers.IO) {
    val environmentId = requireNotNull(activeEnvironmentId) { "No saved environment." }
    val task = PendingTask(
      messageId = start.messageId,
      environmentId = environmentId,
      threadId = start.threadId,
      draftKey = draftKey,
      command = start.command,
      settings = JsonArray(settings),
      createsThread = createsThread,
      text = text,
    )
    outboxMutex.withLock {
      database.savePending(task)
      synchronized(lock) {
        pending[task.messageId] = task
        publishLocked()
      }
    }
    scheduleDrain(task.environmentId, task.threadId)
  }

  suspend fun editPending(messageId: String, text: String) = withContext(Dispatchers.IO) {
    val updated = outboxMutex.withLock {
      val updated = synchronized(lock) {
        val current = requireNotNull(pending[messageId]) { "Pending task no longer exists." }
        require(current.status != PendingTaskStatus.Sending) { "Wait for the current send attempt." }
        current.copy(
          command = editStartCommand(current.command, text),
          text = text.trim(),
          status = PendingTaskStatus.Queued,
          attempt = 0,
          nextAttemptAt = 0,
          error = null,
        )
      }
      database.savePending(updated)
      synchronized(lock) {
        pending[messageId] = updated
        publishLocked()
      }
      updated
    }
    scheduleDrain(updated.environmentId, updated.threadId)
  }

  suspend fun removePending(messageId: String) = withContext(Dispatchers.IO) {
    outboxMutex.withLock {
      val task = synchronized(lock) { pending[messageId] } ?: return@withLock
      require(task.status != PendingTaskStatus.Sending) { "Wait for the current send attempt." }
      database.removePending(messageId)
      synchronized(lock) {
        pending.remove(messageId)
        publishLocked()
      }
    }
  }

  suspend fun retryPending(messageId: String) = withContext(Dispatchers.IO) {
    val updated = outboxMutex.withLock {
      val updated = synchronized(lock) {
        val task = requireNotNull(pending[messageId]) { "Pending task no longer exists." }
        task.copy(status = PendingTaskStatus.Queued, nextAttemptAt = 0, error = null)
      }
      database.savePending(updated)
      synchronized(lock) {
        pending[messageId] = updated
        publishLocked()
      }
      updated
    }
    scheduleDrain(updated.environmentId, updated.threadId)
  }

  suspend fun updateSettings(settings: AppSettings) = withContext(Dispatchers.IO) {
    database.saveAppSettings(settings)
    synchronized(lock) {
      appSettings = settings
      publishLocked()
    }
  }

  suspend fun clearCache() = withContext(Dispatchers.IO) {
    database.clearCache(activeEnvironmentId)
  }

  fun onBackgrounded(now: Long = System.currentTimeMillis()) {
    backgroundedAt = now
  }

  fun onForegrounded(now: Long = System.currentTimeMillis()) {
    val backgroundDuration = backgroundedAt?.let { (now - it).coerceAtLeast(0) } ?: 0
    backgroundedAt = null
    val signal = when (ConnectionPolicy.resumeAction(backgroundDuration)) {
      ResumeAction.Probe -> SupervisorSignal.Probe
      ResumeAction.Reconnect -> SupervisorSignal.Reconnect
    }
    synchronized(lock) { signals.values.forEach { it.trySend(signal) } }
  }

  private fun ensureSupervisor(
    environment: SavedEnvironment,
    initialConnection: ConnectedEnvironment? = null,
  ) {
    synchronized(lock) {
      if (supervisors[environment.environmentId]?.isActive == true) return
      val channel = Channel<SupervisorSignal>(Channel.CONFLATED)
      signals[environment.environmentId] = channel
      supervisors[environment.environmentId] = scope.launch {
        supervise(environment.environmentId, channel, initialConnection)
      }
    }
  }

  private suspend fun activateConnectedEnvironment(
    environment: SavedEnvironment,
    connected: ConnectedEnvironment,
  ) {
    val supervisor = synchronized(lock) {
      activeThreadJob?.cancel()
      activeThreadJob = null
      activeEnvironmentId = environment.environmentId
      signals.remove(environment.environmentId)?.trySend(SupervisorSignal.Stop)
      supervisors.remove(environment.environmentId)
    }
    try {
      supervisor?.join()
      synchronized(lock) {
        val runtime = runtimes.getOrPut(environment.environmentId) {
          EnvironmentRuntime(
            environment = environment,
            shell = database.loadShell(environment.environmentId) ?: ShellState(),
          ).apply {
            if (shell.sequence >= 0) shellSyncPhase = SyncPhase.Cached
            database.loadServerConfig(environment.environmentId)?.let { cached ->
              providerModels = parseProviderModels(cached.config)
              capabilities = cached.capabilities.toThreadCapabilities()
            }
          }
        }
        runtime.connection?.session?.close()
        runtime.connection = null
        runtime.environment = environment
        publishLocked()
      }
      ensureSupervisor(environment, connected)
    } catch (error: Throwable) {
      connected.session.close()
      throw error
    }
  }

  private suspend fun supervise(
    environmentId: String,
    signal: Channel<SupervisorSignal>,
    initialConnection: ConnectedEnvironment?,
  ) {
    var supplied = initialConnection
    var attempt = 0
    while (true) {
      val runtime = synchronized(lock) { runtimes[environmentId] } ?: return
      if (!runtime.environment.desired) return
      if (connectivity.status.value == ConnectivityStatus.Offline) {
        updateConnection(runtime, ConnectionPhase.Offline, null)
        if (signal.receive() == SupervisorSignal.Stop) return
        continue
      }
      updateConnection(runtime, ConnectionPhase.Connecting, null)
      val connectedAt = System.currentTimeMillis()
      val connected = try {
        supplied?.also { supplied = null } ?: openConnection(runtime.environment)
      } catch (error: Throwable) {
        if (error is CancellationException) throw error
        val blocked = OutboxPolicy.isBlockedConnection(error)
        updateConnection(
          runtime,
          if (blocked) ConnectionPhase.Blocked else ConnectionPhase.Backoff,
          error.safeMessage(),
        )
        if (blocked) {
          when (signal.receive()) {
            SupervisorSignal.Stop -> return
            else -> continue
          }
        }
        val interrupted = withTimeoutOrNull(ConnectionPolicy.retryDelay(attempt)) { signal.receive() }
        if (interrupted == SupervisorSignal.Stop) return
        attempt += 1
        continue
      }

      if (connected.descriptor.environmentId != environmentId) {
        replaceEnvironmentIdentity(environmentId, runtime, connected)
        return
      }

      runtime.connection = connected
      runtime.generation += 1
      runtime.shell = runtime.shell.awaitingSynchronization()
      runtime.providerModels = parseProviderModels(connected.config)
      runtime.capabilities = connected.descriptor.capabilities.toThreadCapabilities()
      database.saveServerConfig(
        environmentId,
        CachedServerConfig(connected.config, connected.descriptor.capabilities),
      )
      runtime.shellSyncPhase = SyncPhase.Synchronizing
      updateConnection(runtime, ConnectionPhase.Connected, null)
      val generation = runtime.generation
      val shellJob = scope.launch {
        runCatching {
          client.shell(
            connected.session,
            afterSequence = runtime.shell.sequence.takeIf { it >= 0 },
          ).collect { item ->
            synchronized(lock) {
              if (runtime.generation != generation) return@collect
              runtime.shell = runtime.shell.reduce(item)
              runtime.shellSyncPhase = if (runtime.shell.synchronized) {
                SyncPhase.Synchronized
              } else {
                SyncPhase.Synchronizing
              }
              database.saveShell(environmentId, runtime.shell)
              publishLocked()
              val selectedThreadId = runtime.selectedThreadId
              if (activeEnvironmentId == environmentId && selectedThreadId != null &&
                selectedThreadId in runtime.shell.threads && activeThreadJob?.isActive != true) {
                startThreadSubscription(runtime)
              }
              if (runtime.shell.synchronized) {
                resolveProjectFavicons(environmentId, runtime, connected.session)
                scheduleEnvironmentDrains(environmentId)
              }
            }
          }
          signal.trySend(SupervisorSignal.Lost(null))
        }.onFailure { error ->
          if (error !is CancellationException) signal.trySend(SupervisorSignal.Lost(error))
        }
      }
      val closeJob = scope.launch {
        val error = connected.session.awaitClosed()
        signal.trySend(SupervisorSignal.Lost(error))
      }
      synchronized(lock) {
        if (activeEnvironmentId == environmentId && runtime.selectedThreadId != null) {
          startThreadSubscription(runtime)
        }
      }

      var reconnectImmediately = false
      var lostError: Throwable? = null
      connectedLoop@ while (true) {
        when (val next = signal.receive()) {
          SupervisorSignal.Stop -> {
            shellJob.cancel()
            closeJob.cancel()
            connected.session.close()
            return
          }
          SupervisorSignal.Probe -> {
            val result = runCatching {
              withTimeout(ConnectionPolicy.PROBE_TIMEOUT_MS) { client.probe(connected.session) }
            }
            if (result.isFailure) {
              lostError = result.exceptionOrNull()
              break@connectedLoop
            }
          }
          SupervisorSignal.Reconnect, SupervisorSignal.Retry -> {
            reconnectImmediately = true
            break@connectedLoop
          }
          SupervisorSignal.Connectivity -> if (connectivity.status.value == ConnectivityStatus.Offline) {
            reconnectImmediately = true
            break@connectedLoop
          }
          is SupervisorSignal.Lost -> {
            lostError = next.error
            break@connectedLoop
          }
        }
      }
      shellJob.cancel()
      closeJob.cancel()
      connected.session.abort()
      runtime.connection = null
      if (System.currentTimeMillis() - connectedAt >= ConnectionPolicy.STABLE_LEASE_MS) attempt = 0
      if (connectivity.status.value == ConnectivityStatus.Offline) {
        updateConnection(runtime, ConnectionPhase.Offline, null)
        continue
      }
      if (reconnectImmediately) continue
      updateConnection(runtime, ConnectionPhase.Backoff, lostError?.safeMessage())
      val interrupted = withTimeoutOrNull(ConnectionPolicy.retryDelay(attempt)) { signal.receive() }
      if (interrupted == SupervisorSignal.Stop) return
      attempt += 1
    }
  }

  private suspend fun replaceEnvironmentIdentity(
    previousEnvironmentId: String,
    previousRuntime: EnvironmentRuntime,
    connected: ConnectedEnvironment,
  ) {
    val replacement = previousRuntime.environment.copy(
      environmentId = connected.descriptor.environmentId,
      label = connected.descriptor.label,
    )
    val previousActiveId = synchronized(lock) { activeEnvironmentId }

    outboxMutex.withLock {
      synchronized(lock) {
        if (previousActiveId == previousEnvironmentId) {
          activeThreadJob?.cancel()
          activeThreadJob = null
        }
        signals.remove(previousEnvironmentId)
        supervisors.remove(previousEnvironmentId)
        runtimes.remove(previousEnvironmentId)
        pending.values.filter { it.environmentId == previousEnvironmentId }
          .forEach { pending.remove(it.messageId) }
      }

      environmentStore.remove(previousEnvironmentId)
      environmentStore.save(replacement)
      if (previousActiveId != previousEnvironmentId) {
        previousActiveId?.let(environmentStore::select)
      }
      draftStore.clearEnvironment(previousEnvironmentId)

      synchronized(lock) {
        runtimes[replacement.environmentId] = EnvironmentRuntime(
          environment = replacement,
          shell = ShellState(),
        ).apply {
          providerModels = parseProviderModels(connected.config)
          capabilities = connected.descriptor.capabilities.toThreadCapabilities()
        }
        if (previousActiveId == previousEnvironmentId) {
          activeEnvironmentId = replacement.environmentId
        }
        publishLocked()
      }
    }

    ensureSupervisor(replacement, connected)
  }

  private fun startThreadSubscription(runtime: EnvironmentRuntime) {
    if (activeEnvironmentId != runtime.environment.environmentId) return
    val threadId = runtime.selectedThreadId ?: return
    val connected = runtime.connection ?: return
    activeThreadJob?.cancel()
    val generation = runtime.generation
    synchronized(lock) {
      runtime.thread = runtime.thread.awaitingSynchronization()
      runtime.threadSyncPhase = SyncPhase.Synchronizing
      publishLocked()
    }
    activeThreadJob = scope.launch {
      runCatching {
        client.thread(
          connected.session,
          threadId,
          afterSequence = runtime.thread.sequence.takeIf { it >= 0 },
          turnLimit = 50,
        ).collect { item ->
          synchronized(lock) {
            if (runtime.generation != generation || runtime.selectedThreadId != threadId) return@collect
            runtime.thread = runtime.thread.reduce(item)
            runtime.threadSyncPhase = if (runtime.thread.synchronized) {
              SyncPhase.Synchronized
            } else {
              SyncPhase.Synchronizing
            }
            database.saveThread(runtime.environment.environmentId, threadId, runtime.thread)
            publishLocked()
          }
        }
      }.onFailure { error ->
        if (error !is CancellationException) {
          synchronized(lock) {
            runtime.threadSyncPhase = SyncPhase.Error
            runtime.error = error.safeMessage()
            publishLocked()
          }
        }
      }
    }
  }

  private fun scheduleAllDrains() {
    synchronized(lock) {
      pending.values.filter { it.status == PendingTaskStatus.Queued }
        .forEach { scheduleDrain(it.environmentId, it.threadId) }
    }
  }

  private fun scheduleEnvironmentDrains(environmentId: String) {
    synchronized(lock) {
      pending.values.filter {
        it.environmentId == environmentId && it.status == PendingTaskStatus.Queued
      }.forEach { scheduleDrain(it.environmentId, it.threadId) }
    }
  }

  private fun scheduleDrain(environmentId: String, threadId: String) {
    val key = "$environmentId:$threadId"
    drainJobs.compute(key) { _, existing ->
      if (existing?.isActive == true) existing else scope.launch {
        try {
          drain(environmentId, threadId)
        } finally {
          drainJobs.remove(key)
        }
      }
    }
  }

  private suspend fun drain(environmentId: String, threadId: String) {
    while (true) {
      val task = synchronized(lock) {
        pending.values.firstOrNull {
          it.environmentId == environmentId &&
            it.threadId == threadId &&
            it.status == PendingTaskStatus.Queued
        }
      } ?: return
      val runtime = synchronized(lock) { runtimes[environmentId] } ?: return
      if (runtime.connectionPhase != ConnectionPhase.Connected ||
        runtime.shellSyncPhase != SyncPhase.Synchronized) return
      val wait = task.nextAttemptAt - System.currentTimeMillis()
      if (wait > 0) delay(wait)
      val sending = outboxMutex.withLock {
        val current = synchronized(lock) { pending[task.messageId] }
        val claimed = OutboxPolicy.claimForSend(
          current = current,
          environmentId = environmentId,
          threadId = threadId,
          nowMs = System.currentTimeMillis(),
        ) ?: return@withLock null
        database.savePending(claimed)
        synchronized(lock) {
          pending[claimed.messageId] = claimed
          publishLocked()
        }
        claimed
      } ?: continue
      val result = runCatching {
        val session = requireNotNull(runtime.connection).session
        sending.settings.forEach { client.dispatch(session, it as JsonObject) }
        val start = startCommand(sending.command)
        if (sending.createsThread) client.recoverAtomicStart(session, start)
        else client.dispatch(session, sending.command)
      }
      if (result.isSuccess) {
        outboxMutex.withLock {
          database.removePending(sending.messageId)
          synchronized(lock) {
            pending.remove(sending.messageId)
            publishLocked()
          }
        }
        continue
      }
      val error = requireNotNull(result.exceptionOrNull())
      if (error is CancellationException) throw error
      val now = System.currentTimeMillis()
      val failed = if (OutboxPolicy.isTransient(error)) {
        sending.copy(
          status = PendingTaskStatus.Queued,
          attempt = sending.attempt + 1,
          nextAttemptAt = OutboxPolicy.nextAttemptAt(now, sending.attempt),
          error = error.safeMessage(),
        )
      } else {
        sending.copy(status = PendingTaskStatus.Failed, error = error.safeMessage())
      }
      val retained = outboxMutex.withLock {
        val current = synchronized(lock) { pending[sending.messageId] }
        if (current?.status != PendingTaskStatus.Sending) return@withLock false
        database.savePending(failed)
        synchronized(lock) {
          pending[failed.messageId] = failed
          publishLocked()
        }
        true
      }
      if (!retained) return
      if (failed.status == PendingTaskStatus.Failed) return
    }
  }

  private fun reconnect(environmentId: String) {
    synchronized(lock) {
      runtimes[environmentId]?.connection?.session?.abort()
      signals[environmentId]?.trySend(SupervisorSignal.Reconnect)
    }
  }

  private suspend fun openConnection(environment: SavedEnvironment): ConnectedEnvironment =
    when (environment.kind) {
      EnvironmentKind.Bearer -> client.reconnect(environment.environmentId)
      EnvironmentKind.Relay -> {
        val accountId = requireNotNull(cloud.accountId ?: Clerk.user?.id) {
          "Sign in to T3 Connect to reconnect relay environments."
        }
        connectClient.connect(environment.environmentId, accountId)
      }
    }

  private suspend fun refreshCloudAuth(refreshRelayList: Boolean) {
    val user = Clerk.user
    val session = Clerk.activeSession
    if (user == null || session == null) {
      synchronized(lock) {
        cloud = CloudAuthState(
          signedIn = false,
          pendingEmailCode = cloud.pendingEmailCode,
        )
        publishLocked()
      }
      return
    }
    val label = user.primaryEmailAddress?.emailAddress
      ?: user.username
      ?: user.id
    val relay = if (refreshRelayList) {
      runCatching { connectClient.listEnvironments() }
        .fold(
          onSuccess = { it to null },
          onFailure = { emptyList<RelayEnvironment>() to it.safeMessage() },
        )
    } else {
      cloud.relayEnvironments to cloud.lastError
    }
    synchronized(lock) {
      cloud = CloudAuthState(
        signedIn = true,
        accountId = user.id,
        accountLabel = label,
        relayEnvironments = relay.first,
        lastError = relay.second,
        pendingEmailCode = null,
      )
      publishLocked()
    }
  }

  private fun connectedActiveRuntime(): EnvironmentRuntime {
    val runtime = synchronized(lock) { activeRuntimeLocked() }
      ?: error("No active environment.")
    check(runtime.connectionPhase == ConnectionPhase.Connected) { "Environment is disconnected." }
    check(runtime.shellSyncPhase == SyncPhase.Synchronized) { "Shell is not synchronized." }
    return runtime
  }

  private fun connectedRuntime(environmentId: String): EnvironmentRuntime {
    val runtime = synchronized(lock) { runtimes[environmentId] }
      ?: error("Unknown environment: $environmentId")
    check(runtime.connectionPhase == ConnectionPhase.Connected) { "Environment is disconnected." }
    check(runtime.shellSyncPhase == SyncPhase.Synchronized) { "Shell is not synchronized." }
    return runtime
  }

  private fun updateConnection(
    runtime: EnvironmentRuntime,
    phase: ConnectionPhase,
    error: String?,
  ) {
    synchronized(lock) {
      runtime.connectionPhase = phase
      runtime.error = error
      if (phase != ConnectionPhase.Connected && runtime.shell.sequence >= 0) {
        runtime.shellSyncPhase = SyncPhase.Cached
      }
      publishLocked()
    }
  }

  private fun activeRuntimeLocked() = activeEnvironmentId?.let(runtimes::get)

  private fun publishLocked() {
    val active = activeRuntimeLocked()
    mutableState.value = OnlineChatState(
      environments = runtimes.values.map(EnvironmentRuntime::environment),
      environmentStatuses = runtimes.values.associate { runtime ->
        runtime.environment.environmentId to EnvironmentConnectionStatus(
          environment = runtime.environment,
          connectionPhase = runtime.connectionPhase,
          shellSyncPhase = runtime.shellSyncPhase,
          error = runtime.error,
        )
      },
      environment = active?.environment,
      connectionPhase = active?.connectionPhase ?: ConnectionPhase.Empty,
      shellSyncPhase = active?.shellSyncPhase ?: SyncPhase.Idle,
      threadSyncPhase = active?.threadSyncPhase ?: SyncPhase.Idle,
      shell = active?.shell ?: ShellState(),
      environmentShells = runtimes.mapValues { (_, runtime) -> runtime.shell },
      selectedThreadId = active?.selectedThreadId,
      thread = active?.thread ?: ThreadState(),
      providerModels = active?.providerModels.orEmpty(),
      projectFavicons = active?.projectFavicons?.toMap().orEmpty(),
      pendingTasks = pending.values.filter { it.environmentId == activeEnvironmentId },
      threadCapabilities = active?.capabilities ?: ThreadCapabilities(),
      settings = appSettings,
      cloud = cloud,
      error = active?.error,
    )
  }

  private fun resolveProjectFavicons(
    environmentId: String,
    runtime: EnvironmentRuntime,
    session: com.t3tools.android.protocol.EffectRpcSession,
  ) {
    val unresolve = runtime.shell.projects.values.filter { it.id !in runtime.projectFavicons }
    if (unresolve.isEmpty()) return
    scope.launch {
      for (project in unresolve) {
        val rel = client.createAssetToken(session, "project-favicon", project.workspaceRoot)
        if (rel != null && !rel.endsWith("project-favicon-missing")) {
          val fullUrl = runtime.environment.httpBaseUrl.removeSuffix("/") + rel
          synchronized(lock) {
            runtime.projectFavicons[project.id] = fullUrl
            publishLocked()
          }
        }
      }
    }
  }

  override fun close() {
    activeThreadJob?.cancel()
    synchronized(lock) {
      signals.values.forEach { it.trySend(SupervisorSignal.Stop) }
      runtimes.values.forEach { it.connection?.session?.close() }
    }
    scope.cancel()
    connectivity.close()
    database.close()
    connectClient.close()
    client.close()
  }

  private data class EnvironmentRuntime(
    var environment: SavedEnvironment,
    var connectionPhase: ConnectionPhase = ConnectionPhase.Empty,
    var shellSyncPhase: SyncPhase = SyncPhase.Idle,
    var threadSyncPhase: SyncPhase = SyncPhase.Idle,
    var shell: ShellState = ShellState(),
    var selectedThreadId: String? = null,
    var thread: ThreadState = ThreadState(),
    var providerModels: List<com.t3tools.android.protocol.ProviderModel> = emptyList(),
    val projectFavicons: MutableMap<String, String> = mutableMapOf(),
    var capabilities: ThreadCapabilities = ThreadCapabilities(),
    var error: String? = null,
    var connection: ConnectedEnvironment? = null,
    var generation: Long = 0,
  )

  private sealed interface SupervisorSignal {
    data object Retry : SupervisorSignal
    data object Connectivity : SupervisorSignal
    data object Probe : SupervisorSignal
    data object Reconnect : SupervisorSignal
    data object Stop : SupervisorSignal
    data class Lost(val error: Throwable?) : SupervisorSignal
  }
}

private fun Throwable.safeMessage() = message?.take(240) ?: "Unexpected connection failure."

private fun ClerkResult.Failure<*>.clerkMessage(fallback: String): String {
  val response = error as? ClerkErrorResponse
  val detail = response?.errors?.firstOrNull()?.let { err ->
    err.longMessage?.takeIf(String::isNotBlank) ?: err.message?.takeIf(String::isNotBlank)
  } ?: throwable?.message ?: error?.toString()
  return humanizeAuthError(detail ?: fallback)
}

internal fun humanizeAuthError(raw: String): String {
  val lower = raw.lowercase()
  return when {
    "redirect" in lower && ("mismatch" in lower || "authorized redirect" in lower) ->
      "Google/OAuth is blocked: this experimental app’s redirect URL is not allowlisted in Clerk yet " +
        "(clerk://com.t3tools.t3code.native.experimental.callback)."
    else -> raw.lineSequence().firstOrNull { it.isNotBlank() }?.take(180) ?: "Sign-in failed."
  }
}

private fun JsonObject.toThreadCapabilities() = ThreadCapabilities(
  settlement = this["threadSettlement"]?.toString() == "true",
  snooze = this["threadSnooze"]?.toString() == "true",
  pinning = this["threadPinning"]?.toString() == "true",
  pinReorder = this["threadPinReorder"]?.toString() == "true",
)
