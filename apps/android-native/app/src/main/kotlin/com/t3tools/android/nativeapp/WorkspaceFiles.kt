package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.WorkspaceEntry

data class WorkspaceTreeNode(
  val path: String,
  val name: String,
  val kind: String,
  val children: List<WorkspaceTreeNode>,
)

data class VisibleWorkspaceNode(val node: WorkspaceTreeNode, val depth: Int)

private data class MutableWorkspaceNode(
  val path: String,
  val name: String,
  var kind: String,
  val children: MutableMap<String, MutableWorkspaceNode> = linkedMapOf(),
)

fun buildWorkspaceTree(entries: List<WorkspaceEntry>): List<WorkspaceTreeNode> {
  val root = MutableWorkspaceNode("", "", "directory")
  entries.forEach { entry ->
    val parts = entry.path.split('/').filter(String::isNotBlank)
    var parent = root
    parts.forEachIndexed { index, name ->
      val path = parts.take(index + 1).joinToString("/")
      val leaf = index == parts.lastIndex
      val child = parent.children.getOrPut(name) {
        MutableWorkspaceNode(path, name, if (leaf) entry.kind else "directory")
      }
      if (leaf) child.kind = entry.kind
      parent = child
    }
  }
  return root.children.values.map(MutableWorkspaceNode::freeze).sortedWith(workspaceNodeOrder)
}

private fun MutableWorkspaceNode.freeze(): WorkspaceTreeNode = WorkspaceTreeNode(
  path = path,
  name = name,
  kind = kind,
  children = children.values.map(MutableWorkspaceNode::freeze).sortedWith(workspaceNodeOrder),
)

private val workspaceNodeOrder = compareBy<WorkspaceTreeNode> { it.kind != "directory" }
  .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }

fun visibleWorkspaceNodes(
  nodes: List<WorkspaceTreeNode>,
  expanded: Set<String>,
): List<VisibleWorkspaceNode> = buildList {
  fun append(node: WorkspaceTreeNode, depth: Int) {
    add(VisibleWorkspaceNode(node, depth))
    if (node.kind == "directory" && node.path in expanded) {
      node.children.forEach { append(it, depth + 1) }
    }
  }
  nodes.forEach { append(it, 0) }
}

fun isMarkdownWorkspacePath(path: String): Boolean = path.substringAfterLast('.', "")
  .lowercase() in setOf("md", "mdx", "markdown")

fun workspaceFileName(path: String): String = path.substringAfterLast('/').ifBlank { path }

fun resolveWorkspaceFilePath(cwd: String, relativePath: String): String {
  if (relativePath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.containsMatchIn(relativePath) ||
    relativePath.startsWith("\\\\")) return relativePath
  val separator = if (WINDOWS_ABSOLUTE_PATH.containsMatchIn(cwd) || cwd.startsWith("\\\\")) '\\' else '/'
  val next = relativePath.trimStart('/', '\\').let {
    if (separator == '\\') it.replace('/', '\\') else it
  }
  return cwd.trimEnd('/', '\\') + separator + next
}

private val WINDOWS_ABSOLUTE_PATH = Regex("^[A-Za-z]:[\\\\/]")
