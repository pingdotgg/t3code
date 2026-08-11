package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.Project
import com.t3tools.android.protocol.ShellState
import com.t3tools.android.protocol.ThreadSummary
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class ArchivedThreadsModelTest {
  @Test
  fun formats_archived_age_as_a_compact_day_count() {
    assertEquals(
      "17d",
      archivedThreadAgeLabel(
        "2026-07-22T12:00:00Z",
        Instant.parse("2026-08-08T12:00:00Z"),
      ),
    )
  }

  @Test
  fun groups_archived_threads_and_supports_search_environment_and_sorting() {
    val project = Project("project-1", "T3 Code", "/work/t3", null, emptyList())
    val reports = listOf(
      ArchivedEnvironmentReport(
        environmentId = "env-1",
        environmentLabel = "Ubuntu",
        snapshot = ShellState(
          projects = mapOf(project.id to project),
          threads = listOf(
            thread("old", "Old archive", project.id, "2026-08-01T00:00:00Z"),
            thread("new", "New archive", project.id, "2026-08-10T00:00:00Z", branch = "fix/archive"),
            thread("live", "Not archived", project.id, null),
          ).associateBy(ThreadSummary::id),
        ),
      ),
      ArchivedEnvironmentReport("env-2", "Offline", error = "Environment is disconnected."),
    )

    assertEquals(
      listOf("new", "old"),
      buildArchivedThreadGroups(reports, null, "", ArchivedThreadSortOrder.Newest)
        .single().threads.map { it.thread.id },
    )
    assertEquals(
      listOf("old", "new"),
      buildArchivedThreadGroups(reports, "env-1", "t3 code", ArchivedThreadSortOrder.Oldest)
        .single().threads.map { it.thread.id },
    )
    assertEquals(
      listOf("new"),
      buildArchivedThreadGroups(reports, null, "fix/archive", ArchivedThreadSortOrder.Newest)
        .single().threads.map { it.thread.id },
    )
    assertEquals(
      emptyList<ArchivedThreadGroup>(),
      buildArchivedThreadGroups(reports, "env-2", "", ArchivedThreadSortOrder.Newest),
    )
  }

  private fun thread(
    id: String,
    title: String,
    projectId: String,
    archivedAt: String?,
    branch: String? = null,
  ) = ThreadSummary(
    id = id,
    projectId = projectId,
    title = title,
    modelSelection = ModelSelection("codex", "gpt"),
    runtimeMode = "full-access",
    interactionMode = "default",
    branch = branch,
    worktreePath = null,
    latestTurn = null,
    session = null,
    updatedAt = archivedAt ?: "2026-08-11T00:00:00Z",
    archivedAt = archivedAt,
    hasPendingApprovals = false,
    hasPendingUserInput = false,
  )
}
