package com.t3tools.android.nativeapp

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

const val MaxComposerAttachments = 8
const val MaxComposerImageBytes = 10L * 1024 * 1024

@Serializable
data class DraftImageAttachment(
  val id: String,
  val name: String,
  val mimeType: String,
  val sizeBytes: Long,
  val path: String,
)

data class AttachmentImportResult(
  val attachments: List<DraftImageAttachment>,
  val error: String? = null,
)

class AttachmentStore(private val context: Context) {
  private val root = File(context.filesDir, "composer-images")
  private val fileLock = Any()

  suspend fun import(
    environmentId: String,
    uris: List<Uri>,
    existingCount: Int,
  ) = withContext(Dispatchers.IO) {
    synchronized(fileLock) {
      val remaining = (MaxComposerAttachments - existingCount).coerceAtLeast(0)
      if (remaining == 0) {
        return@synchronized AttachmentImportResult(
          emptyList(),
          "You can attach up to $MaxComposerAttachments images per message.",
        )
      }
      val imported = mutableListOf<DraftImageAttachment>()
      var error: String? = if (uris.size > remaining) {
        "Only the first $remaining selected images were added."
      } else {
        null
      }
      uris.take(remaining).forEach { uri ->
        runCatching { importOne(environmentId, uri) }
          .onSuccess(imported::add)
          .onFailure { failure -> error = failure.message ?: "Could not add image." }
      }
      AttachmentImportResult(imported, error)
    }
  }

  suspend fun importIncoming(
    environmentId: String,
    images: List<IncomingShareImage>,
    existingCount: Int,
  ) = withContext(Dispatchers.IO) {
    synchronized(fileLock) {
      val remaining = (MaxComposerAttachments - existingCount).coerceAtLeast(0)
      if (remaining == 0) {
        return@synchronized AttachmentImportResult(
          emptyList(),
          "You can attach up to $MaxComposerAttachments images per message.",
        )
      }
      val imported = mutableListOf<DraftImageAttachment>()
      var error: String? = if (images.size > remaining) {
        "Only the first $remaining shared images were added."
      } else {
        null
      }
      images.take(remaining).forEach { image ->
        runCatching { importIncomingOne(environmentId, image) }
          .onSuccess(imported::add)
          .onFailure { failure -> error = failure.message ?: "Could not add a shared image." }
      }
      AttachmentImportResult(imported, error)
    }
  }

  fun materialize(attachment: DraftImageAttachment) = synchronized(fileLock) {
    val file = ownedFile(attachment.path)
    require(file.length() == attachment.sizeBytes) { "Attachment file changed or is unavailable." }
    val data = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    com.t3tools.android.protocol.UploadChatImageAttachment(
      name = attachment.name,
      mimeType = attachment.mimeType,
      sizeBytes = attachment.sizeBytes,
      dataUrl = "data:${attachment.mimeType};base64,$data",
    )
  }

  fun delete(attachments: Collection<DraftImageAttachment>) = synchronized(fileLock) {
    attachments.forEach { attachment -> runCatching { ownedFile(attachment.path).delete() } }
  }

  fun deleteEnvironment(environmentId: String) = synchronized(fileLock) {
    environmentDirectory(environmentId).deleteRecursively()
  }

  fun reconcile(referencedPaths: Set<String>) = synchronized(fileLock) {
    if (!root.exists()) return@synchronized
    val referenced = referencedPaths.mapNotNull { path ->
      runCatching { ownedFile(path).canonicalPath }.getOrNull()
    }.toSet()
    root.walkTopDown().filter(File::isFile).forEach { file ->
      if (!file.name.endsWith(".tmp") && file.canonicalPath in referenced) return@forEach
      file.delete()
    }
  }

  private fun importOne(environmentId: String, uri: Uri): DraftImageAttachment {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri)?.lowercase()
      ?.takeIf { it.startsWith("image/") }
      ?: error("Only images can be attached.")
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }?.take(255)?.takeIf(String::isNotBlank) ?: "image"
    val input = resolver.openInputStream(uri) ?: error("Image is unavailable.")
    return input.use { importOne(environmentId, name, mimeType, it) }
  }

  private fun importIncomingOne(
    environmentId: String,
    image: IncomingShareImage,
  ): DraftImageAttachment {
    val source = File(image.path).canonicalFile
    val incomingRoot = incomingShareRoot(context).canonicalFile.path + File.separator
    require(source.path.startsWith(incomingRoot) && source.length() == image.sizeBytes) {
      "A shared image changed or is unavailable."
    }
    return source.inputStream().use {
      importOne(environmentId, image.name, image.mimeType, it)
    }
  }

  private fun importOne(
    environmentId: String,
    name: String,
    mimeType: String,
    input: InputStream,
  ): DraftImageAttachment {
    val id = UUID.randomUUID().toString()
    val directory = environmentDirectory(environmentId).apply { mkdirs() }
    val destination = File(directory, "$id.image")
    val temporary = File(directory, "$id.tmp")
    val size = copyOwnedAttachment(input, temporary, MaxComposerImageBytes)
    check(temporary.renameTo(destination)) {
      temporary.delete()
      "Could not finish saving image."
    }
    return DraftImageAttachment(id, name, mimeType, size, destination.absolutePath)
  }

  private fun ownedFile(path: String): File {
    val file = File(path).canonicalFile
    val rootPath = root.canonicalFile.path + File.separator
    require(file.path.startsWith(rootPath)) { "Attachment path is outside app storage." }
    return file
  }

  private fun environmentDirectory(environmentId: String): File {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(environmentId.toByteArray())
      .joinToString("") { "%02x".format(it) }
    return File(root, digest)
  }
}

internal fun copyOwnedAttachment(input: InputStream, target: File, limit: Long): Long {
  var total = 0L
  try {
    FileOutputStream(target).use { output ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read
        require(total <= limit) { "Image exceeds the 10 MB attachment limit." }
        output.write(buffer, 0, read)
      }
      output.fd.sync()
    }
    require(total > 0) { "Image is empty." }
    return total
  } catch (failure: Throwable) {
    target.delete()
    throw failure
  }
}
