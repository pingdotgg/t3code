package com.t3tools.android.nativeapp

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.ThreadState
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

@Serializable
enum class EnvironmentKind { Bearer, Relay }

@Serializable
enum class PendingTaskStatus { Queued, Sending, Failed }

@Serializable
data class PendingTask(
  val messageId: String,
  val environmentId: String,
  val threadId: String,
  val draftKey: String,
  val command: JsonObject,
  val settings: JsonArray = JsonArray(emptyList()),
  val createsThread: Boolean,
  val text: String,
  val attachments: List<DraftImageAttachment> = emptyList(),
  val status: PendingTaskStatus = PendingTaskStatus.Queued,
  val attempt: Int = 0,
  val nextAttemptAt: Long = 0,
  val error: String? = null,
  val createdAt: Long = System.currentTimeMillis(),
)

@Serializable
data class CachedServerConfig(
  val config: JsonObject,
  val capabilities: JsonObject,
)

@Serializable
data class AppSettings(
  val groupThreadsByProject: Boolean = true,
  val compactThreadRows: Boolean = false,
  val betaFeatures: Boolean = true,
  val terminalFontSize: Float = 10.5f,
)

class NativeDatabase(
  context: Context,
  name: String = DATABASE_NAME,
  private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) : SQLiteOpenHelper(context, name, null, DATABASE_VERSION) {
  override fun onConfigure(database: SQLiteDatabase) {
    database.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(database: SQLiteDatabase) {
    database.execSQL(
      """
      CREATE TABLE environments (
        environment_id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        http_base_url TEXT NOT NULL,
        environment_kind TEXT NOT NULL,
        desired INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
      """.trimIndent(),
    )
    database.execSQL(
      """
      CREATE TABLE settings (
        setting_key TEXT PRIMARY KEY NOT NULL,
        setting_value TEXT NOT NULL
      )
      """.trimIndent(),
    )
    database.execSQL(
      """
      CREATE TABLE snapshots (
        environment_id TEXT NOT NULL,
        snapshot_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (environment_id, snapshot_kind, item_id),
        FOREIGN KEY (environment_id) REFERENCES environments(environment_id) ON DELETE CASCADE
      )
      """.trimIndent(),
    )
    database.execSQL(
      """
      CREATE TABLE outbox (
        message_id TEXT PRIMARY KEY NOT NULL,
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        draft_key TEXT NOT NULL,
        command_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        creates_thread INTEGER NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (environment_id) REFERENCES environments(environment_id) ON DELETE CASCADE
      )
      """.trimIndent(),
    )
    database.execSQL(
      "CREATE INDEX outbox_environment_thread_order ON outbox(environment_id, thread_id, created_at)",
    )
  }

  override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion == 1 && newVersion == 2) {
      database.execSQL("ALTER TABLE outbox ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
      return
    }
    error("Unsupported native database migration $oldVersion -> $newVersion")
  }

  @Synchronized
  fun environments(): List<SavedEnvironment> = readableDatabase.query(
    "environments",
    ENVIRONMENT_COLUMNS,
    null,
    null,
    null,
    null,
    "updated_at DESC, environment_id ASC",
  ).use { cursor ->
    buildList {
      while (cursor.moveToNext()) {
        add(
          SavedEnvironment(
            environmentId = cursor.getString(0),
            label = cursor.getString(1),
            httpBaseUrl = cursor.getString(2),
            kind = EnvironmentKind.valueOf(cursor.getString(3)),
            desired = cursor.getInt(4) != 0,
          ),
        )
      }
    }
  }

  @Synchronized
  fun environment(environmentId: String): SavedEnvironment? = readableDatabase.query(
    "environments",
    ENVIRONMENT_COLUMNS,
    "environment_id = ?",
    arrayOf(environmentId),
    null,
    null,
    null,
    "1",
  ).use { cursor ->
    if (!cursor.moveToFirst()) return@use null
    SavedEnvironment(
      environmentId = cursor.getString(0),
      label = cursor.getString(1),
      httpBaseUrl = cursor.getString(2),
      kind = EnvironmentKind.valueOf(cursor.getString(3)),
      desired = cursor.getInt(4) != 0,
    )
  }

  @Synchronized
  fun saveEnvironment(environment: SavedEnvironment) {
    val values = ContentValues().apply {
      put("environment_id", environment.environmentId)
      put("label", environment.label)
      put("http_base_url", environment.httpBaseUrl)
      put("environment_kind", environment.kind.name)
      put("desired", if (environment.desired) 1 else 0)
      put("updated_at", System.currentTimeMillis())
    }
    val updated = writableDatabase.update(
      "environments",
      values,
      "environment_id = ?",
      arrayOf(environment.environmentId),
    )
    if (updated == 0) writableDatabase.insertOrThrow("environments", null, values)
  }

  @Synchronized
  fun selectedEnvironmentId(): String? = setting(SELECTED_ENVIRONMENT)

  @Synchronized
  fun selectEnvironment(environmentId: String?) {
    if (environmentId == null) {
      writableDatabase.delete("settings", "setting_key = ?", arrayOf(SELECTED_ENVIRONMENT))
    } else {
      saveSetting(SELECTED_ENVIRONMENT, environmentId)
    }
  }

  @Synchronized
  fun removeEnvironment(environmentId: String) {
    writableDatabase.beginTransaction()
    try {
      writableDatabase.delete("environments", "environment_id = ?", arrayOf(environmentId))
      if (selectedEnvironmentId() == environmentId) selectEnvironment(null)
      writableDatabase.setTransactionSuccessful()
    } finally {
      writableDatabase.endTransaction()
    }
  }

  @Synchronized
  fun saveShell(environmentId: String, shell: ShellState) {
    if (!shouldWriteSnapshot(environmentId, SHELL_KIND, SHELL_ITEM, SHELL_SCHEMA, shell.sequence)) {
      return
    }
    saveSnapshot(
      environmentId = environmentId,
      kind = SHELL_KIND,
      itemId = SHELL_ITEM,
      schemaVersion = SHELL_SCHEMA,
      sequence = shell.sequence,
      payload = json.encodeToString(ShellState.serializer(), shell),
    )
  }

  @Synchronized
  fun loadShell(environmentId: String): ShellState? = loadSnapshot(
    environmentId,
    SHELL_KIND,
    SHELL_ITEM,
    SHELL_SCHEMA,
  )?.let { runCatching { json.decodeFromString(ShellState.serializer(), it) }.getOrNull() }

  @Synchronized
  fun saveThread(environmentId: String, threadId: String, thread: ThreadState) {
    if (!shouldWriteSnapshot(environmentId, THREAD_KIND, threadId, THREAD_SCHEMA, thread.sequence)) {
      return
    }
    saveSnapshot(
      environmentId = environmentId,
      kind = THREAD_KIND,
      itemId = threadId,
      schemaVersion = THREAD_SCHEMA,
      sequence = thread.sequence,
      payload = json.encodeToString(ThreadState.serializer(), thread),
    )
  }

  @Synchronized
  fun loadThread(environmentId: String, threadId: String): ThreadState? = loadSnapshot(
    environmentId,
    THREAD_KIND,
    threadId,
    THREAD_SCHEMA,
  )?.let { runCatching { json.decodeFromString(ThreadState.serializer(), it) }.getOrNull() }

  @Synchronized
  fun saveServerConfig(environmentId: String, config: CachedServerConfig) {
    saveSnapshot(
      environmentId = environmentId,
      kind = CONFIG_KIND,
      itemId = CONFIG_ITEM,
      schemaVersion = CONFIG_SCHEMA,
      sequence = 0,
      payload = json.encodeToString(CachedServerConfig.serializer(), config),
    )
  }

  @Synchronized
  fun loadServerConfig(environmentId: String): CachedServerConfig? = loadSnapshot(
    environmentId,
    CONFIG_KIND,
    CONFIG_ITEM,
    CONFIG_SCHEMA,
  )?.let { runCatching { json.decodeFromString(CachedServerConfig.serializer(), it) }.getOrNull() }

  @Synchronized
  fun appSettings(): AppSettings = setting(APP_SETTINGS)?.let {
    runCatching { json.decodeFromString(AppSettings.serializer(), it) }.getOrNull()
  } ?: AppSettings()

  @Synchronized
  fun saveAppSettings(settings: AppSettings) {
    saveSetting(APP_SETTINGS, json.encodeToString(AppSettings.serializer(), settings))
  }

  @Synchronized
  fun savePending(task: PendingTask) {
    writableDatabase.insertWithOnConflict(
      "outbox",
      null,
      ContentValues().apply {
        put("message_id", task.messageId)
        put("environment_id", task.environmentId)
        put("thread_id", task.threadId)
        put("draft_key", task.draftKey)
        put("command_json", json.encodeToString(JsonObject.serializer(), task.command))
        put("settings_json", json.encodeToString(JsonArray.serializer(), task.settings))
        put("creates_thread", if (task.createsThread) 1 else 0)
        put("text", task.text)
        put("attachments_json", json.encodeToString(task.attachments))
        put("status", task.status.name)
        put("attempt", task.attempt)
        put("next_attempt_at", task.nextAttemptAt)
        put("error", task.error)
        put("created_at", task.createdAt)
      },
      SQLiteDatabase.CONFLICT_REPLACE,
    )
  }

  @Synchronized
  fun pending(environmentId: String? = null): List<PendingTask> {
    val selection = environmentId?.let { "environment_id = ?" }
    val args = environmentId?.let { arrayOf(it) }
    return readableDatabase.query(
      "outbox",
      OUTBOX_COLUMNS,
      selection,
      args,
      null,
      null,
      "created_at ASC, message_id ASC",
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          runCatching {
            PendingTask(
              messageId = cursor.getString(0),
              environmentId = cursor.getString(1),
              threadId = cursor.getString(2),
              draftKey = cursor.getString(3),
              command = json.decodeFromString(JsonObject.serializer(), cursor.getString(4)),
              settings = json.decodeFromString(JsonArray.serializer(), cursor.getString(5)),
              createsThread = cursor.getInt(6) != 0,
              text = cursor.getString(7),
              attachments = json.decodeFromString(cursor.getString(8)),
              status = PendingTaskStatus.valueOf(cursor.getString(9)),
              attempt = cursor.getInt(10),
              nextAttemptAt = cursor.getLong(11),
              error = cursor.getString(12),
              createdAt = cursor.getLong(13),
            )
          }.getOrNull()?.let(::add)
        }
      }
    }
  }

  @Synchronized
  fun removePending(messageId: String) {
    writableDatabase.delete("outbox", "message_id = ?", arrayOf(messageId))
  }

  @Synchronized
  fun clearCache(environmentId: String? = null) {
    if (environmentId == null) {
      writableDatabase.delete("snapshots", null, null)
    } else {
      writableDatabase.delete("snapshots", "environment_id = ?", arrayOf(environmentId))
    }
  }

  @Synchronized
  fun setting(key: String): String? = readableDatabase.query(
    "settings",
    arrayOf("setting_value"),
    "setting_key = ?",
    arrayOf(key),
    null,
    null,
    null,
    "1",
  ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

  @Synchronized
  fun saveSetting(key: String, value: String) {
    writableDatabase.insertWithOnConflict(
      "settings",
      null,
      ContentValues().apply {
        put("setting_key", key)
        put("setting_value", value)
      },
      SQLiteDatabase.CONFLICT_REPLACE,
    )
  }

  private fun saveSnapshot(
    environmentId: String,
    kind: String,
    itemId: String,
    schemaVersion: Int,
    sequence: Long,
    payload: String,
  ) {
    writableDatabase.insertWithOnConflict(
      "snapshots",
      null,
      ContentValues().apply {
        put("environment_id", environmentId)
        put("snapshot_kind", kind)
        put("item_id", itemId)
        put("schema_version", schemaVersion)
        put("sequence", sequence)
        put("payload", payload)
        put("updated_at", System.currentTimeMillis())
      },
      SQLiteDatabase.CONFLICT_REPLACE,
    )
  }

  /** Live state always outranks cache: never write a lower sequence over a higher one. */
  private fun shouldWriteSnapshot(
    environmentId: String,
    kind: String,
    itemId: String,
    schemaVersion: Int,
    sequence: Long,
  ): Boolean {
    val existing = loadSnapshotMeta(environmentId, kind, itemId) ?: return true
    if (existing.schemaVersion != schemaVersion) return true
    return sequence >= existing.sequence
  }

  private fun loadSnapshot(
    environmentId: String,
    kind: String,
    itemId: String,
    schemaVersion: Int,
  ): String? {
    val meta = loadSnapshotMeta(environmentId, kind, itemId) ?: return null
    return if (meta.schemaVersion == schemaVersion) meta.payload else null
  }

  private fun loadSnapshotMeta(
    environmentId: String,
    kind: String,
    itemId: String,
  ): SnapshotMeta? = readableDatabase.query(
    "snapshots",
    arrayOf("schema_version", "sequence", "payload"),
    "environment_id = ? AND snapshot_kind = ? AND item_id = ?",
    arrayOf(environmentId, kind, itemId),
    null,
    null,
    null,
    "1",
  ).use { cursor ->
    if (!cursor.moveToFirst()) null else SnapshotMeta(
      schemaVersion = cursor.getInt(0),
      sequence = cursor.getLong(1),
      payload = cursor.getString(2),
    )
  }

  private data class SnapshotMeta(
    val schemaVersion: Int,
    val sequence: Long,
    val payload: String,
  )

  private companion object {
    const val DATABASE_NAME = "t3-native.db"
    const val DATABASE_VERSION = 2
    const val SELECTED_ENVIRONMENT = "selected_environment_id"
    const val SHELL_KIND = "shell"
    const val SHELL_ITEM = "current"
    const val SHELL_SCHEMA = 1
    const val THREAD_KIND = "thread"
    const val THREAD_SCHEMA = 3
    const val CONFIG_KIND = "server-config"
    const val CONFIG_ITEM = "current"
    const val CONFIG_SCHEMA = 1
    const val APP_SETTINGS = "app_settings_v1"
    val ENVIRONMENT_COLUMNS = arrayOf(
      "environment_id",
      "label",
      "http_base_url",
      "environment_kind",
      "desired",
    )
    val OUTBOX_COLUMNS = arrayOf(
      "message_id",
      "environment_id",
      "thread_id",
      "draft_key",
      "command_json",
      "settings_json",
      "creates_thread",
      "text",
      "attachments_json",
      "status",
      "attempt",
      "next_attempt_at",
      "error",
      "created_at",
    )
  }
}
