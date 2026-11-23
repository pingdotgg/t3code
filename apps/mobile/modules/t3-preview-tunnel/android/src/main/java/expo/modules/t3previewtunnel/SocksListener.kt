package expo.modules.t3previewtunnel

import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

private const val SEND_HIGH_WATER_BYTES = 1024L * 1024
private const val HANDSHAKE_TIMEOUT_MS = 10_000

// Browsers open about six connections per host; this leaves room for several hosts and sockets.
private const val MAX_CONNECTIONS = 64
private const val MAX_SOCKS4_STRING = 255

internal enum class TunnelFailure(val cause: String) {
  ENVIRONMENT("environment"),
  PORT("port"),
  OUTDATED("outdated");

  companion object {
    /**
     * The environment marks a dead or blocked port. A server from before the tunnel answers the
     * route like any other page; anything else, such as a proxy's 502, means it is out of reach.
     */
    fun classify(status: Int?, portRefused: Boolean): TunnelFailure = when {
      portRefused -> PORT
      status != null && (status in 200..299 || status == 404) -> OUTDATED
      else -> ENVIRONMENT
    }
  }
}

private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

// The webview names the host as typed, so IP literals can also arrive as domain names.
private fun isLoopbackName(name: String): Boolean {
  val host = name.lowercase().removeSuffix(".")
  val literal = host.removePrefix("[").removeSuffix("]")
  val isIpLiteral = literal.all { it.isDigit() || it == '.' || it == ':' || it in 'a'..'f' }
  val isLoopbackIp = isIpLiteral &&
    runCatching { InetAddress.getByName(literal).isLoopbackAddress }.getOrDefault(false)
  return host == "localhost" || host.endsWith(".localhost") || isLoopbackIp
}

/**
 * A SOCKS listener on 127.0.0.1 that carries each loopback CONNECT over one WebSocket to the
 * environment's /api/preview/tunnel. It never connects anywhere on this device, so a tunnel that
 * fails is a connection error, never one of this device's own servers. SOCKS4 is accepted too,
 * because WebView's `socks://` proxy scheme speaks it.
 */
internal class SocksListener(private val requestAccess: () -> String?) {
  private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
  private val sockets = java.util.Collections.newSetFromMap(
    java.util.concurrent.ConcurrentHashMap<Socket, Boolean>()
  )
  val port: Int = server.localPort

  /** Why the latest tunnel failed, or null once one opened. The page's error alone can't tell. */
  @Volatile var lastFailure: TunnelFailure? = null
    private set

  init {
    Thread({
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        // Registration and close() take the same lock, so a socket accepted while the listener
        // closes is dropped instead of starting a worker; a page opens a handful at a time.
        val admitted = synchronized(sockets) {
          !server.isClosed && sockets.size < MAX_CONNECTIONS && sockets.add(socket)
        }
        if (admitted) {
          Thread({ serve(socket) }, "t3-preview-tunnel").apply { isDaemon = true }.start()
        } else {
          runCatching { socket.close() }
        }
      }
    }, "t3-preview-tunnel-accept").apply { isDaemon = true }.start()
  }

  fun close() {
    val open = synchronized(sockets) {
      runCatching { server.close() }
      sockets.toList().also { sockets.clear() }
    }
    for (socket in open) runCatching { socket.close() }
  }

  private sealed interface Handshake {
    data class Connect(val port: Int, val reply: (Boolean) -> ByteArray) : Handshake
    data class Refuse(val reply: ByteArray) : Handshake
  }

  private fun serve(socket: Socket) {
    try {
      // A client that stalls mid-handshake is dropped; the tunnel itself has no deadline.
      socket.soTimeout = HANDSHAKE_TIMEOUT_MS
      val input = DataInputStream(socket.getInputStream())
      val output = socket.getOutputStream()
      val handshake = when (input.readUnsignedByte()) {
        5 -> readSocks5(input, output)
        4 -> readSocks4(input)
        else -> null
      }
      when (handshake) {
        null -> Unit
        is Handshake.Refuse -> output.write(handshake.reply)
        is Handshake.Connect -> connect(socket, input, output, handshake)
      }
    } catch (_: Exception) {
    } finally {
      synchronized(sockets) { sockets.remove(socket) }
      runCatching { socket.close() }
    }
  }

  private fun connect(
    socket: Socket,
    input: DataInputStream,
    output: OutputStream,
    handshake: Handshake.Connect
  ) {
    val base = requestAccess()
    if (base == null) {
      lastFailure = TunnelFailure.ENVIRONMENT
      output.write(handshake.reply(false))
    } else {
      tunnel(socket, input, output, base, handshake)
    }
  }

  @Suppress("ReturnCount") // One refusal per malformed or forbidden request field.
  private fun readSocks5(input: DataInputStream, output: OutputStream): Handshake? {
    val methods = ByteArray(input.readUnsignedByte()).also { input.readFully(it) }
    if (!methods.contains(0)) {
      output.write(byteArrayOf(5, 0xff.toByte()))
      return null
    }
    output.write(byteArrayOf(5, 0))
    val version = input.readUnsignedByte()
    val command = input.readUnsignedByte()
    input.readUnsignedByte()
    val loopback = when (input.readUnsignedByte()) {
      1 -> ByteArray(4).also { input.readFully(it) }[0] == 127.toByte()
      4 -> InetAddress.getByAddress(ByteArray(16).also { input.readFully(it) }).isLoopbackAddress
      3 -> isLoopbackName(String(ByteArray(input.readUnsignedByte()).also { input.readFully(it) }))
      else -> return Handshake.Refuse(socks5Reply(8))
    }
    val port = input.readUnsignedShort()
    if (version != 5 || command != 1) return Handshake.Refuse(socks5Reply(7))
    if (!loopback) return Handshake.Refuse(socks5Reply(2))
    return Handshake.Connect(port) { ok -> socks5Reply(if (ok) 0 else 1) }
  }

  private fun readSocks4(input: DataInputStream): Handshake {
    val command = input.readUnsignedByte()
    val port = input.readUnsignedShort()
    val address = ByteArray(4).also { input.readFully(it) }
    readCString(input)
    // SOCKS4a: 0.0.0.x means a host name follows the user id.
    val isSocks4a = address.take(3).all { it == 0.toByte() } && address[3] != 0.toByte()
    val loopback = if (isSocks4a) {
      isLoopbackName(readCString(input))
    } else {
      address[0] == 127.toByte()
    }
    val refused = byteArrayOf(0, 0x5b, 0, 0, 0, 0, 0, 0)
    if (command != 1 || !loopback) return Handshake.Refuse(refused)
    val granted = byteArrayOf(0, 0x5a, 0, 0, 0, 0, 0, 0)
    return Handshake.Connect(port) { ok -> if (ok) granted else refused }
  }

  private fun readCString(input: DataInputStream): String {
    val bytes = StringBuilder()
    while (bytes.length <= MAX_SOCKS4_STRING) {
      val next = input.readUnsignedByte()
      if (next == 0) return bytes.toString()
      bytes.append(next.toChar())
    }
    throw java.io.IOException("SOCKS4 string too long")
  }

  private fun socks5Reply(code: Int) = byteArrayOf(5, code.toByte(), 0, 1, 0, 0, 0, 0, 0, 0)

  @Suppress("ReturnCount") // Each failed step answers the client and stops.
  private fun tunnel(
    socket: Socket,
    input: DataInputStream,
    output: OutputStream,
    base: String,
    handshake: Handshake.Connect
  ) {
    val url = base.replaceFirst(Regex("^ws"), "http").toHttpUrlOrNull()
      ?.newBuilder()?.addQueryParameter("port", handshake.port.toString())?.build()
    if (url == null) {
      output.write(handshake.reply(false))
      return
    }
    val opened = CompletableFuture<Boolean>()
    var failure = TunnelFailure.ENVIRONMENT
    val replied = CompletableFuture<Unit>()
    val closed = CompletableFuture<Unit>()

    // A server can speak first; its bytes must not reach the page before the SOCKS reply.
    fun writeToPage(webSocket: WebSocket, bytes: ByteArray) {
      runCatching {
        replied.get()
        output.write(bytes)
      }.onFailure { webSocket.cancel() }
    }
    val webSocket = client.newWebSocket(
      Request.Builder().url(url).build(),
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          opened.complete(true)
        }

        // Writing here blocks OkHttp's reader thread, so a page that stops reading stops the
        // tunnel from reading too instead of buffering the response in memory.
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
          writeToPage(webSocket, bytes.toByteArray())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          writeToPage(webSocket, text.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(1000, null)
          closed.complete(Unit)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          if (!opened.isDone) {
            failure = TunnelFailure.classify(
              response?.code,
              response?.header("x-t3-tunnel-port-refused") != null
            )
          }
          opened.complete(false)
          closed.complete(Unit)
        }
      }
    )
    if (!runCatching { opened.get(15, TimeUnit.SECONDS) }.getOrDefault(false)) {
      lastFailure = failure
      replied.completeExceptionally(java.io.IOException("tunnel did not open"))
      webSocket.cancel()
      output.write(handshake.reply(false))
      return
    }
    // The page may have gone while the tunnel opened; then nothing must keep the tunnel alive.
    val sent = runCatching { output.write(handshake.reply(true)) }
    if (sent.isFailure) {
      replied.completeExceptionally(java.io.IOException("SOCKS client went away"))
      webSocket.cancel()
      return
    }
    lastFailure = null
    replied.complete(Unit)
    socket.soTimeout = 0
    val reader = Thread({ sendPageBytes(input, webSocket, closed) }, "t3-preview-tunnel-up")
      .apply { isDaemon = true }
    reader.start()
    closed.get()
    // Let the page read what has already arrived before the connection ends.
    runCatching {
      output.flush()
      socket.shutdownOutput()
    }
    reader.join(1000)
  }

  private fun sendPageBytes(
    input: DataInputStream,
    webSocket: WebSocket,
    closed: CompletableFuture<Unit>
  ) {
    val buffer = ByteArray(64 * 1024)
    try {
      var count = input.read(buffer)
      while (count >= 0) {
        webSocket.send(buffer.toByteString(0, count))
        // OkHttp queues sends without limit and fails the socket past 16 MiB.
        while (webSocket.queueSize() > SEND_HIGH_WATER_BYTES && !closed.isDone) Thread.sleep(5)
        count = input.read(buffer)
      }
      webSocket.close(1000, null)
    } catch (_: Exception) {
      webSocket.cancel()
    }
  }
}
