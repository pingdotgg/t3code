package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.Project
import com.t3tools.android.protocol.RepositoryIdentity
import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectGroupingModelTest {
  private val identity = RepositoryIdentity(
    canonicalKey = "github.com/acme/repo",
    rootPath = "/work/repo",
    displayName = "acme/repo",
    name = "repo",
  )

  @Test
  fun supports_repository_repository_path_and_separate_modes() {
    val projects = listOf(
      project("root", "Repo", "/work/repo"),
      project("app", "App", "/work/repo/apps/app"),
      project("copy", "Copy", "/other/repo"),
    )

    assertEquals(1, buildLogicalProjectGroups(projects, ProjectGroupingMode.Repository).size)
    assertEquals(2, buildLogicalProjectGroups(projects, ProjectGroupingMode.RepositoryPath).size)
    assertEquals(3, buildLogicalProjectGroups(projects, ProjectGroupingMode.Separate).size)
  }

  @Test
  fun projects_without_repository_identity_remain_separate() {
    val projects = listOf(
      project("one", "Same title", "/work/one", repositoryIdentity = null),
      project("two", "Same title", "/work/two", repositoryIdentity = null),
    )

    assertEquals(2, buildLogicalProjectGroups(projects, ProjectGroupingMode.Repository).size)
  }

  private fun project(
    id: String,
    title: String,
    path: String,
    repositoryIdentity: RepositoryIdentity? = identity,
  ) = Project(
    id = id,
    title = title,
    workspaceRoot = path,
    defaultModelSelection = null,
    scripts = emptyList(),
    repositoryIdentity = repositoryIdentity,
    updatedAt = "2026-08-11T00:00:00Z",
  )
}
