package com.t3tools.android.nativeapp

import java.net.URI

internal const val T3NativeScheme = "t3code-native"

internal sealed interface SystemRoute {
  data object AddEnvironment : SystemRoute
  data object NewTask : SystemRoute
  data class Thread(val environmentId: String, val threadId: String) : SystemRoute
}

internal fun parseSystemRoute(value: String?): SystemRoute? {
  val uri = value?.let { runCatching { URI(it) }.getOrNull() } ?: return null
  if (!uri.scheme.equals(T3NativeScheme, ignoreCase = true) || uri.userInfo != null ||
    uri.port != -1 || uri.query != null || uri.fragment != null
  ) return null
  val host = uri.host?.lowercase() ?: return null
  val rawPath = uri.rawPath.orEmpty()
  if (rawPath.endsWith('/') || "//" in rawPath) return null
  val segments = uri.path.orEmpty().split('/').filter(String::isNotEmpty)
  if (segments.any { it.isBlank() || '/' in it }) return null
  return when {
    host == "connections" && rawPath == "/new" -> SystemRoute.AddEnvironment
    host == "new" && rawPath.isEmpty() -> SystemRoute.NewTask
    host == "threads" && rawPath.count { it == '/' } == 2 && segments.size == 2 ->
      SystemRoute.Thread(segments[0], segments[1])
    else -> null
  }
}

internal data class IncomingShareRequest(
  val text: String,
  val imageUris: List<String>,
  val imageMimeType: String?,
)

internal fun buildIncomingShareRequest(
  action: String?,
  mimeType: String?,
  text: String?,
  imageUris: List<String>,
): IncomingShareRequest? {
  val normalizedText = text.orEmpty().trim()
  val normalizedUris = imageUris.map(String::trim).filter(String::isNotEmpty).distinct()
  val normalizedMime = mimeType?.lowercase()
  return when {
    action == "android.intent.action.SEND" && normalizedMime == "text/plain" &&
      normalizedText.isNotEmpty() && normalizedUris.isEmpty() ->
      IncomingShareRequest(normalizedText, emptyList(), null)
    action == "android.intent.action.SEND" && normalizedMime?.startsWith("image/") == true &&
      normalizedUris.isNotEmpty() ->
      IncomingShareRequest(normalizedText, normalizedUris.take(1), normalizedMime)
    action == "android.intent.action.SEND_MULTIPLE" && normalizedMime?.startsWith("image/") == true &&
      normalizedUris.isNotEmpty() ->
      IncomingShareRequest(normalizedText, normalizedUris, normalizedMime)
    else -> null
  }
}

internal fun mergeSharedText(existing: String, shared: String): String = when {
  existing.isBlank() -> shared
  shared.isBlank() -> existing
  else -> "$existing\n\n$shared"
}
