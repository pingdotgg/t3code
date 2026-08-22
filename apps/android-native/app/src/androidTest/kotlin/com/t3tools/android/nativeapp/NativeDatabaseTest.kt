package com.t3tools.android.nativeapp

import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.ThreadState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeDatabaseTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val dbName = "phase2-test-${UUID.randomUUID()}.db"
  private val database = NativeDatabase(context, dbName)

  @After
  fun tearDown() {
    database.close()
    context.deleteDatabase(dbName)
  }

  @Test
  fun catalogs_multiple_environments_and_cleans_up_scoped_state() {
    val a = SavedEnvironment("env-a", "A", "http://a.local", EnvironmentKind.Bearer, desired = true)
    val b = SavedEnvironment("env-b", "B", "http://b.local", EnvironmentKind.Relay, desired = true)
    database.saveEnvironment(a)
    database.saveEnvironment(b)
    database.selectEnvironment(a.environmentId)
    database.saveShell(a.environmentId, ShellState(sequence = 3, synchronized = true))
    database.savePending(
      PendingTask(
        messageId = "msg-a",
        environmentId = a.environmentId,
        threadId = "thread-a",
        draftKey = "draft-a",
        command = JsonObject(mapOf("_tag" to JsonPrimitive("thread.turn.start"))),
        createsThread = false,
        text = "hello a",
      ),
    )
    database.savePending(
      PendingTask(
        messageId = "msg-b",
        environmentId = b.environmentId,
        threadId = "thread-b",
        draftKey = "draft-b",
        command = JsonObject(mapOf("_tag" to JsonPrimitive("thread.turn.start"))),
        createsThread = true,
        text = "hello b",
      ),
    )

    assertEquals(listOf(b.environmentId, a.environmentId).toSet(), database.environments().map { it.environmentId }.toSet())
    assertEquals(a.environmentId, database.selectedEnvironmentId())
    assertEquals(1, database.pending(a.environmentId).size)
    assertEquals(2, database.pending().size)

    database.removeEnvironment(a.environmentId)
    assertNull(database.environment(a.environmentId))
    assertNull(database.loadShell(a.environmentId))
    assertTrue(database.pending(a.environmentId).isEmpty())
    assertEquals(1, database.pending().size)
    assertEquals(b.environmentId, database.environments().single().environmentId)
  }

  @Test
  fun updating_environment_preserves_scoped_state() {
    val environment = SavedEnvironment("env-update", "Before", "http://before.local")
    database.saveEnvironment(environment)
    database.saveShell(environment.environmentId, ShellState(sequence = 3, synchronized = true))
    database.savePending(
      PendingTask(
        messageId = "msg-update",
        environmentId = environment.environmentId,
        threadId = "thread-update",
        draftKey = "draft-update",
        command = JsonObject(mapOf("text" to JsonPrimitive("queued"))),
        createsThread = false,
        text = "queued",
      ),
    )

    database.saveEnvironment(environment.copy(label = "After", httpBaseUrl = "http://after.local"))

    assertEquals("After", database.environment(environment.environmentId)?.label)
    assertEquals(3L, database.loadShell(environment.environmentId)?.sequence)
    assertEquals(listOf("msg-update"), database.pending(environment.environmentId).map(PendingTask::messageId))
  }

  @Test
  fun outbox_preserves_order_edit_delete_and_retry_fields() {
    val env = SavedEnvironment("env-outbox", "Outbox", "http://outbox.local")
    database.saveEnvironment(env)
    val first = PendingTask(
      messageId = "m1",
      environmentId = env.environmentId,
      threadId = "t1",
      draftKey = "d1",
      command = JsonObject(mapOf("text" to JsonPrimitive("one"))),
      createsThread = false,
      text = "one",
      attachments = listOf(DraftImageAttachment("image-1", "photo.png", "image/png", 3, "/owned/photo.png")),
      createdAt = 10,
    )
    val second = PendingTask(
      messageId = "m2",
      environmentId = env.environmentId,
      threadId = "t1",
      draftKey = "d2",
      command = JsonObject(mapOf("text" to JsonPrimitive("two"))),
      createsThread = false,
      text = "two",
      createdAt = 20,
    )
    database.savePending(first)
    database.savePending(second)
    assertEquals(listOf("m1", "m2"), database.pending(env.environmentId).map(PendingTask::messageId))

    database.savePending(
      first.copy(
        text = "one-edited",
        status = PendingTaskStatus.Failed,
        attempt = 2,
        error = "timeout",
      ),
    )
    val updated = database.pending(env.environmentId).first { it.messageId == "m1" }
    assertEquals("one-edited", updated.text)
    assertEquals(PendingTaskStatus.Failed, updated.status)
    assertEquals(2, updated.attempt)
    assertEquals("timeout", updated.error)
    assertEquals("image-1", updated.attachments.single().id)

    database.removePending("m1")
    assertEquals(listOf("m2"), database.pending(env.environmentId).map(PendingTask::messageId))
  }

  @Test
  fun migrates_v1_outbox_with_empty_attachment_metadata() {
    val migrationName = "phase3e-migration-${UUID.randomUUID()}.db"
    val path = context.getDatabasePath(migrationName).apply { parentFile?.mkdirs() }
    SQLiteDatabase.openOrCreateDatabase(path, null).use { legacy ->
      legacy.execSQL(
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
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          next_attempt_at INTEGER NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        )
        """.trimIndent(),
      )
      legacy.version = 1
    }

    val migrated = NativeDatabase(context, migrationName)
    try {
      val columns = migrated.writableDatabase.rawQuery("PRAGMA table_info(outbox)", null).use { cursor ->
        buildSet {
          val nameIndex = cursor.getColumnIndexOrThrow("name")
          while (cursor.moveToNext()) add(cursor.getString(nameIndex))
        }
      }
      assertTrue("attachments_json" in columns)
    } finally {
      migrated.close()
      context.deleteDatabase(migrationName)
    }
  }

  @Test
  fun live_snapshot_outRanks_stale_cache_and_rejects_schema_mismatch() {
    val env = SavedEnvironment("env-cache", "Cache", "http://cache.local")
    database.saveEnvironment(env)
    database.saveShell(env.environmentId, ShellState(sequence = 5, synchronized = true))
    database.saveShell(env.environmentId, ShellState(sequence = 3, synchronized = false))
    assertEquals(5L, database.loadShell(env.environmentId)?.sequence)

    database.saveThread(
      env.environmentId,
      "thread-1",
      ThreadState(sequence = 9, synchronized = true),
    )
    database.saveThread(
      env.environmentId,
      "thread-1",
      ThreadState(sequence = 4, synchronized = false),
    )
    assertEquals(9L, database.loadThread(env.environmentId, "thread-1")?.sequence)

    database.saveAppSettings(AppSettings(compactThreadRows = true))
    assertEquals(true, database.appSettings().compactThreadRows)
  }
}
