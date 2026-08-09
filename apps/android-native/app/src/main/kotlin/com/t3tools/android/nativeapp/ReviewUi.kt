@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AddComment
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import expo.modules.t3reviewdiff.ReviewDiffSurfaceView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

@Composable
fun ReviewScreen(
  threadId: String,
  connectionPhase: ConnectionPhase,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.reviewState.collectAsState()
  val runtime by viewModel.runtime.collectAsState()
  val draftRevision by viewModel.draftRevision.collectAsState()
  val targetKey = state.targetKey
  val files = (state.parsed as? ParsedReviewDiff.Files)?.files.orEmpty()
  val section = state.selectedSection
  val draftKey = state.environmentId?.let { DraftStore.threadKey(it, threadId) }
  val comments = remember(draftRevision, draftKey) {
    draftKey?.let(viewModel::loadDraft)?.text?.let(::parseReviewComments).orEmpty()
  }
  val rowsJson = remember(
    state.parsed,
    state.expandedFileIds,
    state.revealedLargeFileIds,
    comments,
  ) {
    buildReviewRowsJson(
      state.parsed,
      state.expandedFileIds,
      state.revealedLargeFileIds,
      comments.filter { it.sectionId == section?.id },
    )
  }
  val selectedRowIdsJson = remember(state.selection) {
    JsonArray(
      state.selection?.lines
        ?.slice(state.selection!!.startIndex..state.selection!!.endIndex)
        ?.map { JsonPrimitive(it.id) }
        .orEmpty(),
    ).toString()
  }
  val collapsedFileIdsJson = remember(files, state.expandedFileIds) {
    JsonArray(files.filterNot { it.id in state.expandedFileIds }.map { JsonPrimitive(it.id) })
      .toString()
  }
  val viewedFileIdsJson = remember(state.viewedFileIds) {
    JsonArray(state.viewedFileIds.map(::JsonPrimitive)).toString()
  }
  var surface by remember { mutableStateOf<ReviewDiffSurfaceView?>(null) }
  var menuExpanded by remember { mutableStateOf(false) }
  var collapsedCommentIds by remember(section?.id) { mutableStateOf(emptySet<String>()) }
  var commentDialog by remember { mutableStateOf(false) }
  var commentText by remember { mutableStateOf("") }

  LaunchedEffect(threadId) { viewModel.openReview(threadId, force = true) }
  LaunchedEffect(threadId, runtime.thread.detail?.checkpoints) {
    viewModel.syncReviewCheckpoints(threadId)
  }
  LaunchedEffect(surface, rowsJson) { surface?.setRowsJson(rowsJson) }
  DisposableEffect(targetKey) {
    onDispose { if (targetKey.isNotEmpty()) viewModel.stopReviewRoute(targetKey) }
  }
  BackHandler(onBack = onBack)

  Scaffold(
    containerColor = Color.Black,
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text("Review changes", style = MaterialTheme.typography.titleMedium)
            Text(
              listOfNotNull(
                section?.title,
                (state.parsed as? ParsedReviewDiff.Files)?.let { "+${it.additions} · -${it.deletions}" },
              ).joinToString(" · ").ifBlank { "Select a diff" },
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = viewModel::refreshReview, enabled = !state.loading) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh review")
          }
          Box {
            IconButton(onClick = { menuExpanded = true }) {
              Icon(Icons.Rounded.MoreVert, contentDescription = "Select review diff")
            }
            DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
              state.sections.forEach { item ->
                DropdownMenuItem(
                  text = {
                    Column {
                      Text(
                        if (item.id == state.selectedSectionId) "✓ ${item.title}" else item.title,
                        fontWeight = if (item.id == state.selectedSectionId) FontWeight.Bold else null,
                      )
                      item.subtitle?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall)
                      }
                    }
                  },
                  onClick = {
                    menuExpanded = false
                    viewModel.selectReviewSection(item.id)
                  },
                )
              }
              files.filter { it.isLarge && it.id !in state.revealedLargeFileIds }.forEach { file ->
                DropdownMenuItem(
                  text = { Text("Load ${file.path.substringAfterLast('/')}") },
                  onClick = {
                    menuExpanded = false
                    viewModel.revealLargeReviewFile(file.id)
                  },
                )
              }
            }
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      if (connectionPhase != ConnectionPhase.Connected) {
        Surface(color = Color(0xFF291804), modifier = Modifier.fillMaxWidth()) {
          Text(
            if (state.parsed == ParsedReviewDiff.Empty) "Reconnect to load review changes."
            else "Showing the last loaded diff while disconnected.",
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            style = MaterialTheme.typography.bodySmall,
          )
        }
      }
      if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
      state.error?.let { error ->
        Surface(color = Color(0xFF2B1113), modifier = Modifier.fillMaxWidth()) {
          Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(error, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = viewModel::refreshReview) { Text("Retry") }
          }
        }
      }
      if ((state.parsed as? ParsedReviewDiff.Files)?.truncated == true) {
        Surface(color = Color(0xFF291804), modifier = Modifier.fillMaxWidth()) {
          Text(
            "Partial diff: the server truncated this section.",
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            style = MaterialTheme.typography.bodySmall,
          )
        }
      }
      if (files.isNotEmpty()) {
        Row(
          Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          files.forEach { file ->
            OutlinedButton(onClick = { surface?.scrollToFile(file.id, true) }) {
              Text(
                "${if (file.id in state.viewedFileIds) "✓ " else ""}${file.path.substringAfterLast('/')}  +${file.additions} -${file.deletions}",
                maxLines = 1,
              )
            }
          }
        }
      }
      Box(Modifier.fillMaxWidth().weight(1f)) {
        when (val parsed = state.parsed) {
          ParsedReviewDiff.Empty -> ReviewEmptyState(state.loading, section)
          is ParsedReviewDiff.Raw -> ReviewRawState(parsed)
          is ParsedReviewDiff.Files -> AndroidView(
            factory = { context ->
              ReviewDiffSurfaceView(context).apply {
                setAppearanceScheme("dark")
                setRowHeight(24f)
                setContentWidth(2800f)
                setRowsJson(rowsJson)
                onToggleFile = { event ->
                  (event["fileId"] as? String)?.let(viewModel::toggleReviewFile)
                }
                onToggleViewedFile = { event ->
                  (event["fileId"] as? String)?.let(viewModel::toggleReviewViewed)
                }
                onPressLine = { event ->
                  (event["rowId"] as? String)?.let { rowId ->
                    val extend = event["gesture"] == "longPress" ||
                      viewModel.reviewState.value.selection != null
                    viewModel.selectReviewLine(rowId, extend)
                  }
                }
                onToggleComment = { event ->
                  (event["commentId"] as? String)?.let { id ->
                    collapsedCommentIds = collapsedCommentIds.toMutableSet().apply {
                      if (!add(id)) remove(id)
                    }
                  }
                }
                surface = this
              }
            },
            update = { view ->
              view.setContentResetKey("${state.targetKey}:${section?.id}")
              view.setCollapsedFileIdsJson(collapsedFileIdsJson)
              view.setViewedFileIdsJson(viewedFileIdsJson)
              view.setSelectedRowIdsJson(selectedRowIdsJson)
              view.setCollapsedCommentIdsJson(
                JsonArray(collapsedCommentIds.map(::JsonPrimitive)).toString(),
              )
              if (surface !== view) surface = view
            },
            onRelease = { view ->
              if (surface === view) surface = null
              view.cleanup()
            },
            modifier = Modifier.fillMaxSize().background(Color(0xFF0E0E0E)),
          )
        }
        state.selection?.let { selection ->
          Surface(
            color = Color(0xFF2563EB),
            shape = MaterialTheme.shapes.extraLarge,
            modifier = Modifier.align(Alignment.BottomCenter).padding(18.dp),
          ) {
            Row(
              Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              TextButton(onClick = { commentDialog = true }) {
                Icon(Icons.Rounded.AddComment, contentDescription = null, tint = Color.White)
                Spacer(Modifier.width(7.dp))
                Text("Comment on ${reviewSelectionLabel(selection)}", color = Color.White)
              }
              IconButton(onClick = viewModel::clearReviewSelection, modifier = Modifier.size(38.dp)) {
                Icon(Icons.Rounded.Close, contentDescription = "Clear selection", tint = Color.White)
              }
            }
          }
        }
      }
    }
  }

  if (commentDialog) {
    AlertDialog(
      onDismissRequest = { commentDialog = false },
      title = { Text("Add comment") },
      text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          state.selection?.let {
            Text(
              "${it.filePath} · ${reviewSelectionLabel(it)}",
              style = MaterialTheme.typography.labelMedium,
            )
          }
          OutlinedTextField(
            value = commentText,
            onValueChange = { commentText = it },
            label = { Text("Comment") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
          )
        }
      },
      confirmButton = {
        Button(
          onClick = {
            viewModel.appendReviewComment(commentText)
            commentText = ""
            commentDialog = false
            onBack()
          },
          enabled = commentText.isNotBlank(),
        ) { Text("Add to draft") }
      },
      dismissButton = {
        TextButton(onClick = { commentDialog = false }) { Text("Cancel") }
      },
    )
  }
}

@Composable
private fun ReviewEmptyState(loading: Boolean, section: ReviewSection?) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    if (loading) {
      CircularProgressIndicator()
    } else {
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(if (section == null) "No review diffs" else "No changes", fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
          section?.subtitle ?: "This thread has no ready turn or Git changes.",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}

@Composable
private fun ReviewRawState(parsed: ParsedReviewDiff.Raw) {
  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
    Text(parsed.reason, color = MaterialTheme.colorScheme.error)
    if (parsed.truncated) Text("The server returned a partial diff.")
    Spacer(Modifier.height(12.dp))
    Text(parsed.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
  }
}

private fun reviewSelectionLabel(selection: ReviewSelection): String {
  val selected = selection.lines.slice(selection.startIndex..selection.endIndex)
  val first = selected.firstOrNull() ?: return "line"
  val last = selected.last()
  val start = first.newLineNumber ?: first.oldLineNumber ?: return "${selected.size} lines"
  val end = last.newLineNumber ?: last.oldLineNumber ?: start
  return if (start == end) "line $start" else "lines $start–$end"
}

@Composable
fun ReviewCommentCard(comment: ReviewComment, onRemove: (() -> Unit)? = null) {
  Surface(
    color = Color(0xFF111827),
    shape = MaterialTheme.shapes.medium,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(comment.sectionTitle, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
          Text(
            "${comment.filePath} · ${comment.rangeLabel}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
          )
        }
        onRemove?.let {
          IconButton(onClick = it, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Rounded.Close, contentDescription = "Remove review comment")
          }
        }
      }
      Text(comment.text)
      if (comment.diff.isNotBlank()) {
        Text(
          comment.diff,
          fontFamily = FontFamily.Monospace,
          style = MaterialTheme.typography.bodySmall,
          maxLines = 8,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.fillMaxWidth().background(Color(0xFF09090B)).padding(8.dp),
        )
      }
    }
  }
}
