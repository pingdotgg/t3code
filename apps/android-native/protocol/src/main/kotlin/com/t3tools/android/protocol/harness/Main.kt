package com.t3tools.android.protocol.harness

import com.t3tools.android.protocol.ConnectedEnvironment
import com.t3tools.android.protocol.InMemoryCredentialStore
import com.t3tools.android.protocol.SequenceCursor
import com.t3tools.android.protocol.T3ProtocolClient
import com.t3tools.android.protocol.atomicStartCommand
import com.t3tools.android.protocol.chooseModel
import com.t3tools.android.protocol.interruptCommand
import com.t3tools.android.protocol.stringOrNull
import com.t3tools.android.protocol.toShellSnapshot
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

private const val DEFAULT_TIMEOUT_MILLIS = 120_000L

fun main() = runBlocking {
  val pairingUrl = requireEnv("T3_NATIVE_PAIRING_URL")
  val requestedProjectId = System.getenv("T3_NATIVE_PROJECT_ID")?.trim()?.takeIf { it.isNotEmpty() }
  val prompt = System.getenv("T3_NATIVE_PROMPT")?.takeIf { it.isNotBlank() }
    ?: "Count slowly from one to twenty, one number per line."
  val timeoutMillis = System.getenv("T3_NATIVE_TIMEOUT_MS")?.toLongOrNull()
    ?: DEFAULT_TIMEOUT_MILLIS
  val store = InMemoryCredentialStore()
  val client = T3ProtocolClient(credentialStore = store)
  var initial: ConnectedEnvironment? = null
  var resumed: ConnectedEnvironment? = null

  try {
    withTimeout(timeoutMillis) {
      initial = client.pairAndConnect(pairingUrl)
      val initialConnection = requireNotNull(initial)
      println(
        "paired environment=${initialConnection.descriptor.environmentId} " +
          "version=${initialConnection.descriptor.serverVersion}",
      )

      var shellSnapshot = null as com.t3tools.android.protocol.ShellSnapshot?
      client.shell(initialConnection.session).first { item ->
        if (item.stringOrNull("kind") == "snapshot") shellSnapshot = item.toShellSnapshot()
        item.stringOrNull("kind") == "synchronized"
      }
      val shell = requireNotNull(shellSnapshot) { "Shell subscription did not emit a snapshot." }
      val project = requestedProjectId
        ?.let { id -> shell.projects.firstOrNull { it.id == id } }
        ?: shell.projects.firstOrNull()
        ?: error("The environment has no project for the Phase 0 proof.")
      val model = chooseModel(initialConnection.config, project)
      println("shell synchronized sequence=${shell.sequence} project=${project.id}")

      val start = atomicStartCommand(project, model, prompt)
      val started = client.dispatchAtomicStart(initialConnection.session, start)
      val recovered = client.recoverAtomicStart(initialConnection.session, start)
      check(recovered.recoveredExistingThread) { "Atomic retry recovery did not find the thread." }
      println(
        "task created atomically thread=${start.threadId} " +
          "sequence=${started.sequence} retry=recovered-existing",
      )

      var threadSequence = -1L
      client.thread(initialConnection.session, start.threadId).first { item ->
        when (item.stringOrNull("kind")) {
          "snapshot" -> threadSequence = item["snapshot"]!!.jsonObject["snapshotSequence"]!!
            .jsonPrimitive.long
          "event" -> threadSequence = maxOf(
            threadSequence,
            item["event"]!!.jsonObject["sequence"]!!.jsonPrimitive.long,
          )
        }
        item.containsAssistantText()
      }
      println("assistant output streamed through sequence=$threadSequence")

      val interruptSequence = client.dispatch(
        initialConnection.session,
        interruptCommand(start.threadId),
      )
      println("turn interrupted sequence=$interruptSequence")
      initialConnection.session.abort()
      initialConnection.session.awaitClosed()

      resumed = client.reconnect(initialConnection.descriptor.environmentId)
      val resumedConnection = requireNotNull(resumed)
      client.probe(resumedConnection.session)
      val shellCursor = SequenceCursor(shell.sequence)
      client.shell(resumedConnection.session, shell.sequence).first { item ->
        shellCursor.accept(item)
        item.stringOrNull("kind") == "synchronized"
      }
      val threadCursor = SequenceCursor(threadSequence)
      client.thread(resumedConnection.session, start.threadId, threadSequence).first { item ->
        threadCursor.accept(item)
        item.stringOrNull("kind") == "synchronized"
      }
      println(
        "reconnected and resumed shell=${shellCursor.sequence} " +
          "thread=${threadCursor.sequence} without duplicates",
      )
      resumedConnection.session.close()
    }
  } finally {
    resumed?.session?.close()
    initial?.session?.close()
    client.close()
  }
}

private fun requireEnv(name: String) = System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
  ?: error("$name is required.")

private fun JsonElement.containsAssistantText(): Boolean = when (this) {
  is JsonObject -> {
    val role = this["role"] as? JsonPrimitive
    val text = this["text"] as? JsonPrimitive
    (role?.content == "assistant" && !text?.content.isNullOrEmpty()) ||
      values.any { it.containsAssistantText() }
  }
  is JsonArray -> any { it.containsAssistantText() }
  else -> false
}
