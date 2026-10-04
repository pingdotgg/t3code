package expo.modules.t3runtime

import android.content.Context
import android.os.Build
import android.system.Os
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** Installs only verified APK assets. User projects and credentials are outside version folders. */
internal class RuntimeInstaller(private val context: Context) {
  fun install(progress: (String) -> Unit): File {
    check(Build.SUPPORTED_ABIS.firstOrNull() == "arm64-v8a") { "This build needs an ARM64 Android phone." }
    val manifest = context.assets.open("t3-runtime/manifest.json").bufferedReader().use { JSONObject(it.readText()) }
    val version = manifest.getString("version")
    check(version.matches(Regex("[a-f0-9]{64}"))) { "Invalid runtime version" }
    val base = File(context.filesDir, "runtime/versions").apply { mkdirs() }
    // termux-exec's prefix buffer is 90 bytes; keep the installed path short.
    val destination = File(base, version.take(12))
    val marker = File(destination, ".installed")
    if (marker.isFile && marker.readText() == version) return destination
    val stage = File(base, "${version.take(12)}.installing")
    stage.deleteRecursively(); check(stage.mkdirs()) { "Cannot create runtime directory" }
    try {
      val records = manifest.getJSONArray("files")
      val expected = (0 until records.length()).associate { index ->
        val record = records.getJSONObject(index); record.getString("path") to record
      }.toMutableMap()
      ZipInputStream(context.assets.open("t3-runtime/runtime.zip")).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          val record = expected.remove(entry.name) ?: error("Unexpected runtime file")
          val output = safeFile(stage, entry.name)
          output.parentFile!!.mkdirs()
          val digest = MessageDigest.getInstance("SHA-256")
          var count = 0L
          output.outputStream().use { stream ->
            val buffer = ByteArray(65536)
            while (true) {
              val read = zip.read(buffer); if (read < 0) break
              count += read; check(count <= record.getLong("size")) { "Runtime file is too large" }
              digest.update(buffer, 0, read); stream.write(buffer, 0, read)
            }
          }
          check(count == record.getLong("size") && digest.digest().joinToString("") { "%02x".format(it) } == record.getString("sha256")) { "Runtime file failed verification" }
          output.setReadable(true, true); output.setWritable(true, true)
          check(!record.getBoolean("executable") || output.setExecutable(true, true)) { "Cannot set runtime permissions" }
          progress("Installing the bundled environment…")
          zip.closeEntry(); entry = zip.nextEntry
        }
      }
      check(expected.isEmpty()) { "The bundled runtime is incomplete" }
      val prefix = File(destination, "usr").absolutePath
      for (index in 0 until records.length()) {
        val record = records.getJSONObject(index)
        if (record.getBoolean("relocate")) {
          val file = safeFile(stage, record.getString("path"))
          file.writeBytes(file.readBytes().toString(Charsets.UTF_8).replace("/data/data/com.termux/files/usr", prefix).toByteArray())
        }
      }
      val links = manifest.getJSONObject("links")
      for (name in links.keys()) {
        val link = safeFile(stage, name)
        val target = links.getString(name)
        check(!target.startsWith("/") && File(link.parentFile, target).canonicalPath.startsWith(stage.canonicalPath + "/")) { "Invalid runtime link" }
        link.parentFile!!.mkdirs(); link.delete(); Os.symlink(target, link.absolutePath)
      }
      destination.deleteRecursively()
      check(stage.renameTo(destination)) { "Cannot activate the installed runtime" }
      File(destination, ".installed").writeText(version)
      return destination
    } catch (error: Throwable) {
      stage.deleteRecursively(); throw error
    }
  }

  private fun safeFile(root: File, path: String): File {
    val file = File(root, path)
    check(!path.startsWith("/") && file.canonicalPath.startsWith(root.canonicalPath + "/")) { "Invalid runtime path" }
    return file
  }
}
