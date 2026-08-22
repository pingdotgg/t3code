@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.graphics.Typeface
import android.text.method.ScrollingMovementMethod
import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import com.t3tools.android.protocol.WorkspaceEntry

@Composable
fun AddProjectScreen(
  runtime: OnlineChatState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.addProjectState.collectAsState()
  var clone by remember { mutableStateOf(false) }
  var remoteUrl by remember { mutableStateOf("") }
  var environmentsOpen by remember { mutableStateOf(false) }
  val environmentId = runtime.environment?.environmentId

  LaunchedEffect(environmentId) {
    viewModel.resetAddProject()
    if (environmentId != null) viewModel.browseProjectPath()
  }
  BackHandler(onBack = onBack)

  Scaffold(
    topBar = { WorkspaceBackBar("Add project", onBack) },
  ) { padding ->
    Column(
      Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      if (runtime.environments.size > 1) {
        Box {
          OutlinedButton(
            onClick = { environmentsOpen = true },
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(runtime.environment?.label ?: "Choose environment", modifier = Modifier.weight(1f))
            Icon(Icons.Rounded.ExpandMore, contentDescription = null)
          }
          DropdownMenu(
            expanded = environmentsOpen,
            onDismissRequest = { environmentsOpen = false },
          ) {
            runtime.environments.forEach { environment ->
              DropdownMenuItem(
                text = { Text(environment.label) },
                trailingIcon = if (environment.environmentId == environmentId) {
                  { Icon(Icons.Rounded.Check, contentDescription = null) }
                } else null,
                onClick = {
                  environmentsOpen = false
                  viewModel.selectEnvironment(environment.environmentId)
                },
              )
            }
          }
        }
      }

      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(
          selected = !clone,
          onClick = { clone = false },
          label = { Text("Local folder") },
          leadingIcon = { Icon(Icons.Rounded.Folder, contentDescription = null, modifier = Modifier.size(18.dp)) },
        )
        FilterChip(
          selected = clone,
          onClick = { clone = true },
          label = { Text("Clone Git URL") },
          leadingIcon = { Icon(Icons.Rounded.Code, contentDescription = null, modifier = Modifier.size(18.dp)) },
        )
      }

      if (clone) {
        OutlinedTextField(
          value = remoteUrl,
          onValueChange = { remoteUrl = it },
          label = { Text("Repository URL") },
          placeholder = { Text("https://github.com/owner/repository.git") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
      }
      CompactInputField(
        value = state.path,
        onValueChange = viewModel::updateAddProjectPath,
        placeholder = if (clone) "Clone destination" else "Project path",
        trailingIcon = Icons.Rounded.Search,
        trailingContentDescription = "Browse path",
        onTrailingClick = viewModel::browseProjectPath,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(
        onClick = { viewModel.addProject(state.path, remoteUrl.takeIf { clone }) },
        enabled = !state.submitting && !state.browsing && state.path.isNotBlank() &&
          (!clone || remoteUrl.isNotBlank()) && runtime.connectionPhase == ConnectionPhase.Connected,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(if (state.submitting) "Working…" else if (clone) "Clone and add" else "Add project")
      }

      state.error?.let { error -> WorkspaceError(message = error) }
      if (state.browsing) LinearProgressIndicator(Modifier.fillMaxWidth())

      Text("Folders", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      state.parentPath?.let { parent ->
        WorkspaceFolderRow(
          label = "..",
          path = parent,
          onClick = {
            viewModel.updateAddProjectPath(parent)
            viewModel.browseProjectPath(parent)
          },
        )
      }
      state.directories.forEach { entry ->
        WorkspaceFolderRow(
          label = entry.name,
          path = entry.fullPath,
          onClick = {
            val next = entry.fullPath.trimEnd('/') + "/"
            viewModel.updateAddProjectPath(next)
            viewModel.browseProjectPath(next)
          },
        )
      }
      if (!state.browsing && state.directories.isEmpty() && state.error == null) {
        Text("No folders found.", color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}

@Composable
private fun WorkspaceFolderRow(label: String, path: String, onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(12.dp),
    color = Color(0xFF111113),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Row(
      Modifier.padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Icon(Icons.Rounded.Folder, contentDescription = null, tint = Color(0xFF60A5FA))
      Column(Modifier.weight(1f)) {
        Text(label, fontWeight = FontWeight.Medium)
        Text(path, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null)
    }
  }
}

@Composable
fun WorkspaceFilesScreen(
  threadId: String,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.workspaceFilesState.collectAsState()
  var query by remember(threadId) { mutableStateOf("") }
  var mode by remember(threadId) { mutableStateOf(WorkspaceSearchMode.Files) }
  val tree = remember(state.entries) { buildWorkspaceTree(state.entries) }
  var expanded by remember(threadId) { mutableStateOf<Set<String>>(emptySet()) }

  LaunchedEffect(threadId) { viewModel.openWorkspace(threadId) }
  LaunchedEffect(tree) {
    expanded = expanded + tree.filter { it.kind == "directory" }.map(WorkspaceTreeNode::path)
  }
  LaunchedEffect(query, mode) { viewModel.searchWorkspace(query, mode) }

  val leave: () -> Unit = {
    if (state.selectedPath != null) viewModel.closeWorkspaceFile()
    else {
      viewModel.clearWorkspace()
      onBack()
    }
  }
  BackHandler(onBack = leave)

  if (state.selectedPath != null) {
    WorkspaceFileViewer(state, viewModel, leave)
    return
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text("Files", fontWeight = FontWeight.SemiBold)
            Text(
              state.projectTitle,
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        },
        navigationIcon = {
          IconButton(onClick = leave) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = { viewModel.openWorkspace(threadId, force = true) }) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh files")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      if (state.loadingEntries || state.searching) LinearProgressIndicator(Modifier.fillMaxWidth())
      CompactSearchField(
        value = query,
        onValueChange = { query = it },
        placeholder = if (mode == WorkspaceSearchMode.Files) "Search files" else "Search contents",
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
      )
      Row(
        Modifier.padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        WorkspaceSearchMode.entries.forEach { choice ->
          FilterChip(
            selected = mode == choice,
            onClick = { mode = choice },
            label = { Text(if (choice == WorkspaceSearchMode.Files) "Files" else "Contents") },
          )
        }
      }
      if (state.entriesTruncated || state.searchTruncated) {
        Text(
          "Results are truncated.",
          color = Color(0xFFFBBF24),
          style = MaterialTheme.typography.labelMedium,
          modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
      }
      state.error?.let { error ->
        WorkspaceError(
          message = error,
          retry = {
            if (query.isBlank()) viewModel.openWorkspace(threadId, force = true)
            else viewModel.searchWorkspace(query, mode)
          },
        )
      }

      when {
        query.isNotBlank() && mode == WorkspaceSearchMode.Contents -> WorkspaceContentResults(
          state = state,
          onOpen = viewModel::openWorkspaceFile,
        )
        query.isNotBlank() -> WorkspaceEntryResults(
          entries = state.searchEntries,
          loading = state.searching,
          onOpen = viewModel::openWorkspaceFile,
        )
        else -> WorkspaceTree(
          nodes = visibleWorkspaceNodes(tree, expanded),
          loading = state.loadingEntries,
          expanded = expanded,
          onToggle = { path ->
            expanded = if (path in expanded) expanded - path else expanded + path
          },
          onOpen = viewModel::openWorkspaceFile,
        )
      }
    }
  }
}

@Composable
private fun WorkspaceTree(
  nodes: List<VisibleWorkspaceNode>,
  loading: Boolean,
  expanded: Set<String>,
  onToggle: (String) -> Unit,
  onOpen: (String) -> Unit,
) {
  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
  ) {
    items(nodes, key = { it.node.path }) { item ->
      WorkspaceEntryRow(
        entry = WorkspaceEntry(item.node.path, item.node.kind),
        depth = item.depth,
        expanded = item.node.path in expanded,
        onClick = {
          if (item.node.kind == "directory") onToggle(item.node.path) else onOpen(item.node.path)
        },
      )
    }
    if (!loading && nodes.isEmpty()) item { WorkspaceEmpty("No files found") }
  }
}

@Composable
private fun WorkspaceEntryResults(
  entries: List<WorkspaceEntry>,
  loading: Boolean,
  onOpen: (String) -> Unit,
) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp)) {
    items(entries, key = WorkspaceEntry::path) { entry ->
      WorkspaceEntryRow(entry, onClick = { if (entry.kind == "file") onOpen(entry.path) })
    }
    if (!loading && entries.isEmpty()) item { WorkspaceEmpty("No matching files") }
  }
}

@Composable
private fun WorkspaceContentResults(
  state: WorkspaceFilesUiState,
  onOpen: (String) -> Unit,
) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp)) {
    items(state.contentMatches, key = { "${it.path}:${it.lineNumber}:${it.lineContent}" }) { match ->
      Card(
        onClick = { onOpen(match.path) },
        colors = CardDefaults.cardColors(containerColor = Color(0xFF111113)),
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
      ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text("${match.path}:${match.lineNumber}", fontWeight = FontWeight.SemiBold)
          Text(
            match.lineContent.trim(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3,
          )
        }
      }
    }
    if (!state.searching && state.contentMatches.isEmpty()) item { WorkspaceEmpty("No content matches") }
  }
}

@Composable
private fun WorkspaceEntryRow(
  entry: WorkspaceEntry,
  depth: Int = 0,
  expanded: Boolean = false,
  onClick: () -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(start = (8 + depth * 18).dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Icon(
      imageVector = if (entry.kind == "directory") {
        if (expanded) Icons.Rounded.FolderOpen else Icons.Rounded.Folder
      } else if (isImageWorkspacePath(entry.path)) {
        Icons.Rounded.Image
      } else {
        Icons.AutoMirrored.Rounded.InsertDriveFile
      },
      contentDescription = null,
      tint = if (entry.kind == "directory") Color(0xFF60A5FA) else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.size(20.dp),
    )
    Text(
      workspaceFileName(entry.path),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    if (entry.kind == "directory") {
      Icon(
        if (expanded) Icons.Rounded.ExpandMore else Icons.AutoMirrored.Rounded.KeyboardArrowRight,
        contentDescription = null,
        modifier = Modifier.size(18.dp),
      )
    }
  }
}

@Composable
private fun WorkspaceFileViewer(
  state: WorkspaceFilesUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val path = requireNotNull(state.selectedPath)
  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text(workspaceFileName(path), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(path, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
          }
        },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back to files")
          }
        },
        actions = {
          IconButton(onClick = { viewModel.openWorkspaceFile(path) }) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh file")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding)) {
      if (state.loadingFile) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
      when {
        state.fileError != null -> WorkspaceError(
          message = state.fileError,
          retry = { viewModel.openWorkspaceFile(path) },
          modifier = Modifier.align(Alignment.Center),
        )
        isImageWorkspacePath(path) -> WorkspaceImageFile(
          url = state.assetUrl,
          name = workspaceFileName(path),
          retry = { viewModel.openWorkspaceFile(path) },
        )
        state.file != null -> WorkspaceTextFile(path, state.file.contents, state.file.truncated)
        !state.loadingFile -> WorkspaceEmpty("File unavailable")
      }
    }
  }
}

@Composable
private fun WorkspaceImageFile(url: String?, name: String, retry: () -> Unit) {
  var failed by remember(url) { mutableStateOf(false) }
  Box(Modifier.fillMaxSize()) {
    AsyncImage(
      model = url,
      contentDescription = name,
      contentScale = ContentScale.Fit,
      onError = { failed = true },
      modifier = Modifier.fillMaxSize().padding(16.dp),
    )
    if (failed) {
      WorkspaceError(
        message = "Image could not be loaded.",
        retry = retry,
        modifier = Modifier.align(Alignment.Center),
      )
    }
  }
}

@Composable
private fun WorkspaceTextFile(path: String, contents: String, truncated: Boolean) {
  Column(Modifier.fillMaxSize()) {
    if (truncated) {
      Text(
        "Partial file · preview limited to the first 1 MB",
        color = Color(0xFFFBBF24),
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.fillMaxWidth().background(Color(0xFF291A04)).padding(10.dp),
      )
    }
    if (isMarkdownWorkspacePath(path)) MarkdownFile(contents)
    else SourceFile(contents)
  }
}

@Composable
private fun MarkdownFile(markdown: String) {
  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
  ) {
    T3Markdown(markdown = markdown, streaming = false, modifier = Modifier.fillMaxWidth())
  }
}

@Composable
private fun SourceFile(contents: String) {
  val appearance = LocalT3Appearance.current
  AndroidView(
    factory = {
      TextView(it).apply {
        setTextColor(android.graphics.Color.rgb(228, 228, 231))
        setBackgroundColor(android.graphics.Color.BLACK)
        setTextIsSelectable(true)
        typeface = Typeface.MONOSPACE
        setPadding(28, 20, 28, 40)
        movementMethod = ScrollingMovementMethod.getInstance()
      }
    },
    update = {
      it.textSize = appearance.codeFontSize
      it.setHorizontallyScrolling(!appearance.codeWordBreak)
      it.text = contents
    },
    modifier = Modifier.fillMaxSize(),
  )
}

@Composable
private fun WorkspaceError(
  message: String,
  modifier: Modifier = Modifier,
  retry: (() -> Unit)? = null,
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = Color(0xFF2A0B0B)),
    modifier = modifier.fillMaxWidth().padding(12.dp),
  ) {
    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
      if (retry != null) TextButton(onClick = retry) { Text("Retry") }
    }
  }
}

@Composable
private fun WorkspaceEmpty(message: String) {
  Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
    Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable
private fun WorkspaceBackBar(title: String, onBack: () -> Unit) {
  TopAppBar(
    title = { Text(title, fontWeight = FontWeight.SemiBold) },
    navigationIcon = {
      IconButton(onClick = onBack) {
        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
      }
    },
    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
  )
}
