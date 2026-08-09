package com.t3tools.android.protocol

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

class WorkspaceModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun decodes_workspace_entries_content_matches_and_files() {
    val entries = json.parseToJsonElement(
      """{"entries":[{"path":"src/App.kt","kind":"file"},{"path":"src","kind":"directory"}],"truncated":true}""",
    ).toWorkspaceEntries()
    val matches = json.parseToJsonElement(
      """{"matches":[{"path":"src/App.kt","lineNumber":7,"lineContent":"hello world","matchRanges":[{"start":0,"end":5}]}],"truncated":false}""",
    ).toWorkspaceContentMatches()
    val file = json.parseToJsonElement(
      """{"relativePath":"README.md","contents":"# Hello","byteLength":7,"truncated":false}""",
    ).toWorkspaceFile()

    assertEquals(listOf("src/App.kt", "src"), entries.entries.map(WorkspaceEntry::path))
    assertTrue(entries.truncated)
    assertEquals(7, matches.matches.single().lineNumber)
    assertEquals(WorkspaceMatchRange(0, 5), matches.matches.single().matchRanges.single())
    assertEquals("# Hello", file.contents)
    assertFalse(file.truncated)
  }

  @Test
  fun builds_clone_asset_search_and_project_wire_shapes() {
    val clone = cloneRepositoryPayload("https://example.com/acme/app.git", "~/app")
    val asset = workspaceAssetPayload("thread-1", "images/logo.png")
    val search = workspaceContentSearchPayload("/repo", "needle", 25)
    val command = createProjectCommand(
      workspaceRoot = "/repo/acme/",
      projectId = "project-1",
      commandId = "command-1",
      now = Instant.parse("2026-08-08T12:00:00Z"),
    )

    assertEquals(JsonPrimitive("~/app"), clone["destinationPath"])
    assertEquals(JsonPrimitive("workspace-file"), asset["resource"]!!.jsonObject["_tag"])
    assertEquals(JsonPrimitive(false), search["useRegex"])
    assertEquals(JsonPrimitive("acme"), command["title"])
    assertEquals(JsonPrimitive("/repo/acme"), command["workspaceRoot"])
    assertEquals(JsonPrimitive(true), command["createWorkspaceRootIfMissing"])
    assertEquals(
      JsonPrimitive("app"),
      createProjectCommand("C:\\repo\\app\\")["title"],
    )
  }
}
