package com.t3tools.android.protocol

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient

data class ConnectedEnvironment(
  val descriptor: EnvironmentDescriptor,
  val config: JsonObject,
  val session: EffectRpcSession,
)

data class ProjectChoice(
  val id: String,
  val title: String,
  val workspaceRoot: String,
  val defaultModelSelection: JsonObject?,
)

data class ShellSnapshot(
  val sequence: Long,
  val projects: List<ProjectChoice>,
  val threadIds: Set<String>,
  val raw: JsonObject,
)

data class AtomicStartResult(val sequence: Long, val recoveredExistingThread: Boolean)

data class SequencedItem(val sequence: Long, val value: JsonObject)

class SequenceCursor(initialSequence: Long = -1) {
  var sequence = initialSequence
    private set

  fun accept(value: JsonObject): SequencedItem? {
    val event = when (value.stringOrNull("kind")) {
      "event" -> value["event"]?.jsonObject
      "project-upserted", "project-removed", "thread-upserted", "thread-removed" -> value
      else -> null
    } ?: return null
    val next = event["sequence"]?.jsonPrimitive?.long ?: return null
    if (next <= sequence) return null
    sequence = next
    return SequencedItem(next, value)
  }
}

class T3ProtocolClient(
  private val credentialStore: CredentialStore,
) : AutoCloseable {
  private val http = OkHttpClient()
  private val auth = AuthClient(http)

  suspend fun pairAndConnect(pairingUrl: String): ConnectedEnvironment {
    val pairing = auth.pair(pairingUrl)
    credentialStore.save(pairing.credential)
    return try {
      connect(pairing.descriptor, pairing.credential)
    } catch (error: Throwable) {
      credentialStore.clear(pairing.descriptor.environmentId)
      throw error
    }
  }

  suspend fun reconnect(environmentId: String): ConnectedEnvironment {
    val credential = requireNotNull(credentialStore.load(environmentId)) {
      "No saved credential for $environmentId."
    }
    val descriptor = auth.fetchDescriptor(credential.httpBaseUrl)
    require(descriptor.environmentId == environmentId) {
      "Saved environment id does not match the current server descriptor."
    }
    return connect(descriptor, credential)
  }

  fun fetchDescriptor(httpBaseUrl: String) = auth.fetchDescriptor(httpBaseUrl)

  suspend fun connectWithSocket(
    descriptor: EnvironmentDescriptor,
    socketUrl: String,
  ): ConnectedEnvironment = connect(descriptor, socketUrl)

  fun shell(session: EffectRpcSession, afterSequence: Long? = null): Flow<JsonObject> =
    session.stream(
      "orchestration.subscribeShell",
      buildJsonObject(
        "afterSequence" to afterSequence?.let(::JsonPrimitive),
        "requestCompletionMarker" to JsonPrimitive(true),
      ),
    ).mapNotNull { it as? JsonObject }

  fun thread(
    session: EffectRpcSession,
    threadId: String,
    afterSequence: Long? = null,
    turnLimit: Int? = null,
  ): Flow<JsonObject> = session.stream(
    "orchestration.subscribeThread",
    buildJsonObject(
      "threadId" to JsonPrimitive(threadId),
      "afterSequence" to afterSequence?.let(::JsonPrimitive),
      "requestCompletionMarker" to JsonPrimitive(true),
      "turnLimit" to turnLimit?.let(::JsonPrimitive),
    ),
  ).mapNotNull { it as? JsonObject }

  suspend fun dispatch(session: EffectRpcSession, command: JsonObject): Long =
    session.unary("orchestration.dispatchCommand", command)
      .jsonObject.required("sequence").jsonPrimitive.long

  suspend fun dispatchAtomicStart(
    session: EffectRpcSession,
    start: StartCommand,
  ) = AtomicStartResult(dispatch(session, start.command), recoveredExistingThread = false)

  suspend fun recoverAtomicStart(
    session: EffectRpcSession,
    start: StartCommand,
  ): AtomicStartResult {
    var snapshot: ShellSnapshot? = null
    shell(session).first { item ->
      if (item.stringOrNull("kind") == "snapshot") snapshot = item.toShellSnapshot()
      item.stringOrNull("kind") == "synchronized"
    }
    val synchronized = requireNotNull(snapshot) { "Recovery shell did not emit a snapshot." }
    if (start.threadId in synchronized.threadIds) {
      return AtomicStartResult(synchronized.sequence, recoveredExistingThread = true)
    }
    return dispatchAtomicStart(session, start)
  }

  suspend fun probe(session: EffectRpcSession) {
    session.unary("server.probe")
  }

  private suspend fun connect(
    descriptor: EnvironmentDescriptor,
    credential: SavedCredential,
  ): ConnectedEnvironment = connect(descriptor, auth.issueWebSocketUrl(credential))

  private suspend fun connect(
    descriptor: EnvironmentDescriptor,
    socketUrl: String,
  ): ConnectedEnvironment {
    val session = EffectRpcSession.connect(http, socketUrl)
    val config = try {
      session.unary("server.getConfig").jsonObject
    } catch (error: Throwable) {
      session.close()
      throw error
    }
    val configEnvironmentId = config.required("environment")
      .jsonObject.required("environmentId").jsonPrimitive.content
    require(configEnvironmentId == descriptor.environmentId) {
      session.close()
      "WebSocket config environment id did not match the discovered descriptor."
    }
    return ConnectedEnvironment(descriptor, config, session)
  }

  override fun close() {
    http.dispatcher.executorService.shutdown()
    http.connectionPool.evictAll()
    http.cache?.close()
  }
}

fun JsonObject.toShellSnapshot(): ShellSnapshot {
  require(stringOrNull("kind") == "snapshot") { "Expected a shell snapshot item." }
  val snapshot = required("snapshot").jsonObject
  val projects = snapshot.required("projects").jsonArray.map { value ->
    val project = value.jsonObject
    ProjectChoice(
      id = project.required("id").jsonPrimitive.content,
      title = project.required("title").jsonPrimitive.content,
      workspaceRoot = project.required("workspaceRoot").jsonPrimitive.content,
      defaultModelSelection = project["defaultModelSelection"]
        ?.takeUnless { it is JsonNull }
        ?.jsonObject,
    )
  }
  return ShellSnapshot(
    sequence = snapshot.required("snapshotSequence").jsonPrimitive.long,
    projects = projects,
    threadIds = snapshot.required("threads").jsonArray
      .mapTo(mutableSetOf()) { it.jsonObject.required("id").jsonPrimitive.content },
    raw = snapshot,
  )
}

internal fun buildJsonObject(vararg entries: Pair<String, JsonElement?>) = JsonObject(
  entries.mapNotNull { (name, value) -> value?.let { name to it } }.toMap(),
)

internal fun JsonObject.required(name: String) =
  requireNotNull(this[name]) { "Response is missing $name." }

internal fun JsonObject.stringOrNull(name: String) = this[name]?.jsonPrimitive?.content
