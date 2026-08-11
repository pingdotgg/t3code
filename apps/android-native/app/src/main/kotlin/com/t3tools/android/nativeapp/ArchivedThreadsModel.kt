package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.Project
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.ThreadSummary
import java.time.Duration
import java.time.Instant

data class ArchivedEnvironmentReport(
  val environmentId: String,
  val environmentLabel: String,
  val snapshot: ShellState? = null,
  val error: String? = null,
)

data class ArchivedThreadsUiState(
  val reports: List<ArchivedEnvironmentReport> = emptyList(),
  val loading: Boolean = false,
  val error: String? = null,
)

enum class ArchivedThreadSortOrder { Newest, Oldest }

data class ArchivedThreadEntry(
  val environmentId: String,
  val environmentLabel: String,
  val project: Project,
  val thread: ThreadSummary,
)

data class ArchivedThreadGroup(
  val key: String,
  val environmentLabel: String,
  val project: Project,
  val threads: List<ArchivedThreadEntry>,
)

fun archivedThreadAgeLabel(iso: String?, now: Instant = Instant.now()): String {
  val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
  val seconds = Duration.between(instant, now).seconds.coerceAtLeast(0)
  return when {
    seconds < 60 -> "now"
    seconds < 3_600 -> "${seconds / 60}m"
    seconds < 86_400 -> "${seconds / 3_600}h"
    else -> "${seconds / 86_400}d"
  }
}

fun buildArchivedThreadGroups(
  reports: List<ArchivedEnvironmentReport>,
  environmentId: String?,
  search: String,
  sortOrder: ArchivedThreadSortOrder,
): List<ArchivedThreadGroup> {
  val query = search.trim().lowercase()
  val entryComparator = if (sortOrder == ArchivedThreadSortOrder.Newest) {
    compareByDescending<ArchivedThreadEntry> { archiveTimestamp(it.thread) }
  } else {
    compareBy { archiveTimestamp(it.thread) }
  }.thenBy { it.thread.title.lowercase() }.thenBy { it.thread.id }

  return reports.asSequence()
    .filter { environmentId == null || it.environmentId == environmentId }
    .flatMap { report ->
      val snapshot = report.snapshot ?: return@flatMap emptySequence()
      snapshot.projects.values.asSequence().mapNotNull { project ->
        val projectMatches = query.isEmpty() || listOf(
          report.environmentLabel,
          project.title,
          project.workspaceRoot,
        ).any { query in it.lowercase() }
        val threads = snapshot.threads.values.asSequence()
          .filter { it.projectId == project.id && it.archivedAt != null }
          .filter { thread ->
            projectMatches || listOfNotNull(thread.title, thread.branch).any { query in it.lowercase() }
          }
          .map { thread ->
            ArchivedThreadEntry(report.environmentId, report.environmentLabel, project, thread)
          }
          .sortedWith(entryComparator)
          .toList()
        threads.takeIf(List<ArchivedThreadEntry>::isNotEmpty)?.let {
          ArchivedThreadGroup("${report.environmentId}:${project.id}", report.environmentLabel, project, it)
        }
      }
    }
    .sortedWith(
      compareBy<ArchivedThreadGroup> { group ->
        val timestamp = archiveTimestamp(group.threads.first().thread)
        if (sortOrder == ArchivedThreadSortOrder.Newest) -timestamp else timestamp
      }.thenBy { it.project.title.lowercase() }.thenBy { it.key },
    )
    .toList()
}

private fun archiveTimestamp(thread: ThreadSummary): Long =
  runCatching { Instant.parse(thread.archivedAt ?: thread.updatedAt).toEpochMilli() }.getOrDefault(0)
