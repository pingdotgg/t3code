package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.Project
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ProjectGroupingMode {
  @SerialName("repository") Repository,
  @SerialName("repository_path") RepositoryPath,
  @SerialName("separate") Separate,
}

data class LogicalProjectGroup(
  val key: String,
  val label: String,
  val representative: Project,
  val projects: List<Project>,
) {
  val projectIds = projects.mapTo(linkedSetOf(), Project::id)
}

fun buildLogicalProjectGroups(
  projects: Collection<Project>,
  mode: ProjectGroupingMode,
): List<LogicalProjectGroup> {
  val physicalProjects = projects
    .groupBy { normalizeProjectPath(it.workspaceRoot) }
    .values
    .map { matches -> matches.maxWith(compareBy<Project> { it.updatedAt }.thenBy { it.id }) }

  return physicalProjects.groupBy { logicalProjectKey(it, mode) }
    .map { (key, members) ->
      val sorted = members.sortedWith(compareBy<Project> { it.title.lowercase() }.thenBy { it.workspaceRoot })
      val representative = sorted.maxWith(compareBy<Project> { it.updatedAt }.thenBy { it.id })
      LogicalProjectGroup(
        key = key,
        label = projectGroupLabel(sorted, representative),
        representative = representative,
        projects = sorted,
      )
    }
    .sortedWith(compareBy<LogicalProjectGroup> { it.label.lowercase() }.thenBy { it.key })
}

private fun logicalProjectKey(project: Project, mode: ProjectGroupingMode): String {
  val physicalKey = "path:${normalizeProjectPath(project.workspaceRoot)}"
  if (mode == ProjectGroupingMode.Separate) return physicalKey
  val identity = project.repositoryIdentity ?: return physicalKey
  if (mode == ProjectGroupingMode.Repository) return "repo:${identity.canonicalKey}"
  val root = identity.rootPath?.let(::normalizeProjectPath) ?: return "repo:${identity.canonicalKey}"
  val path = normalizeProjectPath(project.workspaceRoot)
  val relative = when {
    path == root -> ""
    path.startsWith("$root/") -> path.removePrefix("$root/")
    else -> return "repo:${identity.canonicalKey}"
  }
  return if (relative.isEmpty()) {
    "repo:${identity.canonicalKey}"
  } else {
    "repo:${identity.canonicalKey}::$relative"
  }
}

private fun projectGroupLabel(projects: List<Project>, representative: Project): String {
  val displayNames = projects.mapNotNull { it.repositoryIdentity?.displayName?.trim() }
    .filter(String::isNotEmpty).distinct()
  if (displayNames.size == 1) return displayNames.single()
  val names = projects.mapNotNull { it.repositoryIdentity?.name?.trim() }
    .filter(String::isNotEmpty).distinct()
  return names.singleOrNull() ?: representative.title
}

private fun normalizeProjectPath(path: String): String =
  path.trim().replace('\\', '/').trimEnd('/').lowercase()
