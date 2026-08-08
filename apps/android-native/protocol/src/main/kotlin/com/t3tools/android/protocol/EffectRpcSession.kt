package com.t3tools.android.protocol

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class RpcFailure(val causes: JsonArray) : RuntimeException("RPC failed: $causes")
class RpcDefect(defect: JsonElement) : RuntimeException("RPC defect: $defect")
class RpcProtocolException(message: String) : RuntimeException(message)
class RpcTransportException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

class EffectRpcSession private constructor(
  private val http: OkHttpClient,
  private val json: Json,
  private val keepAliveIntervalMillis: Long,
) : AutoCloseable {
  private sealed interface Pending {
    class Unary(val result: CompletableDeferred<JsonElement>) : Pending
    class Stream(val values: Channel<JsonElement>) : Pending
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val opened = CompletableDeferred<Unit>()
  private val closed = CompletableDeferred<Throwable?>()
  private val requestIds = AtomicLong(0)
  private val missedPongs = AtomicInteger(0)
  private val pending = ConcurrentHashMap<Long, Pending>()
  private lateinit var socket: WebSocket

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      opened.complete(Unit)
      startKeepAlive()
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      runCatching { handle(json.parseToJsonElement(text).jsonObject) }
        .onFailure { failProtocol(it) }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, reason)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      finish(RpcTransportException("WebSocket closed ($code): $reason"))
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      val failure = RpcTransportException("WebSocket transport failed.", error)
      opened.completeExceptionally(failure)
      finish(failure)
    }
  }

  suspend fun unary(tag: String, payload: JsonElement = JsonObject(emptyMap())): JsonElement {
    val id = requestIds.incrementAndGet()
    val result = CompletableDeferred<JsonElement>()
    pending[id] = Pending.Unary(result)
    sendRequest(id, tag, payload)
    return try {
      result.await()
    } finally {
      if (pending.remove(id) != null) sendInterrupt(id)
    }
  }

  fun stream(tag: String, payload: JsonElement = JsonObject(emptyMap())): Flow<JsonElement> = flow {
    val id = requestIds.incrementAndGet()
    val values = Channel<JsonElement>(Channel.UNLIMITED)
    pending[id] = Pending.Stream(values)
    sendRequest(id, tag, payload)
    try {
      for (value in values) emit(value)
    } finally {
      if (pending.remove(id) != null) sendInterrupt(id)
      values.cancel()
    }
  }

  suspend fun awaitClosed(): Throwable? = closed.await()

  fun abort() {
    socket.cancel()
  }

  override fun close() {
    if (closed.isCompleted) return
    socket.send(json.encodeToString(JsonObject.serializer(), tagged("Eof")))
    socket.close(1000, "client closed")
    finish(null)
  }

  private fun sendRequest(id: Long, tag: String, payload: JsonElement) {
    send(
      JsonObject(
        mapOf(
          "_tag" to JsonPrimitive("Request"),
          "id" to JsonPrimitive(id),
          "tag" to JsonPrimitive(tag),
          "payload" to payload,
          "headers" to JsonArray(emptyList()),
        ),
      ),
    )
  }

  private fun sendInterrupt(id: Long) {
    send(tagged("Interrupt", id))
  }

  private fun handle(message: JsonObject) {
    when (val tag = message.string("_tag")) {
      "Chunk" -> {
        val requestId = message.requestId()
        val stream = pending[requestId] as? Pending.Stream ?: return
        message.required("values").jsonArray.forEach { stream.values.trySend(it) }
        send(tagged("Ack", requestId))
      }
      "Exit" -> handleExit(message)
      "Defect" -> failAll(RpcDefect(message.required("defect")))
      "Pong" -> missedPongs.set(0)
      "ClientProtocolError" -> failProtocol(
        RpcProtocolException("Server rejected the RPC protocol: ${message["error"]}"),
      )
      else -> failProtocol(RpcProtocolException("Unknown Effect RPC envelope: $tag"))
    }
  }

  private fun handleExit(message: JsonObject) {
    val requestId = message.requestId()
    val entry = pending.remove(requestId) ?: return
    val exit = message.required("exit").jsonObject
    when (exit.string("_tag")) {
      "Success" -> when (entry) {
        is Pending.Unary -> entry.result.complete(exit["value"] ?: JsonNull)
        is Pending.Stream -> entry.values.close()
      }
      "Failure" -> fail(entry, RpcFailure(exit.required("cause").jsonArray))
      else -> fail(entry, RpcProtocolException("Unknown RPC exit: ${exit["_tag"]}"))
    }
  }

  private fun startKeepAlive() {
    scope.launch {
      while (isActive) {
        delay(keepAliveIntervalMillis)
        if (missedPongs.getAndIncrement() >= 2) {
          val error = RpcTransportException("WebSocket missed three Pong responses.")
          failAll(error)
          socket.cancel()
          return@launch
        }
        send(tagged("Ping"))
      }
    }
  }

  private fun tagged(tag: String, requestId: Long? = null) = JsonObject(
    buildMap {
      put("_tag", JsonPrimitive(tag))
      requestId?.let { put("requestId", JsonPrimitive(it)) }
    },
  )

  private fun send(message: JsonObject) {
    check(socket.send(json.encodeToString(JsonObject.serializer(), message))) {
      "WebSocket is not accepting RPC messages."
    }
  }

  private fun failProtocol(error: Throwable) {
    failAll(error)
    socket.close(1002, "protocol error")
  }

  private fun failAll(error: Throwable) {
    pending.values.forEach { fail(it, error) }
    pending.clear()
  }

  private fun fail(entry: Pending, error: Throwable) {
    when (entry) {
      is Pending.Unary -> entry.result.completeExceptionally(error)
      is Pending.Stream -> entry.values.close(error)
    }
  }

  private fun finish(error: Throwable?) {
    if (closed.complete(error)) {
      failAll(error ?: RpcTransportException("WebSocket session closed."))
      scope.cancel()
    }
  }

  private fun JsonObject.required(name: String) =
    requireNotNull(this[name]) { "RPC envelope is missing $name." }

  private fun JsonObject.string(name: String) = required(name).jsonPrimitive.content

  private fun JsonObject.requestId() = required("requestId").jsonPrimitive.long

  companion object {
    suspend fun connect(
      http: OkHttpClient,
      url: String,
      json: Json = Json { ignoreUnknownKeys = true },
      keepAliveIntervalMillis: Long = 5_000,
    ): EffectRpcSession {
      val session = EffectRpcSession(http, json, keepAliveIntervalMillis)
      session.socket = http.newWebSocket(Request.Builder().url(url).build(), session.listener)
      try {
        withTimeout(15_000) { session.opened.await() }
      } catch (error: Throwable) {
        session.socket.cancel()
        throw error
      }
      return session
    }
  }
}
