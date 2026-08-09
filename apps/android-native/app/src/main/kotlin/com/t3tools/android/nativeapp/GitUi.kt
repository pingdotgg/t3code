@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.t3tools.android.protocol.GitStackedAction
import com.t3tools.android.protocol.VcsChangedFile

@Composable
fun GitOverviewScreen(
  threadId: String,
  state: GitUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onCommit: () -> Unit,
  onBranches: () -> Unit,
) {
  LaunchedEffect(threadId) { viewModel.observeGit(threadId) }
  val status = state.status
  val busy = state.operation != null
  val quick = resolveGitQuickAction(status, busy)
  val context = LocalContext.current
  var pendingAction by remember { mutableStateOf<GitStackedAction?>(null) }

  fun run(action: GitStackedAction) {
    if (requiresDefaultBranchConfirmation(action, status?.isDefaultRef == true)) {
      pendingAction = action
    } else {
      viewModel.runGitAction(action)
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text(status?.refName ?: "Repository", maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
              gitStatusSummary(status),
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = viewModel::refreshGitStatus, enabled = !busy) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh repository status")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      if (state.loading && status == null) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
      item { GitStatusCard(state) }
      if (status?.isRepo == true) {
        item {
          Button(
            onClick = {
              when (quick.kind) {
                GitQuickActionKind.RunAction -> quick.action?.let(::run)
                GitQuickActionKind.Pull -> viewModel.pullGit()
                GitQuickActionKind.OpenPr -> status.pullRequest?.url?.let(context::openExternalUrl)
                GitQuickActionKind.Hint -> Unit
              }
            },
            enabled = quick.enabled && !busy,
            modifier = Modifier.fillMaxWidth(),
          ) { Text(quick.label) }
          quick.hint?.let {
            Text(
              it,
              modifier = Modifier.padding(top = 6.dp),
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        }
        item {
          GitActionCard {
            GitActionRow(
              title = "Commit",
              detail = status.workingTree.let {
                "${it.files.size} files · +${it.insertions} / -${it.deletions}"
              },
              enabled = status.hasWorkingTreeChanges && !busy,
              onClick = onCommit,
            )
            HorizontalDivider()
            GitActionRow(
              title = "Push",
              detail = if (status.aheadCount > 0) "${status.aheadCount} commits ahead" else "No commits to push",
              enabled = !status.hasWorkingTreeChanges && status.aheadCount > 0 &&
                status.behindCount == 0 && (status.hasUpstream || status.hasPrimaryRemote) && !busy,
              onClick = { run(GitStackedAction.Push) },
            )
            HorizontalDivider()
            GitActionRow(
              title = if (status.pullRequest?.state == "open") "View PR" else "Create PR",
              detail = status.pullRequest?.let { "PR #${it.number} · ${it.state}" }
                ?: "Push this branch and open a pull request",
              enabled = if (status.pullRequest?.state == "open") !busy else {
                !status.hasWorkingTreeChanges && status.aheadCount > 0 && status.behindCount == 0 &&
                  (status.hasUpstream || status.hasPrimaryRemote) && !busy
              },
              onClick = {
                status.pullRequest?.takeIf { it.state == "open" }?.url?.let(context::openExternalUrl)
                  ?: run(GitStackedAction.CreatePr)
              },
            )
            if (status.behindCount > 0) {
              HorizontalDivider()
              GitActionRow(
                title = "Pull latest",
                detail = "${status.behindCount} commits behind upstream",
                enabled = status.aheadCount == 0 && !busy,
                onClick = viewModel::pullGit,
              )
            }
            HorizontalDivider()
            GitActionRow(
              title = "Branches & worktrees",
              detail = "Switch or create a branch or worktree",
              enabled = !busy,
              onClick = onBranches,
            )
          }
        }
        if (status.workingTree.files.isNotEmpty()) {
          item {
            Text("Changed files", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            GitChangedFiles(status.workingTree.files.take(8))
          }
        }
      }
      state.error?.let { error ->
        item {
          Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
      }
    }
  }

  pendingAction?.let { action ->
    DefaultBranchConfirmation(
      action = action,
      branch = status?.refName.orEmpty(),
      onDismiss = { pendingAction = null },
      onContinue = {
        pendingAction = null
        viewModel.runGitAction(action)
      },
      onFeatureBranch = {
        pendingAction = null
        viewModel.runGitAction(action, useFeatureBranch = true)
      },
    )
  }
}

@Composable
fun GitCommitScreen(
  threadId: String,
  state: GitUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  LaunchedEffect(threadId) { viewModel.observeGit(threadId) }
  val files = state.status?.workingTree?.files.orEmpty()
  var selected by remember(state.cwd, files.map(VcsChangedFile::path)) {
    mutableStateOf(files.mapTo(mutableSetOf(), VcsChangedFile::path))
  }
  var message by remember(state.cwd) { mutableStateOf("") }
  val selectedFiles = files.filter { it.path in selected }
  val busy = state.operation != null

  Scaffold(
    topBar = { GitTopBar("Commit changes", onBack) },
  ) { padding ->
    Column(
      modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      GitStatusCard(state)
      Text(
        "${selectedFiles.size} selected · +${selectedFiles.sumOf { it.insertions }} / -${selectedFiles.sumOf { it.deletions }}",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column {
          files.forEachIndexed { index, file ->
            Row(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Checkbox(
                checked = file.path in selected,
                onCheckedChange = { checked ->
                  selected = selected.toMutableSet().apply {
                    if (checked) add(file.path) else remove(file.path)
                  }
                },
              )
              Text(file.path, modifier = Modifier.weight(1f), maxLines = 2)
              Text("+${file.insertions}", color = Color(0xFF34D399))
              Spacer(Modifier.width(8.dp))
              Text("-${file.deletions}", color = Color(0xFFFB7185))
            }
            if (index != files.lastIndex) HorizontalDivider()
          }
        }
      }
      OutlinedTextField(
        value = message,
        onValueChange = { message = it },
        label = { Text("Commit message") },
        placeholder = { Text("Leave empty to auto-generate") },
        minLines = 3,
        modifier = Modifier.fillMaxWidth(),
      )
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
          onClick = {
            viewModel.runGitAction(
              GitStackedAction.Commit,
              message,
              selectedFiles.map(VcsChangedFile::path).takeIf { it.size != files.size },
              useFeatureBranch = true,
            )
            onBack()
          },
          enabled = selectedFiles.isNotEmpty() && !busy,
          modifier = Modifier.weight(1f),
        ) { Text("New branch") }
        Button(
          onClick = {
            viewModel.runGitAction(
              GitStackedAction.Commit,
              message,
              selectedFiles.map(VcsChangedFile::path).takeIf { it.size != files.size },
            )
            onBack()
          },
          enabled = selectedFiles.isNotEmpty() && !busy,
          modifier = Modifier.weight(1f),
        ) { Text("Commit") }
      }
    }
  }
}

@Composable
fun GitBranchesScreen(
  threadId: String,
  state: GitUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  LaunchedEffect(threadId) {
    viewModel.observeGit(threadId)
    viewModel.loadGitRefs()
  }
  var branchName by remember { mutableStateOf("") }
  var baseBranch by remember(state.status?.refName) { mutableStateOf(state.status?.refName ?: "main") }
  var worktreeBranch by remember { mutableStateOf("") }
  val busy = state.operation != null

  Scaffold(topBar = { GitTopBar("Branches & worktrees", onBack) }) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      item {
        OutlinedTextField(
          value = branchName,
          onValueChange = { branchName = it },
          label = { Text("New branch") },
          placeholder = { Text("feature/native-git") },
          modifier = Modifier.fillMaxWidth(),
        )
        Button(
          onClick = {
            viewModel.createGitBranch(branchName)
            branchName = ""
          },
          enabled = branchName.isNotBlank() && !busy,
          modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        ) {
          Icon(Icons.Rounded.Add, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("Create & switch")
        }
      }
      item {
        Text("New worktree", fontWeight = FontWeight.SemiBold)
        OutlinedTextField(
          value = baseBranch,
          onValueChange = { baseBranch = it },
          label = { Text("Base branch") },
          modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        OutlinedTextField(
          value = worktreeBranch,
          onValueChange = { worktreeBranch = it },
          label = { Text("New branch") },
          modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        OutlinedButton(
          onClick = {
            viewModel.createGitWorktree(baseBranch.trim(), worktreeBranch)
            worktreeBranch = ""
          },
          enabled = baseBranch.isNotBlank() && worktreeBranch.isNotBlank() && !busy,
          modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        ) { Text("Create worktree") }
      }
      item {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text("Branches", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
          if (state.refsLoading) CircularProgressIndicator(modifier = Modifier.width(20.dp))
          IconButton(onClick = viewModel::loadGitRefs, enabled = !busy) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh branches")
          }
        }
      }
      items(state.refs, key = { it.name }) { ref ->
        val checkedOutElsewhere = ref.worktreePath != null && ref.worktreePath != state.cwd
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
          Row(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(Modifier.weight(1f)) {
              Text(ref.name, fontWeight = if (ref.current) FontWeight.Bold else FontWeight.Normal)
              Text(
                listOfNotNull(
                  "Current".takeIf { ref.current },
                  "Default".takeIf { ref.isDefault },
                  ref.worktreePath?.let { if (it == state.cwd) "This worktree" else "Another worktree" },
                ).joinToString(" · ").ifBlank { "Local branch" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
            }
            TextButton(
              onClick = { viewModel.switchGitBranch(ref.name) },
              enabled = !ref.current && !checkedOutElsewhere && !busy,
            ) { Text(if (ref.current) "Current" else "Switch") }
          }
        }
      }
      state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
    }
  }
}

@Composable
fun GitProgressOverlay(state: GitProgressUiState?, onDismiss: () -> Unit) {
  if (state == null) return
  val context = LocalContext.current
  val running = state.phase == "running"
  AlertDialog(
    onDismissRequest = { if (!running) onDismiss() },
    title = { Text(state.label) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (running) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.description?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (state.output.isNotEmpty()) {
          Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFF090909)) {
            Text(
              state.output.takeLast(4).joinToString("\n").takeLast(1_500),
              modifier = Modifier.padding(10.dp),
              fontFamily = FontFamily.Monospace,
              style = MaterialTheme.typography.bodySmall,
            )
          }
        }
      }
    },
    confirmButton = {
      when {
        state.pullRequestUrl != null -> TextButton(onClick = {
          context.openExternalUrl(state.pullRequestUrl)
          onDismiss()
        }) {
          Icon(Icons.AutoMirrored.Rounded.OpenInNew, contentDescription = null)
          Spacer(Modifier.width(6.dp))
          Text("Open PR")
        }
        !running -> TextButton(onClick = onDismiss) { Text("Done") }
      }
    },
  )
}

@Composable
private fun GitStatusCard(state: GitUiState) {
  val status = state.status
  Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(status?.refName ?: if (status?.isRepo == false) "Not a repository" else "Checking repository", fontWeight = FontWeight.Bold)
      Text(gitStatusSummary(status), color = MaterialTheme.colorScheme.onSurfaceVariant)
      status?.takeIf { it.isRepo }?.let {
        Text(
          "${if (it.hasUpstream) "Tracking upstream" else "No upstream"} · ${if (it.hasPrimaryRemote) "Remote ready" else "No primary remote"}",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      state.operation?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
    }
  }
}

@Composable
private fun GitActionCard(content: @Composable ColumnScope.() -> Unit) {
  Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
    Column(content = content)
  }
}

@Composable
private fun GitActionRow(title: String, detail: String, enabled: Boolean, onClick: () -> Unit) {
  TextButton(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
      Text(title, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
      Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun GitChangedFiles(files: List<VcsChangedFile>) {
  Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
    Column {
      files.forEachIndexed { index, file ->
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(file.path, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text("+${file.insertions}", color = Color(0xFF34D399))
          Spacer(Modifier.width(8.dp))
          Text("-${file.deletions}", color = Color(0xFFFB7185))
        }
        if (index != files.lastIndex) HorizontalDivider()
      }
    }
  }
}

@Composable
private fun DefaultBranchConfirmation(
  action: GitStackedAction,
  branch: String,
  onDismiss: () -> Unit,
  onContinue: () -> Unit,
  onFeatureBranch: () -> Unit,
) {
  val label = when (action) {
    GitStackedAction.Push -> "Push"
    GitStackedAction.CreatePr -> "Create PR"
    GitStackedAction.CommitPush -> "Commit & push"
    GitStackedAction.CommitPushPr -> "Commit, push & create PR"
    GitStackedAction.Commit -> "Commit"
  }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("$label on default branch?") },
    text = { Text("This action targets \"$branch\". Continue there or create a feature branch first.") },
    confirmButton = { Button(onClick = onFeatureBranch) { Text("Feature branch & continue") } },
    dismissButton = { TextButton(onClick = onContinue) { Text("Continue on $branch") } },
  )
}

@Composable
private fun GitTopBar(title: String, onBack: () -> Unit) {
  TopAppBar(
    title = { Text(title) },
    navigationIcon = {
      IconButton(onClick = onBack) {
        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
      }
    },
    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
  )
}

private fun Context.openExternalUrl(url: String) {
  runCatching {
    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
