package com.t3tools.android.nativeapp

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class SavedEnvironment(
  val environmentId: String,
  val label: String,
  val httpBaseUrl: String,
)

class EnvironmentStore(
  context: Context,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun load(): SavedEnvironment? = preferences.getString(KEY, null)?.let { value ->
    runCatching { json.decodeFromString<SavedEnvironment>(value) }.getOrNull()
  }

  fun save(environment: SavedEnvironment) {
    check(
      preferences.edit()
        .putString(KEY, json.encodeToString(SavedEnvironment.serializer(), environment))
        .commit(),
    ) {
      "Could not persist environment metadata."
    }
  }

  fun clear() {
    check(preferences.edit().remove(KEY).commit()) {
      "Could not clear environment metadata."
    }
  }

  private companion object {
    const val PREFERENCES = "t3_native_environment"
    const val KEY = "saved_environment_v1"
  }
}

@Serializable
data class ComposerDraft(
  val text: String = "",
  val modelInstanceId: String? = null,
  val model: String? = null,
  val runtimeMode: String = "full-access",
  val interactionMode: String = "default",
)

@Serializable
private data class PersistedDrafts(
  val version: Int = 1,
  val drafts: Map<String, ComposerDraft> = emptyMap(),
)

class DraftStore(
  context: Context,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun load(key: String): ComposerDraft = read().drafts[key] ?: ComposerDraft()

  fun save(key: String, draft: ComposerDraft) {
    val current = read()
    write(current.copy(drafts = current.drafts + (key to draft)))
  }

  fun clear(key: String) {
    val current = read()
    write(current.copy(drafts = current.drafts - key))
  }

  fun clearEnvironment(environmentId: String) {
    val prefix = "$environmentId:"
    val current = read()
    write(current.copy(drafts = current.drafts.filterKeys { !it.startsWith(prefix) }))
  }

  private fun read(): PersistedDrafts = preferences.getString(KEY, null)?.let { value ->
    runCatching { json.decodeFromString<PersistedDrafts>(value) }.getOrNull()
  } ?: PersistedDrafts()

  private fun write(value: PersistedDrafts) {
    check(
      preferences.edit()
        .putString(KEY, json.encodeToString(PersistedDrafts.serializer(), value))
        .commit(),
    ) {
      "Could not persist composer drafts."
    }
  }

  companion object {
    fun threadKey(environmentId: String, threadId: String) = "$environmentId:thread:$threadId"
    fun newTaskKey(environmentId: String) = "$environmentId:new-task"

    private const val PREFERENCES = "t3_native_drafts"
    private const val KEY = "composer_drafts_v1"
  }
}
