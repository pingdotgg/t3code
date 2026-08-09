package com.t3tools.android.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

data class WorkspaceEntry(
  val path: String,
  val kind: String,
)

data class WorkspaceEntries(
  val entries: List<WorkspaceEntry>,
  val truncated: Boolean,
)

data class WorkspaceMatchRange(val start: Int, val end: Int)

data class WorkspaceContentMatch(
  val path: String,
  val lineNumber: Int,
  val lineContent: String,
  val matchRanges: List<WorkspaceMatchRange>,
)

data class WorkspaceContentMatches(
  val matches: List<WorkspaceContentMatch>,
  val truncated: Boolean,
  val regexFallbackError: String?,
)

data class FilesystemEntry(val name: String, val fullPath: String)

data class FilesystemBrowseResult(
  val parentPath: String,
  val entries: List<FilesystemEntry>,
)

data class WorkspaceFile(
  val relativePath: String,
  val contents: String,
  val byteLength: Long,
  val truncated: Boolean,
)

data class ClonedRepository(val cwd: String, val remoteUrl: String)

data class WorkspaceAssetUrl(val relativeUrl: String, val expiresAt: Long)

internal fun filesystemBrowsePayload(partialPath: String, cwd: String? = null) = buildJsonObject(
  "partialPath" to JsonPrimitive(partialPath),
  "cwd" to cwd?.let(::JsonPrimitive),
)

internal fun workspaceEntriesPayload(cwd: String) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
)

internal fun workspaceEntrySearchPayload(cwd: String, query: String, limit: Int) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "query" to JsonPrimitive(query),
  "limit" to JsonPrimitive(limit),
)

internal fun workspaceContentSearchPayload(cwd: String, query: String, limit: Int) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "query" to JsonPrimitive(query),
  "limit" to JsonPrimitive(limit),
  "caseSensitive" to JsonPrimitive(false),
  "wholeWord" to JsonPrimitive(false),
  "useRegex" to JsonPrimitive(false),
)

internal fun workspaceFilePayload(cwd: String, relativePath: String) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "relativePath" to JsonPrimitive(relativePath),
)

internal fun cloneRepositoryPayload(remoteUrl: String, destinationPath: String) = buildJsonObject(
  "remoteUrl" to JsonPrimitive(remoteUrl),
  "destinationPath" to JsonPrimitive(destinationPath),
)

internal fun workspaceAssetPayload(threadId: String, path: String) = buildJsonObject(
  "resource" to buildJsonObject(
    "_tag" to JsonPrimitive("workspace-file"),
    "threadId" to JsonPrimitive(threadId),
    "path" to JsonPrimitive(path),
  ),
)

internal fun JsonElement.toWorkspaceEntries(): WorkspaceEntries {
  val value = jsonObject
  return WorkspaceEntries(
    entries = value.required("entries").jsonArray.map(JsonElement::toWorkspaceEntry),
    truncated = value["truncated"]?.jsonPrimitive?.booleanOrNull == true,
  )
}

private fun JsonElement.toWorkspaceEntry(): WorkspaceEntry {
  val value = jsonObject
  return WorkspaceEntry(
    path = value.required("path").jsonPrimitive.content,
    kind = value.required("kind").jsonPrimitive.content,
  )
}

internal fun JsonElement.toWorkspaceContentMatches(): WorkspaceContentMatches {
  val value = jsonObject
  return WorkspaceContentMatches(
    matches = value.required("matches").jsonArray.map { item ->
      val match = item.jsonObject
      WorkspaceContentMatch(
        path = match.required("path").jsonPrimitive.content,
        lineNumber = match.required("lineNumber").jsonPrimitive.int,
        lineContent = match.required("lineContent").jsonPrimitive.content,
        matchRanges = (match["matchRanges"] as? JsonArray).orEmpty().map { rangeValue ->
          val range = rangeValue.jsonObject
          WorkspaceMatchRange(
            start = range.required("start").jsonPrimitive.int,
            end = range.required("end").jsonPrimitive.int,
          )
        },
      )
    },
    truncated = value["truncated"]?.jsonPrimitive?.booleanOrNull == true,
    regexFallbackError = value.stringOrNull("regexFallbackError"),
  )
}

internal fun JsonElement.toFilesystemBrowseResult(): FilesystemBrowseResult {
  val value = jsonObject
  return FilesystemBrowseResult(
    parentPath = value.required("parentPath").jsonPrimitive.content,
    entries = value.required("entries").jsonArray.map { item ->
      val entry = item.jsonObject
      FilesystemEntry(
        name = entry.required("name").jsonPrimitive.content,
        fullPath = entry.required("fullPath").jsonPrimitive.content,
      )
    },
  )
}

internal fun JsonElement.toWorkspaceFile(): WorkspaceFile {
  val value = jsonObject
  return WorkspaceFile(
    relativePath = value.required("relativePath").jsonPrimitive.content,
    contents = value.required("contents").jsonPrimitive.content,
    byteLength = value.required("byteLength").jsonPrimitive.long,
    truncated = value["truncated"]?.jsonPrimitive?.booleanOrNull == true,
  )
}

internal fun JsonElement.toClonedRepository(): ClonedRepository {
  val value = jsonObject
  return ClonedRepository(
    cwd = value.required("cwd").jsonPrimitive.content,
    remoteUrl = value.required("remoteUrl").jsonPrimitive.content,
  )
}

internal fun JsonElement.toWorkspaceAssetUrl(): WorkspaceAssetUrl {
  val value = jsonObject
  return WorkspaceAssetUrl(
    relativeUrl = value.required("relativeUrl").jsonPrimitive.content,
    expiresAt = value.required("expiresAt").jsonPrimitive.long,
  )
}
