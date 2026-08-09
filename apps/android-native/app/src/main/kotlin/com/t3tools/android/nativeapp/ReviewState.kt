package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ReviewCheckpoint
import com.t3tools.android.protocol.ReviewDiffSource
import com.t3tools.android.protocol.ReviewSourceKind
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val LargeDiffLineThreshold = 400
private const val LargeDiffCharacterThreshold = 24_000
private val NonTextExtensions = setOf(
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "avif", "heic", "tif",
  "tiff", "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "mov", "avi", "mkv",
  "webm", "pdf", "zip", "gz", "tgz", "bz2", "7z", "rar", "woff", "woff2", "ttf",
  "otf", "eot", "wasm", "exe", "dll", "so", "dylib",
)

enum class ReviewSectionKind { Turn, WorkingTree, BranchRange }

data class ReviewSection(
  val id: String,
  val kind: ReviewSectionKind,
  val title: String,
  val subtitle: String?,
  val diff: String?,
  val loading: Boolean = false,
)

data class ReviewLine(
  val id: String,
  val change: String,
  val oldLineNumber: Int?,
  val newLineNumber: Int?,
  val content: String,
  val lineIndex: Int,
)

sealed interface ReviewRow {
  data class Hunk(val id: String, val header: String, val context: String?) : ReviewRow
  data class Line(val value: ReviewLine) : ReviewRow
}

data class ReviewFile(
  val id: String,
  val path: String,
  val previousPath: String?,
  val changeType: String,
  val additions: Int,
  val deletions: Int,
  val rows: List<ReviewRow>,
  val binary: Boolean = false,
) {
  val lines get() = rows.mapNotNull { (it as? ReviewRow.Line)?.value }
  val isNonText get() = path.substringAfterLast('.', "").lowercase() in NonTextExtensions
  val isLarge get() = lines.size > LargeDiffLineThreshold ||
    rows.sumOf { row ->
      when (row) {
        is ReviewRow.Hunk -> row.header.length + (row.context?.length ?: 0)
        is ReviewRow.Line -> row.value.content.length
      }
    } > LargeDiffCharacterThreshold
}

sealed interface ParsedReviewDiff {
  data object Empty : ParsedReviewDiff
  data class Raw(val text: String, val reason: String, val truncated: Boolean) : ParsedReviewDiff
  data class Files(
    val files: List<ReviewFile>,
    val additions: Int,
    val deletions: Int,
    val truncated: Boolean,
  ) : ParsedReviewDiff
}

data class ReviewSelection(
  val sectionId: String,
  val sectionTitle: String,
  val filePath: String,
  val lines: List<ReviewLine>,
  val startIndex: Int,
  val endIndex: Int,
)

data class ReviewComment(
  val id: String,
  val sectionId: String,
  val sectionTitle: String,
  val filePath: String,
  val startIndex: Int,
  val endIndex: Int,
  val rangeLabel: String,
  val text: String,
  val diff: String,
)

sealed interface ReviewMessageSegment {
  data class Text(val value: String) : ReviewMessageSegment
  data class Comment(val value: ReviewComment) : ReviewMessageSegment
}

fun buildReviewSections(
  checkpoints: List<ReviewCheckpoint>,
  gitSources: List<ReviewDiffSource>,
  turnDiffs: Map<String, String>,
  loadingTurnIds: Set<String> = emptySet(),
): List<ReviewSection> {
  val turns = checkpoints
    .asSequence()
    .filter { it.status == "ready" }
    .sortedByDescending(ReviewCheckpoint::checkpointTurnCount)
    .map { checkpoint ->
      val id = "turn:${checkpoint.turnId}"
      val fileCount = checkpoint.files.size
      ReviewSection(
        id = id,
        kind = ReviewSectionKind.Turn,
        title = "Turn ${checkpoint.checkpointTurnCount}",
        subtitle = "$fileCount file${if (fileCount == 1) "" else "s"} changed",
        diff = turnDiffs[id],
        loading = id in loadingTurnIds,
      )
    }
  val git = gitSources.asSequence().map { source ->
    ReviewSection(
      id = "git:${source.kind.wireValue}",
      kind = when (source.kind) {
        ReviewSourceKind.WorkingTree -> ReviewSectionKind.WorkingTree
        ReviewSourceKind.BranchRange -> ReviewSectionKind.BranchRange
      },
      title = source.title,
      subtitle = when (source.kind) {
        ReviewSourceKind.WorkingTree -> "Tracked, staged, and untracked worktree changes"
        ReviewSourceKind.BranchRange -> source.baseRef?.let { "$it ... ${source.headRef ?: "HEAD"}" }
          ?: "Base branch unavailable"
      },
      diff = source.diff,
    )
  }
  return (turns + git).toList()
}

fun parseReviewDiff(rawDiff: String?, truncated: Boolean = false): ParsedReviewDiff {
  val trimmed = rawDiff?.trimEnd().orEmpty()
  if (trimmed.isBlank()) return ParsedReviewDiff.Empty
  val markerTruncated = trimmed.endsWith("[truncated]")
  val text = if (markerTruncated) {
    trimmed.replace(Regex("\\n*\\[truncated]\\s*$"), "").trimEnd()
  } else {
    trimmed
  }
  val wasTruncated = truncated || markerTruncated
  return runCatching { parseUnifiedDiff(text, wasTruncated) }
    .getOrElse { ParsedReviewDiff.Raw(text, "Failed to parse patch.", wasTruncated) }
}

private fun parseUnifiedDiff(text: String, truncated: Boolean): ParsedReviewDiff {
  val lines = text.lines()
  val files = mutableListOf<ReviewFile>()
  var index = 0
  while (index < lines.size) {
    if (!lines[index].startsWith("diff --git ")) {
      index += 1
      continue
    }
    val header = lines[index].removePrefix("diff --git ")
    val headerMatch = Regex("^a/(.+) b/(.+)$").matchEntire(header)
      ?: throw IllegalArgumentException("Unsupported diff header")
    var oldPath = headerMatch.groupValues[1]
    var newPath = headerMatch.groupValues[2]
    var changeType = "change"
    var additions = 0
    var deletions = 0
    var binary = false
    val rows = mutableListOf<ReviewRow>()
    var oldLine = 0
    var newLine = 0
    var lineIndex = 0
    index += 1
    while (index < lines.size && !lines[index].startsWith("diff --git ")) {
      val line = lines[index]
      when {
        line.startsWith("new file mode ") -> changeType = "new"
        line.startsWith("deleted file mode ") -> changeType = "deleted"
        line.startsWith("rename from ") -> oldPath = line.removePrefix("rename from ")
        line.startsWith("rename to ") -> {
          newPath = line.removePrefix("rename to ")
          if (changeType == "change") changeType = "rename-pure"
        }
        line.startsWith("Binary files ") || line == "GIT binary patch" -> binary = true
        line.startsWith("@@ ") -> {
          val match = HunkPattern.find(line) ?: throw IllegalArgumentException("Invalid hunk")
          oldLine = match.groupValues[1].toInt()
          newLine = match.groupValues[4].toInt()
          val context = match.groupValues[7].trim().ifEmpty { null }
          rows += ReviewRow.Hunk("$newPath:hunk:$index", line.substringBeforeLast("@@") + "@@", context)
        }
        rows.isNotEmpty() && line.startsWith("+") && !line.startsWith("+++") -> {
          additions += 1
          rows += ReviewRow.Line(
            ReviewLine("$newPath:line:$index", "add", null, newLine, line.drop(1), lineIndex++),
          )
          newLine += 1
          if (changeType == "rename-pure") changeType = "rename-changed"
        }
        rows.isNotEmpty() && line.startsWith("-") && !line.startsWith("---") -> {
          deletions += 1
          rows += ReviewRow.Line(
            ReviewLine("$newPath:line:$index", "delete", oldLine, null, line.drop(1), lineIndex++),
          )
          oldLine += 1
          if (changeType == "rename-pure") changeType = "rename-changed"
        }
        rows.isNotEmpty() && line.startsWith(" ") -> {
          rows += ReviewRow.Line(
            ReviewLine("$newPath:line:$index", "context", oldLine, newLine, line.drop(1), lineIndex++),
          )
          oldLine += 1
          newLine += 1
        }
      }
      index += 1
    }
    val path = if (changeType == "deleted") oldPath else newPath
    files += ReviewFile(
      id = "file:${oldPath.hashCode().toUInt().toString(36)}:${newPath.hashCode().toUInt().toString(36)}",
      path = path,
      previousPath = oldPath.takeIf { it != newPath },
      changeType = changeType,
      additions = additions,
      deletions = deletions,
      rows = rows,
      binary = binary,
    )
  }
  if (files.isEmpty()) {
    return ParsedReviewDiff.Raw(text, "Unsupported diff format.", truncated)
  }
  return ParsedReviewDiff.Files(
    files = files,
    additions = files.sumOf(ReviewFile::additions),
    deletions = files.sumOf(ReviewFile::deletions),
    truncated = truncated,
  )
}

fun buildReviewRowsJson(
  parsed: ParsedReviewDiff,
  expandedFileIds: Set<String>,
  revealedLargeFileIds: Set<String>,
  comments: List<ReviewComment> = emptyList(),
): String {
  if (parsed !is ParsedReviewDiff.Files) return "[]"
  return buildJsonArray {
    parsed.files.forEach { file ->
      add(buildJsonObject {
        put("kind", "file")
        put("id", "${file.id}:header")
        put("fileId", file.id)
        put("filePath", file.path)
        put("previousPath", file.previousPath?.let(::JsonPrimitive) ?: JsonNull)
        put("changeType", if (file.changeType == "change") "modified" else file.changeType)
        put("additions", file.additions)
        put("deletions", file.deletions)
      })
      if (file.id !in expandedFileIds) return@forEach
      when {
        file.binary || file.isNonText -> {
          add(reviewNotice(file.id, "non-text", "Binary or non-text file. Diff contents are not available."))
          return@forEach
        }
        file.isLarge && file.id !in revealedLargeFileIds -> {
          add(reviewNotice(file.id, "large", "Large diff. Tap the file menu to load it."))
          return@forEach
        }
        file.changeType == "rename-pure" && file.rows.isEmpty() -> {
          add(reviewNotice(file.id, "rename", "This file was renamed without modifications."))
          return@forEach
        }
      }
      file.rows.forEach { row ->
        when (row) {
          is ReviewRow.Hunk -> add(buildJsonObject {
            put("kind", "hunk")
            put("id", row.id)
            put("fileId", file.id)
            put("text", listOfNotNull(row.header, row.context).joinToString(" "))
          })
          is ReviewRow.Line -> {
            val line = row.value
            add(buildJsonObject {
              put("kind", "line")
              put("id", line.id)
              put("fileId", file.id)
              put("content", line.content)
              put("change", line.change)
              put("oldLineNumber", line.oldLineNumber?.let(::JsonPrimitive) ?: JsonNull)
              put("newLineNumber", line.newLineNumber?.let(::JsonPrimitive) ?: JsonNull)
            })
            comments.filter { it.filePath == file.path && it.endIndex == line.lineIndex }
              .forEach { comment ->
                add(buildJsonObject {
                  put("kind", "comment")
                  put("id", comment.id)
                  put("fileId", file.id)
                  put("filePath", file.path)
                  put("commentText", comment.text)
                  put("commentRangeLabel", comment.rangeLabel)
                  put("commentSectionTitle", comment.sectionTitle)
                })
              }
          }
        }
      }
    }
  }.toString()
}

private fun reviewNotice(fileId: String, suffix: String, text: String) = buildJsonObject {
  put("kind", "notice")
  put("id", "$fileId:notice:$suffix")
  put("fileId", fileId)
  put("text", text)
}

fun updateReviewSelection(
  current: ReviewSelection?,
  section: ReviewSection,
  file: ReviewFile,
  lineIndex: Int,
  extend: Boolean,
): ReviewSelection {
  val anchor = current?.takeIf {
    extend && it.sectionId == section.id && it.filePath == file.path
  }?.startIndex ?: lineIndex
  return ReviewSelection(
    sectionId = section.id,
    sectionTitle = section.title,
    filePath = file.path,
    lines = file.lines,
    startIndex = minOf(anchor, lineIndex),
    endIndex = maxOf(anchor, lineIndex),
  )
}

fun formatReviewComment(selection: ReviewSelection, comment: String): String {
  val selected = selection.lines.slice(selection.startIndex..selection.endIndex)
  val rangeLabel = reviewRangeLabel(selected)
  val old = hunkRange(selected.mapNotNull(ReviewLine::oldLineNumber))
  val new = hunkRange(selected.mapNotNull(ReviewLine::newLineNumber))
  val body = selected.joinToString("\n") { line ->
    val marker = when (line.change) { "add" -> "+"; "delete" -> "-"; else -> " " }
    "$marker${line.content}"
  }
  val diff = "@@ -${old.first},${old.second} +${new.first},${new.second} @@\n${body.ifEmpty { " " }}"
  val longestFence = Regex("`+").findAll(diff).maxOfOrNull { it.value.length } ?: 0
  val fence = "`".repeat(maxOf(3, longestFence + 1))
  return buildString {
    append("<review_comment")
    append(" sectionId=\"").append(escapeReviewAttribute(selection.sectionId)).append('"')
    append(" sectionTitle=\"").append(escapeReviewAttribute(selection.sectionTitle)).append('"')
    append(" filePath=\"").append(escapeReviewAttribute(selection.filePath)).append('"')
    append(" startIndex=\"").append(selection.startIndex).append('"')
    append(" endIndex=\"").append(selection.endIndex).append('"')
    append(" rangeLabel=\"").append(escapeReviewAttribute(rangeLabel)).append("\">\n")
    append(comment.trim()).append('\n')
    append(fence).append("diff\n").append(diff).append('\n').append(fence).append('\n')
    append("</review_comment>")
  }
}

fun parseReviewComments(value: String): List<ReviewComment> = ReviewCommentPattern.findAll(value)
  .mapIndexedNotNull { index, match -> parseReviewComment(match, index) }
  .toList()

fun plainReviewMessageText(value: String): String {
  if (!ReviewCommentPattern.containsMatchIn(value)) return value
  return ReviewCommentPattern.replace(value, "").trim('\n')
}

fun replacePlainReviewMessageText(value: String, text: String): String {
  val blocks = ReviewCommentPattern.findAll(value).map(MatchResult::value).toList()
  if (blocks.isEmpty()) return text
  return if (text.isEmpty()) blocks.joinToString("\n\n")
  else "$text\n\n${blocks.joinToString("\n\n")}"
}

fun removeReviewComment(value: String, commentId: String): String {
  var parsedIndex = 0
  return ReviewCommentPattern.replace(value) { match ->
    val comment = parseReviewComment(match, parsedIndex++)
    if (comment?.id == commentId) "" else match.value
  }.replace(Regex("\\n{3,}"), "\n\n").trim()
}

fun parseReviewMessageSegments(value: String): List<ReviewMessageSegment> {
  val segments = mutableListOf<ReviewMessageSegment>()
  var cursor = 0
  ReviewCommentPattern.findAll(value).forEachIndexed { index, match ->
    if (match.range.first > cursor) {
      segments += ReviewMessageSegment.Text(value.substring(cursor, match.range.first))
    }
    val comment = parseReviewComment(match, index)
    segments += if (comment != null) ReviewMessageSegment.Comment(comment)
    else ReviewMessageSegment.Text(match.value)
    cursor = match.range.last + 1
  }
  if (cursor < value.length) segments += ReviewMessageSegment.Text(value.substring(cursor))
  return segments.ifEmpty { listOf(ReviewMessageSegment.Text(value)) }
}

private fun parseReviewComment(match: MatchResult, index: Int): ReviewComment? {
  val attributes = AttributePattern.findAll(match.groupValues[1]).associate {
    it.groupValues[1] to unescapeReviewAttribute(it.groupValues[2])
  }
  val sectionId = attributes["sectionId"]?.takeIf(String::isNotBlank) ?: return null
  val filePath = attributes["filePath"]?.takeIf(String::isNotBlank) ?: return null
  val startIndex = attributes["startIndex"]?.toIntOrNull() ?: return null
  val endIndex = attributes["endIndex"]?.toIntOrNull() ?: return null
  val rawBody = match.groupValues[2].trim()
  val fence = FencePattern.findAll(rawBody).lastOrNull()
  return ReviewComment(
    id = "review-comment:$index:$sectionId:$filePath:$startIndex:$endIndex",
    sectionId = sectionId,
    sectionTitle = attributes["sectionTitle"]?.ifBlank { "Review" } ?: "Review",
    filePath = filePath,
    startIndex = minOf(startIndex, endIndex),
    endIndex = maxOf(startIndex, endIndex),
    rangeLabel = attributes["rangeLabel"]?.ifBlank { "line" } ?: "line",
    text = rawBody.substring(0, fence?.range?.first ?: rawBody.length).trim(),
    diff = fence?.groupValues?.get(1).orEmpty(),
  )
}

private fun reviewRangeLabel(lines: List<ReviewLine>): String {
  val first = lines.firstOrNull() ?: return "line"
  val last = lines.last()
  val firstNumber = first.newLineNumber ?: first.oldLineNumber ?: return "${lines.size} lines"
  val lastNumber = last.newLineNumber ?: last.oldLineNumber ?: firstNumber
  val marker = when {
    lines.all { it.change == "add" } -> "+"
    lines.all { it.change == "delete" } -> "-"
    else -> ""
  }
  return if (firstNumber == lastNumber) "$marker$firstNumber" else "$marker$firstNumber to $marker$lastNumber"
}

private fun hunkRange(numbers: List<Int>) =
  if (numbers.isEmpty()) 0 to 0 else numbers.first() to numbers.size

private fun escapeReviewAttribute(value: String) = value
  .replace("&", "&amp;")
  .replace("\"", "&quot;")
  .replace("<", "&lt;")
  .replace(">", "&gt;")

private fun unescapeReviewAttribute(value: String) = value
  .replace("&lt;", "<")
  .replace("&gt;", ">")
  .replace("&quot;", "\"")
  .replace("&amp;", "&")

private val HunkPattern = Regex("^@@ -(\\d+)(,(\\d+))? \\+(\\d+)(,(\\d+))? @@(.*)$")
private val ReviewCommentPattern = Regex("<review_comment\\b([^>]*)>\\s*([\\s\\S]*?)</review_comment>")
private val AttributePattern = Regex("([a-zA-Z][a-zA-Z0-9_-]*)=\"([^\"]*)\"")
private val FencePattern = Regex("`{3,}[^\\n`]*\\n([\\s\\S]*?)\\n`{3,}")
