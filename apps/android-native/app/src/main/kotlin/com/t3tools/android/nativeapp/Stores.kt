package com.t3tools.android.nativeapp

import android.content.Context
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

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

  fun update(environment: SavedEnvironment) {
    database.saveEnvironment(environment)
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
  val projectId: String? = null,
  val branch: String? = null,
  val worktreePath: String? = null,
  val isWorktree: Boolean = false,
  val modelInstanceId: String? = null,
  val model: String? = null,
  val modelOptions: JsonElement? = null,
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

  fun loadAll(): Map<String, ComposerDraft> = read().drafts

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

@Serializable
data class PromptStashEntry(
  val id: String = UUID.randomUUID().toString(),
  val createdAt: String = Instant.now().toString(),
  val text: String = "",
  val attachments: List<DraftImageAttachment> = emptyList(),
)

@Serializable
private data class PersistedPromptStash(
  val version: Int = 1,
  val entries: List<PromptStashEntry> = emptyList(),
)

class PromptStashStore(
  context: Context,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun loadAll(): List<PromptStashEntry> = read().entries

  fun stash(text: String, attachments: List<DraftImageAttachment> = emptyList()): PromptStashEntry? {
    if (text.isBlank() && attachments.isEmpty()) return null
    val newEntry = PromptStashEntry(text = text, attachments = attachments)
    val current = read()
    val nextEntries = (listOf(newEntry) + current.entries).take(20)
    write(current.copy(entries = nextEntries))
    return newEntry
  }

  fun take(id: String): PromptStashEntry? {
    val current = read()
    val entry = current.entries.firstOrNull { it.id == id } ?: return null
    write(current.copy(entries = current.entries.filterNot { it.id == id }))
    return entry
  }

  fun delete(id: String) {
    val current = read()
    write(current.copy(entries = current.entries.filterNot { it.id == id }))
  }

  private fun read(): PersistedPromptStash = preferences.getString(KEY, null)?.let { value ->
    runCatching { json.decodeFromString<PersistedPromptStash>(value) }.getOrNull()
  } ?: PersistedPromptStash()

  private fun write(value: PersistedPromptStash) {
    preferences.edit()
      .putString(KEY, json.encodeToString(PersistedPromptStash.serializer(), value))
      .apply()
  }

  companion object {
    private const val PREFERENCES = "t3_native_prompt_stash"
    private const val KEY = "prompt_stash_v1"
  }
}
