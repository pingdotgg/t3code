package com.t3tools.android.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

enum class ReviewSourceKind(val wireValue: String) {
  WorkingTree("working-tree"),
  BranchRange("branch-range"),
  ;

  companion object {
    fun fromWire(value: String) = entries.firstOrNull { it.wireValue == value }
      ?: error("Unknown review source kind: $value")
  }
}

data class ReviewDiffSource(
  val id: String,
  val kind: ReviewSourceKind,
  val title: String,
  val baseRef: String?,
  val headRef: String?,
  val diff: String,
  val diffHash: String,
  val truncated: Boolean,
)

data class ReviewDiffPreview(
  val cwd: String,
  val generatedAt: String,
  val sources: List<ReviewDiffSource>,
)

data class ReviewDiffFileContents(val oldContents: String, val newContents: String)

@Serializable
data class ReviewCheckpointFile(
  val path: String,
  val kind: String,
  val additions: Int,
  val deletions: Int,
)

@Serializable
data class ReviewCheckpoint(
  val turnId: String,
  val checkpointTurnCount: Int,
  val checkpointRef: String,
  val status: String,
  val files: List<ReviewCheckpointFile>,
  val assistantMessageId: String?,
  val completedAt: String,
)

data class ReviewTurnDiff(
  val threadId: String,
  val fromTurnCount: Int,
  val toTurnCount: Int,
  val diff: String,
)

internal fun reviewDiffPreviewPayload(
  cwd: String,
  baseRef: String? = null,
  ignoreWhitespace: Boolean = false,
) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "baseRef" to baseRef?.let(::JsonPrimitive),
  "ignoreWhitespace" to JsonPrimitive(ignoreWhitespace),
)

internal fun reviewDiffFileContentsPayload(
  cwd: String,
  sourceKind: ReviewSourceKind,
  changeType: String,
  baseRef: String?,
  headRef: String?,
  oldPath: String,
  newPath: String,
) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "sourceKind" to JsonPrimitive(sourceKind.wireValue),
  "changeType" to JsonPrimitive(changeType),
  "baseRef" to (baseRef?.let(::JsonPrimitive) ?: JsonNull),
  "headRef" to (headRef?.let(::JsonPrimitive) ?: JsonNull),
  "oldPath" to JsonPrimitive(oldPath),
  "newPath" to JsonPrimitive(newPath),
)

internal fun reviewTurnDiffPayload(
  threadId: String,
  fromTurnCount: Int,
  toTurnCount: Int,
  ignoreWhitespace: Boolean = false,
) = buildJsonObject(
  "threadId" to JsonPrimitive(threadId),
  "fromTurnCount" to JsonPrimitive(fromTurnCount),
  "toTurnCount" to JsonPrimitive(toTurnCount),
  "ignoreWhitespace" to JsonPrimitive(ignoreWhitespace),
)

internal fun JsonElement.toReviewDiffPreview(): ReviewDiffPreview {
  val value = jsonObject
  return ReviewDiffPreview(
    cwd = value.required("cwd").jsonPrimitive.content,
    generatedAt = value.required("generatedAt").jsonPrimitive.content,
    sources = value.required("sources").jsonArray.map { sourceValue ->
      val source = sourceValue.jsonObject
      ReviewDiffSource(
        id = source.required("id").jsonPrimitive.content,
        kind = ReviewSourceKind.fromWire(source.required("kind").jsonPrimitive.content),
        title = source.required("title").jsonPrimitive.content,
        baseRef = source.nullableReviewString("baseRef"),
        headRef = source.nullableReviewString("headRef"),
        diff = source.required("diff").jsonPrimitive.content,
        diffHash = source.required("diffHash").jsonPrimitive.content,
        truncated = source["truncated"]?.jsonPrimitive?.booleanOrNull == true,
      )
    },
  )
}

internal fun JsonElement.toReviewDiffFileContents(): ReviewDiffFileContents {
  val value = jsonObject
  return ReviewDiffFileContents(
    oldContents = value.required("oldContents").jsonPrimitive.content,
    newContents = value.required("newContents").jsonPrimitive.content,
  )
}

internal fun JsonElement.toReviewTurnDiff(): ReviewTurnDiff {
  val value = jsonObject
  return ReviewTurnDiff(
    threadId = value.required("threadId").jsonPrimitive.content,
    fromTurnCount = value.required("fromTurnCount").jsonPrimitive.int,
    toTurnCount = value.required("toTurnCount").jsonPrimitive.int,
    diff = value.required("diff").jsonPrimitive.content,
  )
}

internal fun JsonObject.toReviewCheckpoint(): ReviewCheckpoint? {
  val turnId = nullableReviewString("turnId") ?: return null
  val turnCount = this["checkpointTurnCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
  val checkpointRef = nullableReviewString("checkpointRef") ?: return null
  return ReviewCheckpoint(
    turnId = turnId,
    checkpointTurnCount = turnCount,
    checkpointRef = checkpointRef,
    status = nullableReviewString("status") ?: "missing",
    files = array("files").orEmpty().mapNotNull { item ->
      val file = item as? JsonObject ?: return@mapNotNull null
      val path = file.nullableReviewString("path") ?: return@mapNotNull null
      ReviewCheckpointFile(
        path = path,
        kind = file.nullableReviewString("kind") ?: "change",
        additions = file["additions"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        deletions = file["deletions"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
      )
    },
    assistantMessageId = nullableReviewString("assistantMessageId"),
    completedAt = nullableReviewString("completedAt") ?: "",
  )
}

private fun JsonObject.nullableReviewString(name: String) =
  this[name]?.jsonPrimitive?.contentOrNull
