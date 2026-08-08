@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.text.method.LinkMovementMethod
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.t3tools.android.protocol.ModelSelection
import com.t3tools.android.protocol.PendingApproval
import com.t3tools.android.protocol.PendingUserInput
import com.t3tools.android.protocol.Project
import com.t3tools.android.protocol.ProviderModel
import com.t3tools.android.protocol.ThreadDetail
import com.t3tools.android.protocol.ThreadSummary
import io.noties.markwon.Markwon
import java.time.Instant
import kotlinx.coroutines.flow.collectLatest

private const val ONBOARDING = "onboarding"
private const val CONNECT = "connect"
private const val HOME = "home"
private const val NEW_TASK = "new-task"
private const val SETTINGS = "settings"
private const val THREAD = "thread/{threadId}"

@Composable
fun T3NativeApp(viewModel: AppViewModel) {
  val runtime by viewModel.runtime.collectAsState()
  val dispatchState by viewModel.dispatchState.collectAsState()
  val navController = rememberNavController()
  val start = remember { if (runtime.environment == null) ONBOARDING else HOME }

  LaunchedEffect(viewModel) {
    viewModel.events.collectLatest { event ->
      when (event) {
        AppEvent.OpenHome -> navController.navigate(HOME) {
          popUpTo(ONBOARDING) { inclusive = true }
        }
        is AppEvent.OpenThread -> navController.navigate("thread/${event.threadId}")
      }
    }
  }
  LaunchedEffect(runtime.environment) {
    val route = navController.currentDestination?.route
    if (runtime.environment == null && route != ONBOARDING && route != CONNECT) {
      navController.navigate(ONBOARDING) { popUpTo(0) }
    }
  }

  NavHost(navController = navController, startDestination = start) {
    composable(ONBOARDING) {
      OnboardingScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onOpenConnect = { navController.navigate(CONNECT) },
      )
    }
    composable(CONNECT) {
      ConnectAuthScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(HOME) {
      HomeScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onNewTask = { navController.navigate(NEW_TASK) },
        onOpenThread = { navController.navigate("thread/$it") },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
        onSettings = { navController.navigate(SETTINGS) },
      )
    }
    composable(NEW_TASK) {
      NewTaskScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(SETTINGS) {
      SettingsScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
        onOpenConnect = { navController.navigate(CONNECT) },
      )
    }
    composable(
      route = THREAD,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      ThreadScreen(
        threadId = threadId,
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = {
          viewModel.clearSelectedThread()
          navController.popBackStack()
        },
      )
    }
  }
}

@Composable
private fun OnboardingScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onOpenConnect: () -> Unit,
) {
  var host by remember { mutableStateOf("") }
  var code by remember { mutableStateOf("") }
  val context = LocalContext.current
  val scanner = remember { GmsBarcodeScanning.getClient(context) }

  Scaffold(
    topBar = { T3TopBar("Add environment") },
  ) { padding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Text(
        "Connect to T3 Code",
        style = MaterialTheme.typography.titleLarge,
        fontWeight = FontWeight.Bold,
      )
      Text(
        "Pair a local environment, or continue with T3 Connect for cloud/relay hosts.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Button(
        onClick = onOpenConnect,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text("via T3 Connect")
      }
      HorizontalDivider()
      Text("Direct pairing", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      OutlinedTextField(
        value = host,
        onValueChange = { host = it },
        label = { Text("Host or pairing URL") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      OutlinedTextField(
        value = code,
        onValueChange = { code = it },
        label = { Text("Pairing code") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(
        onClick = { viewModel.pair(host, code) },
        enabled = host.isNotBlank() && dispatchState !is DispatchState.Sending,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(if (dispatchState is DispatchState.Sending) "Pairing…" else "Add environment")
      }
      OutlinedButton(
        onClick = {
          scanner.startScan()
            .addOnSuccessListener { result -> viewModel.pairQrPayload(result.rawValue.orEmpty()) }
            .addOnFailureListener(viewModel::reportFailure)
        },
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text("Scan QR code")
      }
      RuntimeError(runtime.error, dispatchState)
    }
  }
}

@Composable
private fun ConnectAuthScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val cloud = runtime.cloud
  var email by remember { mutableStateOf(cloud.pendingEmailCode.orEmpty()) }
  var code by remember { mutableStateOf("") }
  val awaitingCode = !cloud.signedIn && !cloud.pendingEmailCode.isNullOrBlank()
  val busy = dispatchState is DispatchState.Sending

  BackHandler(onBack = {
    if (awaitingCode) {
      code = ""
      viewModel.cancelCloudEmailCode()
      viewModel.clearDispatchFailure()
    } else {
      onBack()
    }
  })
  Scaffold(topBar = { BackTopBar("T3 Connect", onBack) }) { padding ->
    Column(
      Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 24.dp, vertical = 28.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      if (cloud.signedIn) {
        Text(
          "Continue to T3 Code",
          style = MaterialTheme.typography.headlineSmall,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          "Signed in as ${cloud.accountLabel ?: cloud.accountId}",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          OutlinedButton(onClick = viewModel::refreshCloudEnvironments) { Text("Refresh") }
          OutlinedButton(
            onClick = viewModel::signOutCloud,
            enabled = !busy,
          ) { Text("Sign out") }
        }
        if (cloud.relayEnvironments.isEmpty()) {
          Text(
            cloud.lastError ?: "No linked relay environments for this account.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        } else {
          cloud.relayEnvironments.forEach { environment ->
            val already = runtime.environments.any { it.environmentId == environment.environmentId }
            OutlinedButton(
              onClick = { viewModel.connectRelay(environment.environmentId) },
              enabled = !already && !busy,
              modifier = Modifier.fillMaxWidth(),
            ) {
              Text(
                if (already) "${environment.label} · saved"
                else "Connect ${environment.label.ifBlank { environment.environmentId }}",
              )
            }
          }
        }
      } else {
        Text(
          "Continue to T3 Code",
          style = MaterialTheme.typography.headlineSmall,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          if (awaitingCode) {
            "Enter the code we emailed to ${cloud.pendingEmailCode}"
          } else {
            "Welcome! Sign in with the email code T3 Connect uses on mobile."
          },
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        if (!awaitingCode) {
          OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            placeholder = { Text("Enter your email") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          Button(
            onClick = {
              viewModel.clearDispatchFailure()
              viewModel.startCloudEmailCode(email)
            },
            enabled = email.isNotBlank() && !busy,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(if (busy) "Sending code…" else "Continue")
          }
        } else {
          OutlinedTextField(
            value = code,
            onValueChange = { value -> code = value.filter(Char::isDigit).take(12) },
            placeholder = { Text("Email code") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          Button(
            onClick = { viewModel.verifyCloudEmailCode(code) },
            enabled = code.isNotBlank() && !busy,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(if (busy) "Verifying…" else "Verify code")
          }
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            TextButton(
              onClick = {
                viewModel.clearDispatchFailure()
                viewModel.resendCloudEmailCode(cloud.pendingEmailCode.orEmpty())
              },
              enabled = !busy,
              modifier = Modifier.weight(1f),
            ) { Text("Resend code") }
            TextButton(
              onClick = {
                code = ""
                email = cloud.pendingEmailCode.orEmpty()
                viewModel.cancelCloudEmailCode()
                viewModel.clearDispatchFailure()
              },
              enabled = !busy,
              modifier = Modifier.weight(1f),
            ) { Text("Change email") }
          }
        }
        Text("or", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          OAuthButton(
            label = "Apple",
            enabled = !busy,
            modifier = Modifier.weight(1f),
            onClick = { viewModel.signInCloudOAuth(CloudOAuthProvider.Apple) },
          )
          OAuthButton(
            label = "GitHub",
            enabled = !busy,
            modifier = Modifier.weight(1f),
            onClick = { viewModel.signInCloudOAuth(CloudOAuthProvider.GitHub) },
          )
        }
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          OAuthButton(
            label = "Google",
            enabled = !busy,
            modifier = Modifier.weight(1f),
            onClick = { viewModel.signInCloudOAuth(CloudOAuthProvider.Google) },
          )
          OAuthButton(
            label = "Microsoft",
            enabled = !busy,
            modifier = Modifier.weight(1f),
            onClick = { viewModel.signInCloudOAuth(CloudOAuthProvider.Microsoft) },
          )
        }
        Spacer(Modifier.height(12.dp))
        Text(
          "Secured by Clerk · email code (same as official mobile)",
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      AuthError(dispatchState, onDismiss = viewModel::clearDispatchFailure)
    }
  }
}

@Composable
private fun OAuthButton(
  label: String,
  enabled: Boolean,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  OutlinedButton(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.height(52.dp),
  ) {
    Text(label)
  }
}

@Composable
private fun HomeScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onNewTask: () -> Unit,
  onOpenThread: (String) -> Unit,
  onAddEnvironment: () -> Unit,
  onSettings: () -> Unit,
) {
  var search by remember { mutableStateOf("") }
  var showEnvironment by remember { mutableStateOf(false) }
  var showArchived by remember { mutableStateOf(false) }
  val visibleThreads = runtime.shell.threads.values
    .filter { (it.archivedAt != null) == showArchived && it.title.contains(search, ignoreCase = true) }
    .sortedWith(
      compareByDescending<ThreadSummary> { it.pinnedAt != null }
        .thenBy { it.pinOrderKey ?: "~" }
        .thenByDescending(ThreadSummary::updatedAt),
    )
  val groups = if (runtime.settings.groupThreadsByProject) {
    visibleThreads.groupBy(ThreadSummary::projectId)
  } else {
    mapOf("all" to visibleThreads)
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text("T3 Code Native", fontWeight = FontWeight.Bold)
            Text(runtime.statusLabel(), style = MaterialTheme.typography.labelSmall)
          }
        },
        actions = {
          TextButton(onClick = { showEnvironment = true }) { Text("Environments") }
          TextButton(onClick = onSettings) { Text("Settings") }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
    floatingActionButton = {
      ExtendedFloatingActionButton(onClick = onNewTask) { Text("New task") }
    },
  ) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      if (runtime.connectionPhase == ConnectionPhase.Connecting ||
        runtime.shellSyncPhase == SyncPhase.Synchronizing) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
      }
      OutlinedTextField(
        value = search,
        onValueChange = { search = it },
        label = { Text("Search threads") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(16.dp),
      )
      Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        OutlinedButton(onClick = { showArchived = false }) { Text("Active") }
        OutlinedButton(onClick = { showArchived = true }) { Text("Archived") }
      }
      RuntimeError(runtime.error, dispatchState) {
        OutlinedButton(onClick = viewModel::retryConnection) { Text("Retry connection") }
      }
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        if (runtime.pendingTasks.isNotEmpty()) {
          item(key = "pending-title") {
            Text(
              "Pending tasks",
              modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
              style = MaterialTheme.typography.labelLarge,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          items(runtime.pendingTasks, key = PendingTask::messageId) { task ->
            PendingTaskRow(task, viewModel)
          }
        }
        groups.forEach { (projectId, threads) ->
          val project = runtime.shell.projects[projectId]
          if (runtime.settings.groupThreadsByProject) item(key = "project:$projectId") {
            Text(
              project?.title ?: "Project",
              modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
              style = MaterialTheme.typography.labelLarge,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          items(threads, key = ThreadSummary::id) { thread ->
            ThreadRow(thread, runtime.settings.compactThreadRows) { onOpenThread(thread.id) }
          }
        }
        if (visibleThreads.isEmpty() && runtime.pendingTasks.isEmpty()) {
          item { Text("No matching threads.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
      }
    }
  }

  if (showEnvironment) {
    EnvironmentDialog(
      runtime = runtime,
      viewModel = viewModel,
      onAdd = {
        showEnvironment = false
        onAddEnvironment()
      },
      dismiss = { showEnvironment = false },
    )
  }
}

@Composable
private fun ThreadRow(thread: ThreadSummary, compact: Boolean, onClick: () -> Unit) {
  Card(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
  ) {
    Column(Modifier.padding(if (compact) 10.dp else 16.dp)) {
      Text((if (thread.pinnedAt != null) "Pinned · " else "") + thread.title, fontWeight = FontWeight.SemiBold)
      if (!compact) Spacer(Modifier.height(4.dp))
      Text(
        thread.threadStatus(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun PendingTaskRow(task: PendingTask, viewModel: AppViewModel) {
  var editing by remember(task.messageId) { mutableStateOf(false) }
  var text by remember(task.messageId, task.text) { mutableStateOf(task.text) }
  Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF111827))) {
    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(task.text, maxLines = 3, fontWeight = FontWeight.SemiBold)
      Text(
        when (task.status) {
          PendingTaskStatus.Queued -> if (task.error == null) "Queued" else "Waiting to retry · ${task.error}"
          PendingTaskStatus.Sending -> "Sending"
          PendingTaskStatus.Failed -> "Needs attention · ${task.error.orEmpty()}"
        },
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (task.status != PendingTaskStatus.Sending) {
          TextButton(onClick = { editing = true }) { Text("Edit") }
          TextButton(onClick = { viewModel.removePending(task.messageId) }) { Text("Delete") }
        }
        if (task.status == PendingTaskStatus.Failed) {
          TextButton(onClick = { viewModel.retryPending(task.messageId) }) { Text("Retry") }
        }
      }
    }
  }
  if (editing) {
    AlertDialog(
      onDismissRequest = { editing = false },
      title = { Text("Edit pending task") },
      text = { OutlinedTextField(text, { text = it }, minLines = 3) },
      confirmButton = {
        Button(
          onClick = {
            viewModel.editPending(task.messageId, text)
            editing = false
          },
          enabled = text.isNotBlank(),
        ) { Text("Save") }
      },
      dismissButton = { TextButton(onClick = { editing = false }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun EnvironmentDialog(
  runtime: OnlineChatState,
  viewModel: AppViewModel,
  onAdd: () -> Unit,
  dismiss: () -> Unit,
) {
  val environment = runtime.environment ?: return
  var label by remember(environment) { mutableStateOf(environment.label) }
  var url by remember(environment) { mutableStateOf(environment.httpBaseUrl) }
  AlertDialog(
    onDismissRequest = dismiss,
    title = { Text("Environment") },
    text = {
      Column(
        Modifier.verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        runtime.environments.forEach { item ->
          val status = runtime.environmentStatuses[item.environmentId]
          OutlinedButton(
            onClick = { viewModel.selectEnvironment(item.environmentId) },
            modifier = Modifier.fillMaxWidth(),
          ) {
            Column(Modifier.fillMaxWidth()) {
              Text(if (item.environmentId == environment.environmentId) "${item.label} · selected" else item.label)
              Text(
                status?.connectionPhase?.name ?: "Loading",
                style = MaterialTheme.typography.labelSmall,
              )
            }
          }
        }
        OutlinedButton(onClick = onAdd, modifier = Modifier.fillMaxWidth()) { Text("Add environment") }
        HorizontalDivider()
        OutlinedTextField(label, { label = it }, label = { Text("Label") })
        OutlinedTextField(
          url,
          { url = it },
          label = { Text("URL") },
          enabled = environment.kind == EnvironmentKind.Bearer,
        )
        OutlinedButton(onClick = {
          viewModel.forgetEnvironment()
          dismiss()
        }) { Text("Forget environment") }
      }
    },
    confirmButton = {
      Button(onClick = {
        viewModel.updateEnvironment(label, url)
        dismiss()
      }, enabled = environment.kind == EnvironmentKind.Bearer) { Text("Save") }
    },
    dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
  )
}

@Composable
private fun SettingsScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onOpenConnect: () -> Unit,
) {
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Settings", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Text("Appearance", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      Text("AMOLED dark", color = MaterialTheme.colorScheme.onSurfaceVariant)
      ToggleRow("Compact thread rows", runtime.settings.compactThreadRows) {
        viewModel.updateSettings(runtime.settings.copy(compactThreadRows = it))
      }
      HorizontalDivider()
      Text("Grouping", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      ToggleRow("Group threads by project", runtime.settings.groupThreadsByProject) {
        viewModel.updateSettings(runtime.settings.copy(groupThreadsByProject = it))
      }
      HorizontalDivider()
      Text("Storage", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      Text(
        "${runtime.environments.size} environments · ${runtime.pendingTasks.size} pending tasks",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      OutlinedButton(onClick = viewModel::clearCache) { Text("Clear cached snapshots") }
      HorizontalDivider()
      Text("T3 Connect", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      if (runtime.cloud.signedIn) {
        Text(
          "Signed in as ${runtime.cloud.accountLabel ?: runtime.cloud.accountId}",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) {
          Text("Manage T3 Connect")
        }
      } else {
        Text(
          "Sign in to discover and open relay environments.",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) {
          Text("via T3 Connect")
        }
      }
      HorizontalDivider()
      Text("Beta", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      ToggleRow("Native beta features", runtime.settings.betaFeatures) {
        viewModel.updateSettings(runtime.settings.copy(betaFeatures = it))
      }
      Text("Open-source licenses and privacy information ship with T3 Code.", color = MaterialTheme.colorScheme.onSurfaceVariant)
      RuntimeError(runtime.error, dispatchState)
    }
  }
}

@Composable
private fun NewTaskScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val environmentId = runtime.environment?.environmentId ?: return
  val draftRevision by viewModel.draftRevision.collectAsState()
  val draftKey = remember(environmentId) { DraftStore.newTaskKey(environmentId) }
  var draft by remember(draftKey) { mutableStateOf(viewModel.loadDraft(draftKey)) }
  LaunchedEffect(draftRevision, draftKey) { draft = viewModel.loadDraft(draftKey) }
  val projects = runtime.shell.projects.values.sortedBy(Project::title)
  var projectId by remember(projects) { mutableStateOf(projects.firstOrNull()?.id.orEmpty()) }
  var worktree by remember { mutableStateOf(false) }
  var baseBranch by remember { mutableStateOf("main") }
  var branch by remember { mutableStateOf("") }
  var runSetup by remember { mutableStateOf(false) }

  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("New task", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      SelectionField(
        label = "Project",
        selected = projects.firstOrNull { it.id == projectId }?.title ?: "Choose project",
        options = projects.map { it.id to it.title },
        onSelect = { projectId = it },
      )
      DraftSelectors(runtime.providerModels, draft) {
        draft = it.also { next -> viewModel.saveDraft(draftKey, next) }
      }
      ToggleRow("Create worktree", worktree) { worktree = it }
      if (worktree) {
        OutlinedTextField(baseBranch, { baseBranch = it }, label = { Text("Base branch") })
        OutlinedTextField(branch, { branch = it }, label = { Text("Branch (optional)") })
        ToggleRow("Run setup script", runSetup) { runSetup = it }
      }
      OutlinedTextField(
        value = draft.text,
        onValueChange = {
          draft = draft.copy(text = it)
          viewModel.saveDraft(draftKey, draft)
        },
        label = { Text("Task") },
        minLines = 5,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(
        onClick = {
          viewModel.createTask(
            projectId = projectId,
            draftKey = draftKey,
            draft = draft,
            worktree = WorktreeChoice(worktree, baseBranch, branch, runSetup),
          )
        },
        enabled = draft.text.isNotBlank() && projectId.isNotBlank() &&
          runtime.shell.sequence >= 0 && dispatchState !is DispatchState.Sending,
        modifier = Modifier.fillMaxWidth(),
      ) { Text(if (dispatchState is DispatchState.Sending) "Creating…" else "Create task") }
      DispatchFailure(dispatchState, viewModel::retryDispatch)
    }
  }
}

@Composable
private fun ThreadScreen(
  threadId: String,
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  val detail = runtime.thread.detail
  val focusManager = LocalFocusManager.current
  LaunchedEffect(threadId) {
    focusManager.clearFocus(force = true)
    viewModel.selectThread(threadId)
  }
  LaunchedEffect(threadId, detail != null) {
    if (detail != null) focusManager.clearFocus(force = true)
  }
  BackHandler(onBack = onBack)
  val environmentId = runtime.environment?.environmentId ?: return
  val draftRevision by viewModel.draftRevision.collectAsState()
  val draftKey = remember(environmentId, threadId) { DraftStore.threadKey(environmentId, threadId) }
  var draft by remember(draftKey) { mutableStateOf(viewModel.loadDraft(draftKey)) }
  LaunchedEffect(draftRevision, draftKey) { draft = viewModel.loadDraft(draftKey) }

  Scaffold(topBar = { BackTopBar(detail?.summary?.title ?: "Thread", onBack) }) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      if (runtime.threadSyncPhase == SyncPhase.Synchronizing) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
      }
      if (detail == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(runtime.error ?: "Opening thread…")
        }
      } else {
        ThreadActionBar(detail.summary, runtime.threadCapabilities, viewModel)
        ThreadFeed(
          detail = detail,
          modifier = Modifier.weight(1f),
        )
        ThreadRequests(detail, viewModel)
        DispatchFailure(dispatchState, viewModel::retryDispatch)
        DraftSelectors(runtime.providerModels, draft) {
          draft = it.also { next -> viewModel.saveDraft(draftKey, next) }
        }
        Composer(
          detail = detail,
          draft = draft,
          enabled = runtime.shell.sequence >= 0,
          sending = dispatchState is DispatchState.Sending,
          onDraft = {
            draft = draft.copy(text = it)
            viewModel.saveDraft(draftKey, draft)
          },
          onSend = { viewModel.sendThreadTurn(threadId, draftKey, draft) },
          onInterrupt = { viewModel.interrupt(threadId) },
          onStop = { viewModel.stop(threadId) },
        )
      }
    }
  }
}

@Composable
private fun ThreadActionBar(
  thread: ThreadSummary,
  capabilities: ThreadCapabilities,
  viewModel: AppViewModel,
) {
  var confirmDelete by remember(thread.id) { mutableStateOf(false) }
  LazyRow(
    modifier = Modifier.fillMaxWidth(),
    contentPadding = PaddingValues(horizontal = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    item {
      TextButton(
        onClick = {
          viewModel.threadAction(
            if (thread.archivedAt == null) "thread.archive" else "thread.unarchive",
            thread.id,
          )
        },
      ) { Text(if (thread.archivedAt == null) "Archive" else "Restore") }
    }
    if (capabilities.pinning) item {
      TextButton(
        onClick = {
          viewModel.threadAction(
            if (thread.pinnedAt == null) "thread.pin" else "thread.unpin",
            thread.id,
            if (thread.pinnedAt == null && capabilities.pinReorder) System.currentTimeMillis().toString() else null,
          )
        },
      ) { Text(if (thread.pinnedAt == null) "Pin" else "Unpin") }
    }
    if (capabilities.settlement) item {
      TextButton(
        onClick = {
          viewModel.threadAction(
            if (thread.settledAt == null) "thread.settle" else "thread.unsettle",
            thread.id,
          )
        },
      ) { Text(if (thread.settledAt == null) "Settle" else "Activate") }
    }
    if (capabilities.snooze) item {
      TextButton(
        onClick = {
          viewModel.threadAction(
            if (thread.snoozedUntil == null) "thread.snooze" else "thread.unsnooze",
            thread.id,
            if (thread.snoozedUntil == null) Instant.now().plusSeconds(3_600).toString() else null,
          )
        },
      ) { Text(if (thread.snoozedUntil == null) "Snooze 1h" else "Unsnooze") }
    }
    item { TextButton(onClick = { confirmDelete = true }) { Text("Delete") } }
  }
  if (confirmDelete) {
    AlertDialog(
      onDismissRequest = { confirmDelete = false },
      title = { Text("Delete thread?") },
      text = { Text("This permanently deletes the thread from the environment.") },
      confirmButton = {
        Button(onClick = {
          viewModel.threadAction("thread.delete", thread.id)
          confirmDelete = false
        }) { Text("Delete") }
      },
      dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun ThreadFeed(detail: ThreadDetail, modifier: Modifier = Modifier) {
  val state = rememberLazyListState()
  val entries = detail.messages
  LaunchedEffect(entries.size, entries.lastOrNull()?.text?.length) {
    val lastVisible = state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
    if (entries.isNotEmpty() && (lastVisible >= entries.lastIndex - 1 || lastVisible == -1)) {
      state.scrollToItem(entries.lastIndex)
    }
  }
  LazyColumn(
    state = state,
    modifier = modifier.fillMaxWidth(),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    items(entries, key = { it.id }) { message ->
      if (message.role == "assistant") {
        MarkdownMessage(message.text)
      } else {
        Surface(
          shape = RoundedCornerShape(16.dp),
          color = if (message.role == "user") Color(0xFF172554) else MaterialTheme.colorScheme.surface,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Text(message.text, modifier = Modifier.padding(14.dp))
        }
      }
    }
    if (detail.activities.isNotEmpty()) {
      item(key = "work-log") {
        Column(
          Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp)).padding(12.dp),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Text("Work log", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
          detail.activities.takeLast(3).forEach { activity ->
            Text(activity.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
    }
  }
}

@Composable
private fun MarkdownMessage(markdown: String) {
  val context = LocalContext.current
  val markwon = remember(context) { Markwon.create(context) }
  AndroidView(
    factory = {
      TextView(it).apply {
        setTextColor(android.graphics.Color.rgb(244, 244, 245))
        setTextIsSelectable(true)
        movementMethod = LinkMovementMethod.getInstance()
        textSize = 15f
        setPadding(4, 6, 4, 6)
      }
    },
    update = { markwon.setMarkdown(it, markdown) },
    modifier = Modifier.fillMaxWidth(),
  )
}

@Composable
private fun ThreadRequests(detail: ThreadDetail, viewModel: AppViewModel) {
  Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    detail.approvals.forEach { approval -> ApprovalCard(detail.summary.id, approval, viewModel) }
    detail.userInputs.forEach { input -> UserInputCard(detail.summary.id, input, viewModel) }
  }
}

@Composable
private fun ApprovalCard(threadId: String, approval: PendingApproval, viewModel: AppViewModel) {
  Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF291804))) {
    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text("Approval required", fontWeight = FontWeight.Bold)
      Text(approval.detail ?: approval.requestKind)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { viewModel.respondApproval(threadId, approval.requestId, "accept") }) { Text("Allow") }
        OutlinedButton(onClick = { viewModel.respondApproval(threadId, approval.requestId, "acceptForSession") }) { Text("Allow session") }
        OutlinedButton(onClick = { viewModel.respondApproval(threadId, approval.requestId, "decline") }) { Text("Decline") }
      }
    }
  }
}

@Composable
private fun UserInputCard(threadId: String, input: PendingUserInput, viewModel: AppViewModel) {
  val answers = remember(input.requestId) { mutableStateMapOf<String, String>() }
  Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF071A13))) {
    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("Input required", fontWeight = FontWeight.Bold)
      input.questions.forEach { question ->
        Text(question.header, style = MaterialTheme.typography.labelLarge)
        Text(question.question)
        question.options.forEach { option ->
          OutlinedButton(
            onClick = { answers[question.id] = option.label },
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(if (answers[question.id] == option.label) "✓ ${option.label}" else option.label)
          }
        }
        OutlinedTextField(
          value = answers[question.id].orEmpty(),
          onValueChange = { answers[question.id] = it },
          label = { Text("Answer") },
          modifier = Modifier.fillMaxWidth(),
        )
      }
      Button(
        onClick = { viewModel.respondUserInput(threadId, input.requestId, answers.toMap()) },
        enabled = input.questions.all { answers[it.id]?.isNotBlank() == true },
      ) { Text("Submit answers") }
    }
  }
}

@Composable
private fun Composer(
  detail: ThreadDetail,
  draft: ComposerDraft,
  enabled: Boolean,
  sending: Boolean,
  onDraft: (String) -> Unit,
  onSend: () -> Unit,
  onInterrupt: () -> Unit,
  onStop: () -> Unit,
) {
  Column(
    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    OutlinedTextField(
      value = draft.text,
      onValueChange = onDraft,
      label = { Text(if (enabled) "Message" else "Waiting for synchronization") },
      minLines = 2,
      maxLines = 6,
      modifier = Modifier.fillMaxWidth(),
    )
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      val session = detail.summary.session
      val active = session?.status in setOf("starting", "running")
      Button(
        onClick = onSend,
        enabled = enabled && draft.text.isNotBlank() && !sending,
        modifier = Modifier.weight(1f),
      ) { Text(if (sending) "Sending…" else "Send") }
      if (active) OutlinedButton(onClick = onInterrupt) { Text("Interrupt") }
      if (session != null && session.status != "stopped") {
        OutlinedButton(onClick = onStop) { Text("Stop") }
      }
    }
  }
}

@Composable
private fun DraftSelectors(
  models: List<ProviderModel>,
  draft: ComposerDraft,
  onDraft: (ComposerDraft) -> Unit,
) {
  val selectedModel = models.firstOrNull {
    it.instanceId == draft.modelInstanceId && it.model == draft.model
  } ?: models.firstOrNull { it.isDefault } ?: models.firstOrNull()
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    SelectionField(
      label = "Model",
      selected = selectedModel?.modelLabel ?: "Server default",
      options = models.map { "${it.instanceId}:${it.model}" to it.modelLabel },
      onSelect = { key ->
        val model = models.first { "${it.instanceId}:${it.model}" == key }
        onDraft(draft.copy(modelInstanceId = model.instanceId, model = model.model))
      },
      modifier = Modifier.weight(1f),
    )
    SelectionField(
      label = "Access",
      selected = when (draft.runtimeMode) {
        "approval-required" -> "Ask"
        "auto-accept-edits" -> "Auto edits"
        "auto" -> "Auto"
        else -> "Full"
      },
      options = listOf(
        "approval-required" to "Ask",
        "auto-accept-edits" to "Auto edits",
        "auto" to "Auto",
        "full-access" to "Full",
      ),
      onSelect = { onDraft(draft.copy(runtimeMode = it)) },
      modifier = Modifier.weight(1f),
    )
    SelectionField(
      label = "Mode",
      selected = if (draft.interactionMode == "plan") "Plan" else "Default",
      options = listOf("default" to "Default", "plan" to "Plan"),
      onSelect = { onDraft(draft.copy(interactionMode = it)) },
      modifier = Modifier.weight(1f),
    )
  }
}

@Composable
private fun SelectionField(
  label: String,
  selected: String,
  options: List<Pair<String, String>>,
  onSelect: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  var expanded by remember { mutableStateOf(false) }
  Box(modifier) {
    OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
      Column(horizontalAlignment = Alignment.Start, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelSmall)
        Text(selected, maxLines = 1)
      }
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      options.forEach { (key, title) ->
        DropdownMenuItem(
          text = { Text(title) },
          onClick = {
            expanded = false
            onSelect(key)
          },
        )
      }
    }
  }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
  Row(
    Modifier.fillMaxWidth().toggleable(checked, onValueChange = onChecked).padding(vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Checkbox(checked, onCheckedChange = null)
    Spacer(Modifier.width(8.dp))
    Text(label)
  }
}

@Composable
private fun RuntimeError(
  runtimeError: String?,
  dispatchState: DispatchState,
  action: (@Composable () -> Unit)? = null,
) {
  // Dispatch failures are shown by DispatchFailure/AuthError only — avoid double banners.
  if (dispatchState is DispatchState.Failed) return
  val message = runtimeError ?: return
  Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF2A0B0B))) {
    Column(Modifier.fillMaxWidth().padding(12.dp)) {
      Text(message, color = MaterialTheme.colorScheme.error)
      action?.invoke()
    }
  }
}

@Composable
private fun AuthError(state: DispatchState, onDismiss: () -> Unit) {
  val failure = state as? DispatchState.Failed ?: return
  Card(
    colors = CardDefaults.cardColors(containerColor = Color(0xFF2A0B0B)),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(failure.message, color = MaterialTheme.colorScheme.error)
      TextButton(onClick = onDismiss) { Text("Dismiss") }
    }
  }
}

@Composable
private fun DispatchFailure(state: DispatchState, retry: () -> Unit) {
  val failure = state as? DispatchState.Failed ?: return
  Card(
    colors = CardDefaults.cardColors(containerColor = Color(0xFF2A0B0B)),
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
  ) {
    Row(
      Modifier.fillMaxWidth().padding(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(failure.message, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
      TextButton(onClick = retry) { Text("Retry") }
    }
  }
}

@Composable
private fun T3TopBar(title: String) {
  TopAppBar(
    title = { Text(title, fontWeight = FontWeight.Bold) },
    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
  )
}

@Composable
private fun BackTopBar(title: String, onBack: () -> Unit) {
  TopAppBar(
    title = { Text(title, maxLines = 1, fontWeight = FontWeight.Bold) },
    navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
  )
}

private fun OnlineChatState.statusLabel() = when {
  connectionPhase == ConnectionPhase.Connecting -> "Connecting"
  connectionPhase == ConnectionPhase.Backoff -> "Reconnecting"
  connectionPhase == ConnectionPhase.Blocked -> "Needs attention"
  connectionPhase == ConnectionPhase.Offline -> "Offline · cached"
  connectionPhase == ConnectionPhase.Error -> "Connection failed"
  shellSyncPhase == SyncPhase.Synchronizing -> "Synchronizing"
  shellSyncPhase == SyncPhase.Error -> "Sync failed"
  shellSyncPhase == SyncPhase.Synchronized -> environment?.label ?: "Connected"
  else -> "Offline"
}

private fun ThreadSummary.threadStatus() = when {
  hasPendingApprovals -> "Approval required"
  hasPendingUserInput -> "Input required"
  session?.status == "running" -> "Working"
  latestTurn?.state == "error" -> "Failed"
  else -> branch ?: "Ready"
}
