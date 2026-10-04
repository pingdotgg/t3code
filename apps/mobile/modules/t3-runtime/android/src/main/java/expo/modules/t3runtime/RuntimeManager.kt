package expo.modules.t3runtime

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Owns the app's installation, Node backend and device-login child processes. */
internal class RuntimeManager private constructor(private val context: Context) {
  companion object {
    @Volatile private var instance: RuntimeManager? = null
    fun get(context: Context): RuntimeManager = instance ?: synchronized(this) {
      instance ?: RuntimeManager(context.applicationContext).also { instance = it }
    }
  }
  val listeners = CopyOnWriteArraySet<(Map<String, Any?>) -> Unit>()
  @Volatile var state: Map<String, Any?> = mapOf("phase" to "stopped", "message" to "", "connection" to null, "login" to mapOf("running" to false, "text" to ""))
    private set
  private val stateLock = Any()
  private val cancelled = AtomicBoolean(false)
  @Volatile private var backend: Process? = null
  @Volatile private var login: Process? = null
  private var installation: File? = null

  private fun publish(values: Map<String, Any?>) {
    val next = synchronized(stateLock) { (state + values).also { state = it } }
    for (listener in listeners) listener(next)
  }

  @Synchronized fun start(): Map<String, Any?> {
    check(state["phase"] != "stopping") { "Wait for the runtime to stop before restarting it" }
    if (backend?.isAlive == true && state["phase"] == "ready") return state
    cancelled.set(false)
    try {
      publish(mapOf("phase" to "installing", "message" to "Setting up Codex and the bundled environment…", "connection" to null))
      val root = RuntimeInstaller(context).install { message ->
        check(!cancelled.get()) { "Runtime setup stopped" }
        if (state["message"] != message) publish(mapOf("message" to message))
      }
      installation = root
      check(!cancelled.get()) { "Runtime setup stopped" }
      val home = File(context.filesDir, "home").apply { mkdirs() }
      File(home, "projects").mkdirs()
      File(home, ".codex").mkdirs()
      File(root, "usr/tmp").mkdirs()
      publish(mapOf("phase" to "starting", "message" to "Starting Codex…"))
      probe(root, File(root, "usr/libexec/node"), listOf("--version"), false)
      probe(root, File(root, "usr/libexec/codex/codex.bin"), listOf("--version"), true)
      val process = launch(root, File(root, "usr/libexec/node"), listOf(File(root, "bundle/apps/runtime/src/bin.ts").absolutePath), false)
      backend = process
      val port = AtomicInteger(0)
      val output = StringBuffer()
      Thread({
        process.inputStream.bufferedReader().useLines { lines -> lines.forEach { line ->
          Regex("^T3 Mobile backend: ws://127\\.0\\.0\\.1:(\\d+)$").find(line)?.let { port.set(it.groupValues[1].toInt()) }
          synchronized(output) { output.append(line).append('\n'); if (output.length > 4000) output.delete(0, output.length - 4000) }
        } }
        process.waitFor()
        synchronized(stateLock) {
          if (backend === process && !cancelled.get()) publish(mapOf("phase" to "error", "message" to "The local backend stopped. Restart it to continue.", "connection" to null))
        }
      }, "t3mobile-backend-output").apply { isDaemon = true; start() }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
      while (System.nanoTime() < deadline) {
        check(!cancelled.get()) { "Runtime startup stopped" }
        check(process.isAlive) { "Cannot start the local backend. ${synchronized(output) { output.toString() }}" }
        if (port.get() > 0 && healthy(port.get())) {
          val token = File(home, ".t3mobile/pairing-token").readText().trim()
          check(token.matches(Regex("[a-f0-9]{64}"))) { "Invalid local pairing credential" }
          synchronized(stateLock) {
            check(!cancelled.get() && backend === process && state["phase"] == "starting") { "Runtime startup stopped" }
            publish(mapOf("phase" to "ready", "message" to "Codex is installed", "connection" to mapOf("url" to "ws://127.0.0.1:${port.get()}", "token" to token, "project" to File(home, "projects").absolutePath)))
          }
          return state
        }
        Thread.sleep(100)
      }
      error("The local backend did not become ready")
    } catch (error: Throwable) {
      backend?.let { terminate(it) }; backend = null
      publish(mapOf("phase" to if (state["phase"] == "stopping") "stopping" else if (cancelled.get()) "stopped" else "error", "message" to (error.message ?: "Runtime setup failed"), "connection" to null))
      throw error
    }
  }

  @Synchronized fun signIn() {
    val process = synchronized(stateLock) {
      check(state["phase"] == "ready" && !cancelled.get()) { "Start the local runtime before signing in" }
      check(login == null) { "Codex sign-in is already running" }
      val root = installation ?: error("Runtime is not installed")
      launch(root, File(root, "usr/libexec/codex/codex.bin"), listOf("login", "--device-auth"), true).also {
        login = it
        publish(mapOf("login" to mapOf("running" to true, "text" to "Requesting a sign-in code…")))
      }
    }
    Thread({
      val text = StringBuilder()
      try {
        process.inputStream.bufferedReader().useLines { lines -> lines.forEach { line ->
          text.append(line.replace(Regex("\\u001B\\[[0-?]*[ -/]*[@-~]"), "")).append('\n')
          if (text.length > 8000) text.delete(0, text.length - 8000)
          synchronized(stateLock) {
            if (login === process) publish(mapOf("login" to mapOf("running" to true, "text" to text.toString())))
          }
        } }
        val code = process.waitFor()
        if (code != 0) text.append("\nSign-in ended. Try again to get a new code.")
      } catch (error: Exception) { text.append("\nSign-in stopped.") }
      finally {
        synchronized(stateLock) {
          if (login === process) { login = null; publish(mapOf("login" to mapOf("running" to false, "text" to text.toString()))) }
        }
      }
    }, "t3mobile-codex-login").apply { isDaemon = true; start() }
  }

  fun stop() {
    captureStop()?.invoke()
  }
  fun stopAsync() {
    captureStop()?.let { finish -> Thread(finish, "t3mobile-runtime-stop").start() }
  }
  private fun captureStop(): (() -> Unit)? = synchronized(stateLock) {
    if (state["phase"] == "stopping" || state["phase"] == "stopped") return@synchronized null
    cancelled.set(true)
    val auth = login; login = null
    val process = backend; backend = null
    publish(mapOf("phase" to "stopping", "message" to "Stopping local agents…", "connection" to null))
    return@synchronized {
      auth?.let { terminate(it) }; process?.let { terminate(it) }
      publish(mapOf("phase" to "stopped", "message" to "Runtime stopped", "connection" to null, "login" to mapOf("running" to false, "text" to "")))
    }
  }

  private fun terminate(process: Process) {
    process.destroy()
    if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); process.waitFor(2, TimeUnit.SECONDS) }
  }
  private fun environment(root: File, codex: Boolean): Map<String, String> {
    val prefix = File(root, "usr").absolutePath
    check(prefix.toByteArray().size < 90) { "The Android runtime directory is too long for this build." }
    val home = File(context.filesDir, "home").absolutePath
    val preload = File(root, "usr/lib/t3mobile-exec-library").readText()
    return mapOf("HOME" to home, "PREFIX" to prefix, "TERMUX__PREFIX" to prefix,
      "TERMUX_APP__DATA_DIR" to context.applicationInfo.dataDir, "TERMUX_APP__LEGACY_DATA_DIR" to "/data/data/${context.packageName}",
      "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE" to "force", "TERMUX_EXEC__EXECVE_CALL__INTERCEPT" to "enable",
      "PATH" to "$prefix/bin:/system/bin", "LD_PRELOAD" to File(root, preload).absolutePath,
      "LD_LIBRARY_PATH" to (if (codex) "$prefix/libexec/codex:$prefix/lib" else "$prefix/lib"),
      "TMPDIR" to "$prefix/tmp", "SHELL" to "$prefix/bin/bash", "BASH_ENV" to "", "ENV" to "",
      "GIT_EXEC_PATH" to "$prefix/libexec/git-core", "GIT_TEMPLATE_DIR" to "$prefix/share/git-core/templates",
      "SSL_CERT_FILE" to "$prefix/etc/tls/cert.pem", "GIT_SSL_CAINFO" to "$prefix/etc/tls/cert.pem",
      "NODE_EXTRA_CA_CERTS" to "$prefix/etc/tls/cert.pem", "OPENSSL_CONF" to "$prefix/etc/tls/openssl.cnf",
      "CODEX_HOME" to "$home/.codex", "CODEX_SELF_EXE" to "$prefix/libexec/codex/codex.bin",
      "T3MOBILE_HOME" to "$home/.t3mobile", "T3MOBILE_PORT" to "0", "T3MOBILE_CODEX_BIN" to "$prefix/bin/codex",
      "npm_config_prefix" to prefix, "npm_config_cache" to "$home/.npm", "TERM" to "xterm-256color")
  }
  private fun launch(root: File, executable: File, arguments: List<String>, codex: Boolean): Process {
    val builder = ProcessBuilder(listOf("/system/bin/linker64", executable.absolutePath) + arguments)
      .directory(File(context.filesDir, "home")).redirectErrorStream(true)
    builder.environment().putAll(environment(root, codex))
    return builder.start()
  }
  private fun probe(root: File, executable: File, arguments: List<String>, codex: Boolean) {
    val process = launch(root, executable, arguments, codex)
    val output = StringBuffer()
    val reader = Thread({ process.inputStream.bufferedReader().useLines { lines -> lines.forEach { output.append(it.take(1000)).append('\n') } } }).apply { isDaemon = true; start() }
    if (!process.waitFor(15, TimeUnit.SECONDS)) { terminate(process); error("${executable.name} did not start") }
    reader.join(1000)
    check(process.exitValue() == 0) { "${executable.name} cannot run on this phone. $output" }
  }
  private fun healthy(port: Int): Boolean = try {
    val request = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
    try { request.connectTimeout = 500; request.readTimeout = 500; request.responseCode == 200 } finally { request.disconnect() }
  } catch (_: Exception) { false }
}
