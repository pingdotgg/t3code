package com.t3tools.android.nativeapp

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal const val MaxRecentThreadShortcuts = 3

@Serializable
data class RecentThreadShortcut(
  val environmentId: String,
  val threadId: String,
  val title: String,
)

@Serializable
private data class PersistedRecentThreadShortcuts(
  val version: Int = 1,
  val recents: List<RecentThreadShortcut> = emptyList(),
)

internal fun withRecentThreadShortcut(
  current: List<RecentThreadShortcut>,
  opened: RecentThreadShortcut,
): List<RecentThreadShortcut> {
  val existing = current.firstOrNull {
    it.environmentId == opened.environmentId && it.threadId == opened.threadId
  }
  val title = opened.title.trim().ifEmpty { existing?.title.orEmpty().ifEmpty { "Thread" } }
  if (current.firstOrNull() == existing && existing?.title == title) return current
  return (listOf(opened.copy(title = title)) + current.filterNot { it == existing })
    .take(MaxRecentThreadShortcuts)
}

class LauncherShortcutStore(
  private val context: Context,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun record(opened: RecentThreadShortcut) {
    val current = read().recents
    val recents = withRecentThreadShortcut(current, opened)
    if (recents == current) return
    write(PersistedRecentThreadShortcuts(recents = recents))
    publish(recents)
  }

  fun removeEnvironment(environmentId: String) {
    val recents = read().recents.filterNot { it.environmentId == environmentId }
    write(PersistedRecentThreadShortcuts(recents = recents))
    publish(recents)
  }

  private fun publish(recents: List<RecentThreadShortcut>) {
    val manager = context.getSystemService(ShortcutManager::class.java)
    manager.dynamicShortcuts = recents.map { recent ->
      val uri = Uri.Builder()
        .scheme(T3NativeScheme)
        .authority("threads")
        .appendPath(recent.environmentId)
        .appendPath(recent.threadId)
        .build()
      ShortcutInfo.Builder(context, "thread:$uri")
        .setShortLabel(recent.title.take(40))
        .setLongLabel(recent.title.take(80))
        .setIcon(Icon.createWithResource(context, R.drawable.ic_shortcut))
        .setIntent(Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java))
        .build()
    }
  }

  private fun read(): PersistedRecentThreadShortcuts = preferences.getString(KEY, null)?.let {
    runCatching { json.decodeFromString<PersistedRecentThreadShortcuts>(it) }.getOrNull()
  } ?: PersistedRecentThreadShortcuts()

  private fun write(value: PersistedRecentThreadShortcuts) {
    check(preferences.edit().putString(KEY, json.encodeToString(value)).commit()) {
      "Could not save launcher shortcuts."
    }
  }

  private companion object {
    const val PREFERENCES = "t3_native_shortcuts"
    const val KEY = "recent_threads_v1"
  }
}
