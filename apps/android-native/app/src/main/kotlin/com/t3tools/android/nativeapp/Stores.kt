package com.t3tools.android.nativeapp

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class SavedEnvironment(
  val environmentId: String,
  val label: String,
  val httpBaseUrl: String,
  val kind: EnvironmentKind = EnvironmentKind.Bearer,
  val desired: Boolean = true,
)

class EnvironmentStore(
  context: Context,
  private val database: NativeDatabase = NativeDatabase(context),
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  init {
    migrateLegacy()
  }

  fun load(): SavedEnvironment? {
    val selected = database.selectedEnvironmentId()?.let(database::environment)
    return selected ?: database.environments().firstOrNull()
  }

  fun load(environmentId: String) = database.environment(environmentId)

  fun loadAll() = database.environments()

  fun save(environment: SavedEnvironment) {
    database.saveEnvironment(environment)
    database.selectEnvironment(environment.environmentId)
  }

  fun select(environmentId: String) {
    requireNotNull(load(environmentId)) { "Unknown environment: $environmentId" }
    database.selectEnvironment(environmentId)
  }

  fun remove(environmentId: String) = database.removeEnvironment(environmentId)

  fun clear() {
    loadAll().map(SavedEnvironment::environmentId).forEach(::remove)
  }

  private fun migrateLegacy() {
    if (database.environments().isNotEmpty()) return
    val legacy = preferences.getString(KEY, null)?.let { value ->
      runCatching { json.decodeFromString<SavedEnvironment>(value) }.getOrNull()
    } ?: return
    database.saveEnvironment(legacy)
    database.selectEnvironment(legacy.environmentId)
    check(preferences.edit().remove(KEY).commit()) { "Could not finish environment migration." }
  }

  private companion object {
    const val PREFERENCES = "t3_native_environment"
    const val KEY = "saved_environment_v1"
  }
}

@Serializable
data class ComposerDraft(
  val text: String = "",
  val attachments: List<DraftImageAttachment> = emptyList(),
  val modelInstanceId: String? = null,
  val model: String? = null,
  val runtimeMode: String = "full-access",
  val interactionMode: String = "default",
)

@Serializable
private data class PersistedDrafts(
  val version: Int = 2,
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

  fun attachmentPaths(): Set<String> = read().drafts.values
    .flatMap(ComposerDraft::attachments)
    .mapTo(mutableSetOf(), DraftImageAttachment::path)

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
