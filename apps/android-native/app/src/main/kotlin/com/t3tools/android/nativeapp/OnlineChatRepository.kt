package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.AtomicStartResult
import com.t3tools.android.protocol.ConnectedEnvironment
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.StartCommand
import com.t3tools.android.protocol.T3ProtocolClient
import com.t3tools.android.protocol.ThreadState
import com.t3tools.android.protocol.parseProviderModels
import com.t3tools.android.protocol.reduce
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

enum class ConnectionPhase { Empty, Connecting, Connected, Error }
enum class SyncPhase { Idle, Synchronizing, Synchronized, Error }

data class OnlineChatState(
  val environment: SavedEnvironment? = null,
  val connectionPhase: ConnectionPhase = ConnectionPhase.Empty,
  val shellSyncPhase: SyncPhase = SyncPhase.Idle,
  val threadSyncPhase: SyncPhase = SyncPhase.Idle,
  val shell: ShellState = ShellState(),
  val selectedThreadId: String? = null,
  val thread: ThreadState = ThreadState(),
  val providerModels: List<com.t3tools.android.protocol.ProviderModel> = emptyList(),
  val error: String? = null,
)

class OnlineChatRepository(
  private val client: T3ProtocolClient,
  private val credentialStore: AndroidCredentialStore,
  private val environmentStore: EnvironmentStore,
  private val draftStore: DraftStore,
) : AutoCloseable {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val mutableState = MutableStateFlow(
    OnlineChatState(environment = environmentStore.load()),
  )
  val state: StateFlow<OnlineChatState> = mutableState.asStateFlow()

  private var connection: ConnectedEnvironment? = null
  private var shellJob: Job? = null
  private var threadJob: Job? = null

  suspend fun restore() {
    val environment = environmentStore.load() ?: return
    connect(environment) { client.reconnect(environment.environmentId) }
  }

  suspend fun pair(pairingUrl: String) {
    connect(null) {
      client.pairAndConnect(pairingUrl).also { connected ->
        val saved = SavedEnvironment(
          environmentId = connected.descriptor.environmentId,
          label = connected.descriptor.label,
          httpBaseUrl = pairingUrl.substringBefore("/pair").substringBefore('#'),
        )
        environmentStore.save(saved)
      }
    }
  }

  suspend fun retry() {
    val environment = requireNotNull(environmentStore.load()) { "No saved environment." }
    connect(environment) { client.reconnect(environment.environmentId) }
  }

  suspend fun updateEnvironment(label: String, httpBaseUrl: String) {
    val environment = requireNotNull(environmentStore.load()) { "No saved environment." }
    val credential = requireNotNull(credentialStore.load(environment.environmentId)) {
      "No saved credential."
    }
    val updated = environment.copy(label = label.trim(), httpBaseUrl = httpBaseUrl.trim())
    credentialStore.save(credential.copy(httpBaseUrl = updated.httpBaseUrl))
    environmentStore.save(updated)
    retry()
  }

  suspend fun forget() {
    val environment = environmentStore.load()
    disconnect()
    if (environment != null) {
      credentialStore.clear(environment.environmentId)
      draftStore.clearEnvironment(environment.environmentId)
    }
    environmentStore.clear()
    mutableState.value = OnlineChatState()
  }

  fun selectThread(threadId: String) {
    if (mutableState.value.selectedThreadId == threadId && threadJob?.isActive == true) return
    threadJob?.cancel()
    mutableState.update {
      it.copy(
        selectedThreadId = threadId,
        thread = ThreadState(),
        threadSyncPhase = SyncPhase.Synchronizing,
      )
    }
    val session = connection?.session ?: return
    threadJob = scope.launch {
      runCatching {
        client.thread(session, threadId, turnLimit = 50).collect { item ->
          mutableState.update { current ->
            val reduced = current.thread.reduce(item)
            current.copy(
              thread = reduced,
              threadSyncPhase = if (reduced.synchronized) {
                SyncPhase.Synchronized
              } else {
                SyncPhase.Synchronizing
              },
            )
          }
        }
      }.onFailure { error ->
        if (error is CancellationException) return@onFailure
        mutableState.update {
          it.copy(threadSyncPhase = SyncPhase.Error, error = error.safeMessage())
        }
      }
    }
  }

  fun clearSelectedThread() {
    threadJob?.cancel()
    threadJob = null
    mutableState.update {
      it.copy(selectedThreadId = null, thread = ThreadState(), threadSyncPhase = SyncPhase.Idle)
    }
  }

  suspend fun dispatch(command: JsonObject): Long = withContext(Dispatchers.IO) {
    val current = mutableState.value
    check(current.connectionPhase == ConnectionPhase.Connected) { "Environment is disconnected." }
    check(current.shellSyncPhase == SyncPhase.Synchronized) { "Shell is not synchronized." }
    client.dispatch(requireNotNull(connection).session, command)
  }

  suspend fun dispatchAtomicStart(start: StartCommand): AtomicStartResult = withContext(Dispatchers.IO) {
    check(mutableState.value.shellSyncPhase == SyncPhase.Synchronized) { "Shell is not synchronized." }
    client.dispatchAtomicStart(requireNotNull(connection).session, start)
  }

  suspend fun recoverAtomicStart(start: StartCommand): AtomicStartResult = withContext(Dispatchers.IO) {
    client.recoverAtomicStart(requireNotNull(connection).session, start)
  }

  private suspend fun connect(
    environment: SavedEnvironment?,
    open: suspend () -> ConnectedEnvironment,
  ) {
    disconnect()
    mutableState.update {
      it.copy(
        environment = environment ?: environmentStore.load(),
        connectionPhase = ConnectionPhase.Connecting,
        shellSyncPhase = SyncPhase.Idle,
        threadSyncPhase = SyncPhase.Idle,
        shell = ShellState(),
        thread = ThreadState(),
        error = null,
      )
    }
    try {
      val connected = withContext(Dispatchers.IO) { open() }
      connection = connected
      val saved = requireNotNull(environmentStore.load())
      mutableState.update {
        it.copy(
          environment = saved,
          connectionPhase = ConnectionPhase.Connected,
          shellSyncPhase = SyncPhase.Synchronizing,
          providerModels = parseProviderModels(connected.config),
        )
      }
      shellJob = scope.launch {
        runCatching {
          client.shell(connected.session).collect { item ->
            mutableState.update { current ->
              val reduced = current.shell.reduce(item)
              current.copy(
                shell = reduced,
                shellSyncPhase = if (reduced.synchronized) {
                  SyncPhase.Synchronized
                } else {
                  SyncPhase.Synchronizing
                },
              )
            }
          }
        }.onFailure { error ->
          if (error is CancellationException) return@onFailure
          mutableState.update {
            it.copy(shellSyncPhase = SyncPhase.Error, error = error.safeMessage())
          }
        }
      }
    } catch (error: Throwable) {
      if (error is CancellationException) throw error
      mutableState.update {
        it.copy(connectionPhase = ConnectionPhase.Error, error = error.safeMessage())
      }
      throw error
    }
  }

  private fun disconnect() {
    threadJob?.cancel()
    shellJob?.cancel()
    threadJob = null
    shellJob = null
    connection?.session?.close()
    connection = null
  }

  override fun close() {
    disconnect()
    scope.cancel()
    client.close()
  }
}

private fun Throwable.safeMessage() = message?.take(240) ?: "Unexpected connection failure."
