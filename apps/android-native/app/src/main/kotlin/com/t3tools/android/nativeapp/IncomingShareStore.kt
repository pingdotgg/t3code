package com.t3tools.android.nativeapp

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class IncomingShareImage(
  val name: String,
  val mimeType: String,
  val sizeBytes: Long,
  val path: String,
)

@Serializable
data class IncomingShare(
  val id: String,
  val fingerprint: String,
  val text: String,
  val images: List<IncomingShareImage>,
  val createdAt: String,
  val warning: String? = null,
)

@Serializable
private data class PersistedIncomingShares(
  val version: Int = 1,
  val shares: List<IncomingShare> = emptyList(),
)

class IncomingShareStore(
  private val context: Context,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val root = incomingShareRoot(context)
  private val lock = Any()

  fun loadAll(): List<IncomingShare> = synchronized(lock) { read().shares }

  fun load(shareId: String): IncomingShare? = loadAll().firstOrNull { it.id == shareId }

  internal suspend fun ingest(request: IncomingShareRequest): IncomingShare = withContext(Dispatchers.IO) {
    synchronized(lock) {
      val fingerprint = fingerprint(request)
      read().shares.firstOrNull { it.fingerprint == fingerprint }?.let { return@synchronized it }
      val shareId = UUID.randomUUID().toString()
      val directory = File(root, shareId).apply { mkdirs() }
      val images = mutableListOf<IncomingShareImage>()
      val failures = mutableListOf<String>()
      try {
        request.imageUris.take(MaxComposerAttachments).forEachIndexed { index, value ->
          runCatching { importImage(directory, index, Uri.parse(value), request.imageMimeType) }
            .onSuccess(images::add)
            .onFailure { failures += it.message ?: "An image could not be imported." }
        }
        require(request.text.isNotBlank() || images.isNotEmpty()) {
          failures.firstOrNull() ?: "The shared content is empty."
        }
        val warnings = buildList {
          if (request.imageUris.size > MaxComposerAttachments) {
            add("Only the first $MaxComposerAttachments shared images were kept.")
          }
          if (failures.isNotEmpty()) add(failures.last())
        }
        val share = IncomingShare(
          id = shareId,
          fingerprint = fingerprint,
          text = request.text,
          images = images,
          createdAt = Instant.now().toString(),
          warning = warnings.joinToString(" ").ifBlank { null },
        )
        val current = read()
        write(current.copy(shares = listOf(share) + current.shares))
        share
      } catch (failure: Throwable) {
        directory.deleteRecursively()
        throw failure
      }
    }
  }

  fun remove(shareId: String) = synchronized(lock) {
    val current = read()
    val removed = current.shares.firstOrNull { it.id == shareId } ?: return@synchronized
    write(current.copy(shares = current.shares.filterNot { it.id == shareId }))
    File(root, removed.id).deleteRecursively()
  }

  private fun importImage(
    directory: File,
    index: Int,
    uri: Uri,
    fallbackMimeType: String?,
  ): IncomingShareImage {
    val resolver = context.contentResolver
    val mimeType = (resolver.getType(uri) ?: fallbackMimeType)?.lowercase()
      ?.takeIf { it.startsWith("image/") }
      ?: error("Only images can be shared.")
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }?.take(255)?.takeIf(String::isNotBlank) ?: "shared-image-${index + 1}"
    val destination = File(directory, "$index-${UUID.randomUUID()}.image")
    val temporary = File(directory, "$index-${UUID.randomUUID()}.tmp")
    val size = resolver.openInputStream(uri)?.use { input ->
      copyOwnedAttachment(input, temporary, MaxComposerImageBytes)
    } ?: error("A shared image is unavailable.")
    check(temporary.renameTo(destination)) {
      temporary.delete()
      "Could not finish saving a shared image."
    }
    return IncomingShareImage(name, mimeType, size, destination.absolutePath)
  }

  private fun read(): PersistedIncomingShares = preferences.getString(KEY, null)?.let { value ->
    runCatching { json.decodeFromString<PersistedIncomingShares>(value) }.getOrNull()
  } ?: PersistedIncomingShares()

  private fun write(value: PersistedIncomingShares) {
    check(preferences.edit().putString(KEY, json.encodeToString(value)).commit()) {
      "Could not persist shared content."
    }
  }

  private fun fingerprint(request: IncomingShareRequest): String {
    val value = buildString {
      append(request.text)
      append('\u0000')
      append(request.imageMimeType)
      request.imageUris.forEach { append('\u0000').append(it) }
    }
    return MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }

  private companion object {
    const val PREFERENCES = "t3_native_incoming_shares"
    const val KEY = "incoming_shares_v1"
  }
}

internal fun incomingShareRoot(context: Context) = File(context.filesDir, "incoming-shares")

internal fun Intent.incomingShareRequest(): IncomingShareRequest? = buildIncomingShareRequest(
  action = action,
  mimeType = type,
  text = getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
  imageUris = (streamUris() + clipUris()).map(Uri::toString),
)

private fun Intent.clipUris(): List<Uri> = buildList {
  val data = clipData ?: return@buildList
  repeat(data.itemCount) { index -> data.getItemAt(index).uri?.let(::add) }
}

@Suppress("DEPRECATION")
private fun Intent.streamUris(): List<Uri> = when (action) {
  Intent.ACTION_SEND -> listOfNotNull(
    if (Build.VERSION.SDK_INT >= 33) {
      getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      getParcelableExtra(Intent.EXTRA_STREAM)
    },
  )
  Intent.ACTION_SEND_MULTIPLE -> if (Build.VERSION.SDK_INT >= 33) {
    getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
  } else {
    getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
  }
  else -> emptyList()
}
