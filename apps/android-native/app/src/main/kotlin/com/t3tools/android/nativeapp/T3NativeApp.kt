@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.content.ClipboardManager
import android.os.Build
import android.net.Uri
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Clear
import androidx.compose.material.icons.rounded.CreateNewFolder
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.FilterList
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.RateReview
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.t3tools.android.protocol.ChatImageAttachment
import com.t3tools.android.protocol.DEFAULT_TERMINAL_ID
import com.t3tools.android.protocol.nextTerminalId
import io.noties.markwon.Markwon
import coil.compose.AsyncImage
import java.io.File
import kotlinx.coroutines.flow.collectLatest

private const val ONBOARDING = "onboarding"
private const val CONNECT = "connect"
private const val HOME = "home"
private const val NEW_TASK = "new-task"
private const val NEW_TASK_ROUTE = "new-task?projectId={projectId}"
private const val ADD_PROJECT = "add-project"
private const val SETTINGS = "settings"
private const val ARCHIVED_THREADS = "settings/archived"
private const val THREAD = "thread/{threadId}"
private const val THREAD_FILES = "thread/{threadId}/files"
private const val THREAD_GIT = "thread/{threadId}/git"
private const val THREAD_GIT_COMMIT = "thread/{threadId}/git/commit"
private const val THREAD_GIT_BRANCHES = "thread/{threadId}/git/branches"
private const val THREAD_TERMINAL = "thread/{threadId}/terminal/{terminalId}"
private const val THREAD_REVIEW = "thread/{threadId}/review"

@Composable
fun T3NativeApp(viewModel: AppViewModel) {
  val runtime by viewModel.runtime.collectAsState()
  val dispatchState by viewModel.dispatchState.collectAsState()
  val gitState by viewModel.gitState.collectAsState()
  val navController = rememberNavController()
  val start = remember { if (runtime.environment == null) ONBOARDING else HOME }

  LaunchedEffect(viewModel) {
    viewModel.events.collectLatest { event ->
      when (event) {
        AppEvent.OpenHome -> navController.navigate(HOME) {
          popUpTo(ONBOARDING) { inclusive = true }
        }
        is AppEvent.OpenNewTask -> navController.navigate(
          "$NEW_TASK?projectId=${Uri.encode(event.projectId)}",
        ) {
          popUpTo(ADD_PROJECT) { inclusive = true }
          launchSingleTop = true
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

  Box(Modifier.fillMaxSize()) {
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
        onAddProject = { navController.navigate(ADD_PROJECT) },
        onOpenThread = { navController.navigate("thread/$it") },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
        onSettings = { navController.navigate(SETTINGS) },
      )
    }
    composable(
      route = NEW_TASK_ROUTE,
      arguments = listOf(
        navArgument("projectId") {
          type = NavType.StringType
          nullable = true
          defaultValue = null
        },
      ),
    ) { entry ->
      NewTaskScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        initialProjectId = entry.arguments?.getString("projectId"),
        onBack = { navController.popBackStack() },
        onAddProject = { navController.navigate(ADD_PROJECT) },
      )
    }
    composable(ADD_PROJECT) {
      AddProjectScreen(
        runtime = runtime,
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
        onAddEnvironment = { navController.navigate(ONBOARDING) },
        onAddProject = { navController.navigate(ADD_PROJECT) },
        onOpenArchivedThreads = { navController.navigate(ARCHIVED_THREADS) },
      )
    }
    composable(ARCHIVED_THREADS) {
      ArchivedThreadsScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
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
        gitState = gitState,
        onBack = {
          viewModel.clearSelectedThread()
          navController.popBackStack()
        },
        onFiles = { navController.navigate("thread/$threadId/files") },
        onGit = { navController.navigate("thread/$threadId/git") },
        onReview = { navController.navigate("thread/$threadId/review") },
        onTerminal = {
          navController.navigate("thread/$threadId/terminal/$DEFAULT_TERMINAL_ID")
        },
      )
    }
    composable(
      route = THREAD_FILES,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      WorkspaceFilesScreen(
        threadId = threadId,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(
      route = THREAD_GIT,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      GitOverviewScreen(
        threadId = threadId,
        state = gitState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
        onCommit = { navController.navigate("thread/$threadId/git/commit") },
        onBranches = { navController.navigate("thread/$threadId/git/branches") },
        onReview = { navController.navigate("thread/$threadId/review") },
      )
    }
    composable(
      route = THREAD_GIT_COMMIT,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      GitCommitScreen(
        threadId = requireNotNull(entry.arguments?.getString("threadId")),
        state = gitState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(
      route = THREAD_GIT_BRANCHES,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      GitBranchesScreen(
        threadId = requireNotNull(entry.arguments?.getString("threadId")),
        state = gitState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(
      route = THREAD_REVIEW,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      ReviewScreen(
        threadId = requireNotNull(entry.arguments?.getString("threadId")),
        connectionPhase = runtime.connectionPhase,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(
      route = THREAD_TERMINAL,
      arguments = listOf(
        navArgument("threadId") { type = NavType.StringType },
        navArgument("terminalId") { type = NavType.StringType },
      ),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      val terminalId = requireNotNull(entry.arguments?.getString("terminalId"))
      val environment = runtime.environment
      val terminalState by viewModel.terminalState.collectAsState()

      fun replaceTerminal(nextTerminalId: String) {
        navController.navigate(
          "thread/$threadId/terminal/${Uri.encode(nextTerminalId)}",
        ) {
          popUpTo(entry.destination.id) { inclusive = true }
        }
      }

      LaunchedEffect(threadId, terminalId) {
        viewModel.terminalEvents.collectLatest { event ->
          if (event !is TerminalUiEvent.SessionEnded || event.threadId != threadId ||
            event.terminalId != terminalId
          ) return@collectLatest
          val fallback = previousLiveTerminalId(viewModel.terminalState.value.sessions, terminalId)
          if (fallback == null) navController.popBackStack() else replaceTerminal(fallback)
        }
      }

      if (environment != null) {
        TerminalScreen(
          threadId = threadId,
          terminalId = terminalId,
          environmentId = environment.environmentId,
          environmentLabel = environment.label,
          connectionPhase = runtime.connectionPhase,
          fontSize = runtime.settings.terminalFontSize,
          viewModel = viewModel,
          onBack = { navController.popBackStack() },
          onSelectTerminal = ::replaceTerminal,
          onNewTerminal = {
            replaceTerminal(nextTerminalId(terminalState.sessions.map { it.terminalId }))
          },
        )
      }
    }
    }
    GitProgressOverlay(gitState.progress, viewModel::dismissGitProgress)
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
  onAddProject: () -> Unit,
  onOpenThread: (String) -> Unit,
  onAddEnvironment: () -> Unit,
  onSettings: () -> Unit,
) {
  var search by remember { mutableStateOf("") }
  var filterStatus by remember { mutableStateOf(ThreadFilterStatus.All) }
  var filterProjectId by remember { mutableStateOf<String?>(null) }
  var showFilterSheet by remember { mutableStateOf(false) }
  var snoozedExpanded by remember { mutableStateOf(false) }
  var settledExpanded by remember { mutableStateOf(true) }
  var settledLimit by remember { mutableIntStateOf(THREAD_LIST_V2_SETTLED_INITIAL) }
  val caps = runtime.threadCapabilities

  val rawThreads = remember(runtime.shell.threads, filterProjectId) {
    if (filterProjectId == null) {
      runtime.shell.threads.values
    } else {
      runtime.shell.threads.values.filter { it.projectId == filterProjectId }
    }
  }

  val layout = remember(
    rawThreads,
    search,
    snoozedExpanded,
    settledExpanded,
    settledLimit,
    filterStatus,
    caps.settlement,
    caps.snooze,
  ) {
    buildThreadListV2Layout(
      threads = rawThreads,
      settlementSupported = caps.settlement,
      snoozeSupported = caps.snooze,
      search = search,
      snoozedShelfExpanded = snoozedExpanded || filterStatus == ThreadFilterStatus.Snoozed,
      settledShelfExpanded = settledExpanded || filterStatus == ThreadFilterStatus.Settled,
      settledLimit = settledLimit,
    )
  }

  val displayItems = remember(layout.items, filterStatus) {
    filterThreadListV2Items(layout.items, filterStatus)
  }
  val activeItems = displayItems.filter { it.variant == ThreadListV2Variant.Card }
  val snoozedItems = displayItems.filter(ThreadListV2Item::snoozed)
  val settledItems = displayItems.filter { !it.snoozed && it.variant == ThreadListV2Variant.Slim }
  val showSnoozedSection = filterStatus in listOf(ThreadFilterStatus.All, ThreadFilterStatus.Snoozed) &&
    layout.snoozedCount > 0
  val showSettledSection = filterStatus in listOf(ThreadFilterStatus.All, ThreadFilterStatus.Settled) &&
    layout.settledCount > 0

  val isFiltered = filterStatus != ThreadFilterStatus.All || filterProjectId != null

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text("T3 Code", fontWeight = FontWeight.Bold)
            Text(runtime.statusLabel(), style = MaterialTheme.typography.labelSmall)
          }
        },
        actions = {
          IconButton(onClick = onAddProject) {
            Icon(
              imageVector = Icons.Rounded.CreateNewFolder,
              contentDescription = "Add project",
              tint = Color.White,
            )
          }
          IconButton(onClick = { showFilterSheet = true }) {
            Icon(
              imageVector = if (isFiltered) Icons.Rounded.FilterAlt else Icons.Rounded.FilterList,
              contentDescription = "Filter threads",
              tint = if (isFiltered) MaterialTheme.colorScheme.primary else Color.White,
            )
          }
          IconButton(onClick = onSettings) {
            Icon(
              imageVector = Icons.Rounded.Settings,
              contentDescription = "Settings",
              tint = Color.White,
            )
          }
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
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
      )

      if (isFiltered) {
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 2.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          if (filterStatus != ThreadFilterStatus.All) {
            FilterChip(
              selected = true,
              onClick = { filterStatus = ThreadFilterStatus.All },
              label = { Text("Status: ${filterStatus.label}") },
              trailingIcon = {
                Icon(Icons.Rounded.Clear, contentDescription = "Clear filter", modifier = Modifier.size(16.dp))
              },
            )
          }
          if (filterProjectId != null) {
            val pTitle = runtime.shell.projects[filterProjectId]?.title ?: filterProjectId
            FilterChip(
              selected = true,
              onClick = { filterProjectId = null },
              label = { Text("Project: $pTitle") },
              trailingIcon = {
                Icon(Icons.Rounded.Clear, contentDescription = "Clear filter", modifier = Modifier.size(16.dp))
              },
            )
          }
        }
      }
      RuntimeError(runtime.error, dispatchState) {
        OutlinedButton(onClick = viewModel::retryConnection) { Text("Retry connection") }
      }
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        // Active / pinned cards first, then pending, then shelves (RN v2 order).
        threadListRows(
          rows = activeItems,
          keyPrefix = "active",
          runtime = runtime,
          viewModel = viewModel,
          capabilities = caps,
          compact = runtime.settings.compactThreadRows,
          groupByProject = runtime.settings.groupThreadsByProject,
          onOpenThread = onOpenThread,
        )

        if (runtime.pendingTasks.isNotEmpty()) {
          item(key = "pending-title") {
            Text(
              "Pending",
              modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
              style = MaterialTheme.typography.labelLarge,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          items(runtime.pendingTasks, key = PendingTask::messageId) { task ->
            PendingTaskRow(task, viewModel)
          }
        }

        if (showSnoozedSection) {
          item(key = "snoozed-shelf") {
            ThreadListV2ShelfHeader(
              label = "Snoozed",
              count = layout.snoozedCount,
              expanded = snoozedExpanded,
              accent = Color(0xFF60A5FA),
              onToggle = { snoozedExpanded = !snoozedExpanded },
            )
          }
          if (snoozedExpanded || filterStatus == ThreadFilterStatus.Snoozed) {
            threadListRows(
              rows = snoozedItems,
              keyPrefix = "snoozed",
              runtime = runtime,
              viewModel = viewModel,
              capabilities = caps,
              compact = true,
              groupByProject = runtime.settings.groupThreadsByProject,
              onOpenThread = onOpenThread,
            )
          }
        }

        if (showSettledSection) {
          item(key = "settled-shelf") {
            ThreadListV2ShelfHeader(
              label = "Settled",
              count = layout.settledCount,
              expanded = settledExpanded,
              onToggle = { settledExpanded = !settledExpanded },
            )
          }
          if (settledExpanded || filterStatus == ThreadFilterStatus.Settled) {
            threadListRows(
              rows = settledItems,
              keyPrefix = "settled",
              runtime = runtime,
              viewModel = viewModel,
              capabilities = caps,
              compact = true,
              groupByProject = runtime.settings.groupThreadsByProject,
              onOpenThread = onOpenThread,
            )
            if (layout.hiddenSettledCount > 0) {
              item(key = "settled-more") {
                TextButton(
                  onClick = { settledLimit += THREAD_LIST_V2_SETTLED_PAGE },
                  modifier = Modifier.fillMaxWidth(),
                ) {
                  Text("Show more (${layout.hiddenSettledCount})")
                }
              }
            }
          }
        }

        if (displayItems.isEmpty() && runtime.pendingTasks.isEmpty()) {
          item {
            Text(
              "No threads yet. Start a new task.",
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.padding(top = 24.dp),
            )
          }
        }
      }
    }
  }

  if (showFilterSheet) {
    ThreadFilterBottomSheet(
      filterStatus = filterStatus,
      filterProjectId = filterProjectId,
      projects = runtime.shell.projects.values.sortedBy(Project::title),
      environments = runtime.environments,
      selectedEnvironmentId = runtime.environment?.environmentId,
      onSelectStatus = { filterStatus = it },
      onSelectProject = { filterProjectId = it },
      onSelectEnvironment = { viewModel.selectEnvironment(it) },
      onDismiss = { showFilterSheet = false },
    )
  }
}

private fun LazyListScope.threadListRows(
  rows: List<ThreadListV2Item>,
  keyPrefix: String,
  runtime: OnlineChatState,
  viewModel: AppViewModel,
  capabilities: ThreadCapabilities,
  compact: Boolean,
  groupByProject: Boolean,
  onOpenThread: (String) -> Unit,
) {
  val orderedPinned = sortPinnedThreads(
    runtime.shell.threads.values.filter { it.pinnedAt != null && it.archivedAt == null },
  )
  val firstPinKey = orderedPinned.firstOrNull()?.pinOrderKey
  val groups = groupThreadListV2Items(rows, groupByProject)
  groups.forEach { (projectId, projectRows) ->
    if (projectId != null) {
      item(key = "$keyPrefix:project:$projectId") {
        Text(
          runtime.shell.projects[projectId]?.title ?: "Project",
          modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
          style = MaterialTheme.typography.labelLarge,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
    items(projectRows, key = { "$keyPrefix:${it.thread.id}" }) { item ->
      val project = runtime.shell.projects[item.thread.projectId]
      val pinnedIndex = orderedPinned.indexOfFirst { it.id == item.thread.id }
      ThreadListV2Row(
        item = item,
        capabilities = capabilities,
        compact = compact,
        projectTitle = project?.title,
        providerDriver = resolveProviderDriver(
          item.thread.modelSelection.instanceId,
          runtime.providerModels,
        ),
        faviconUrl = project?.let { runtime.projectFavicons[it.id] },
        newPinOrderKey = pinOrderKeyBetween(null, firstPinKey),
        canMovePinnedUp = capabilities.pinReorder && pinnedIndex > 0,
        canMovePinnedDown = capabilities.pinReorder && pinnedIndex in 0 until orderedPinned.lastIndex,
        onOpen = { onOpenThread(item.thread.id) },
        onAction = { command, value ->
          viewModel.threadAction(command, item.thread.id, value)
        },
        onMovePinned = { direction ->
          viewModel.reorderPinned(planPinnedMove(orderedPinned, item.thread.id, direction))
        },
      )
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThreadFilterBottomSheet(
  filterStatus: ThreadFilterStatus,
  filterProjectId: String?,
  projects: List<Project>,
  environments: List<SavedEnvironment>,
  selectedEnvironmentId: String?,
  onSelectStatus: (ThreadFilterStatus) -> Unit,
  onSelectProject: (String?) -> Unit,
  onSelectEnvironment: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    containerColor = Color(0xFF141417),
    contentColor = Color.White,
    shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
    scrimColor = Color.Black.copy(alpha = 0.6f),
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 12.dp)
        .verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = "Filter Threads",
          style = MaterialTheme.typography.titleLarge,
          fontWeight = FontWeight.Bold,
          color = Color.White,
        )
        if (filterStatus != ThreadFilterStatus.All || filterProjectId != null) {
          TextButton(onClick = {
            onSelectStatus(ThreadFilterStatus.All)
            onSelectProject(null)
            onDismiss()
          }) {
            Text("Reset all", color = MaterialTheme.colorScheme.primary)
          }
        }
      }

      HorizontalDivider(color = Color(0xFF27272A))

      Text("Status", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color.White)
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        ThreadFilterStatus.entries.forEach { st ->
          val selected = filterStatus == st
          FilterChip(
            selected = selected,
            onClick = {
              onSelectStatus(st)
              onDismiss()
            },
            label = { Text(st.label) },
            leadingIcon = if (selected) {
              { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
            } else null,
          )
        }
      }

      if (projects.isNotEmpty()) {
        Text("Project", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color.White)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Surface(
            onClick = {
              onSelectProject(null)
              onDismiss()
            },
            color = if (filterProjectId == null) Color(0xFF1E293B) else Color(0xFF18181B),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Row(
              modifier = Modifier.padding(12.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text("All Projects", fontWeight = FontWeight.Medium, color = Color.White)
              if (filterProjectId == null) {
                Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
              }
            }
          }
          projects.forEach { proj ->
            val isSel = filterProjectId == proj.id
            Surface(
              onClick = {
                onSelectProject(proj.id)
                onDismiss()
              },
              color = if (isSel) Color(0xFF1E293B) else Color(0xFF18181B),
              shape = RoundedCornerShape(10.dp),
              modifier = Modifier.fillMaxWidth(),
            ) {
              Row(
                modifier = Modifier.padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Text(proj.title, fontWeight = FontWeight.Medium, color = Color.White)
                if (isSel) {
                  Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                }
              }
            }
          }
        }
      }

      if (environments.isNotEmpty()) {
        Text("Environment", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color.White)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          environments.forEach { env ->
            val isSel = env.environmentId == selectedEnvironmentId
            Surface(
              onClick = {
                onSelectEnvironment(env.environmentId)
                onDismiss()
              },
              color = if (isSel) Color(0xFF1E293B) else Color(0xFF18181B),
              shape = RoundedCornerShape(10.dp),
              modifier = Modifier.fillMaxWidth(),
            ) {
              Row(
                modifier = Modifier.padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column {
                  Text(env.label, fontWeight = FontWeight.Medium, color = Color.White)
                  if (env.httpBaseUrl.isNotBlank()) {
                    Text(
                      env.httpBaseUrl,
                      style = MaterialTheme.typography.labelSmall,
                      color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                  }
                }
                if (isSel) {
                  Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                }
              }
            }
          }
        }
      }

      Spacer(Modifier.height(16.dp))
    }
  }
}

@Composable
private fun PendingTaskRow(task: PendingTask, viewModel: AppViewModel) {
  var editing by remember(task.messageId) { mutableStateOf(false) }
  var text by remember(task.messageId, task.text) { mutableStateOf(task.text) }
  Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF111827))) {
    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      if (task.text.isNotBlank()) Text(task.text, maxLines = 3, fontWeight = FontWeight.SemiBold)
      ComposerAttachmentStrip(
        attachments = task.attachments,
        onRemove = { viewModel.removePendingAttachment(task.messageId, it) },
        removable = task.status != PendingTaskStatus.Sending,
      )
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
      text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          OutlinedTextField(text, { text = it }, minLines = 3)
          ComposerAttachmentButtons(
            existingCount = task.attachments.size,
            onAdd = { viewModel.importPendingAttachments(task.messageId, it) },
            onPasteText = { text += it },
          )
        }
      },
      confirmButton = {
        Button(
          onClick = {
            viewModel.editPending(task.messageId, text)
            editing = false
          },
          enabled = text.isNotBlank() || task.attachments.isNotEmpty(),
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
  onAddEnvironment: () -> Unit,
  onAddProject: () -> Unit,
  onOpenArchivedThreads: () -> Unit,
) {
  var showEditEnv by remember { mutableStateOf(false) }
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Settings", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Text("Environments", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      if (runtime.environments.isEmpty()) {
        Text("No saved environments", color = MaterialTheme.colorScheme.onSurfaceVariant)
      } else {
        runtime.environments.forEach { item ->
          val isSelected = item.environmentId == runtime.environment?.environmentId
          val status = runtime.environmentStatuses[item.environmentId]
          Card(
            onClick = { viewModel.selectEnvironment(item.environmentId) },
            colors = CardDefaults.cardColors(
              containerColor = if (isSelected) Color(0xFF1E293B) else Color(0xFF111827),
            ),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Row(
              modifier = Modifier.padding(14.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
              Column(modifier = Modifier.weight(1f)) {
                Text(
                  text = item.label,
                  fontWeight = FontWeight.Bold,
                  color = Color.White,
                )
                Text(
                  text = status?.connectionPhase?.name ?: if (isSelected) "Selected" else "Saved",
                  style = MaterialTheme.typography.labelSmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
              if (isSelected) {
                Icon(
                  imageVector = Icons.Rounded.Check,
                  contentDescription = "Selected",
                  tint = MaterialTheme.colorScheme.primary,
                )
              }
            }
          }
        }
      }
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Button(
          onClick = onAddEnvironment,
          modifier = Modifier.weight(1f),
        ) {
          Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
          Spacer(Modifier.width(6.dp))
          Text("Add environment")
        }
        if (runtime.environment != null) {
          OutlinedButton(onClick = { showEditEnv = true }) {
            Text("Edit current")
          }
        }
      }
      HorizontalDivider()
      Text("Projects", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      OutlinedButton(onClick = onAddProject, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Rounded.CreateNewFolder, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Add project")
      }
      HorizontalDivider()
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
      Text("Threads", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      OutlinedButton(onClick = onOpenArchivedThreads, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Rounded.Archive, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Archived Threads")
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

  if (showEditEnv) {
    EnvironmentDialog(
      runtime = runtime,
      viewModel = viewModel,
      onAdd = {
        showEditEnv = false
        onAddEnvironment()
      },
      dismiss = { showEditEnv = false },
    )
  }
}

private data class ArchivedThreadEntry(
  val environment: SavedEnvironment,
  val project: Project?,
  val thread: ThreadSummary,
)

@Composable
private fun ArchivedThreadsScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  var search by remember { mutableStateOf("") }
  var deleteTarget by remember { mutableStateOf<ArchivedThreadEntry?>(null) }
  val entries = remember(runtime.environmentShells, runtime.environments, search) {
    val environments = runtime.environments.associateBy(SavedEnvironment::environmentId)
    runtime.environmentShells.flatMap { (environmentId, shell) ->
      val environment = environments[environmentId] ?: return@flatMap emptyList()
      shell.threads.values.mapNotNull { thread ->
        thread.takeIf { it.archivedAt != null }?.let {
          ArchivedThreadEntry(environment, shell.projects[thread.projectId], thread)
        }
      }
    }.filter { entry ->
      search.isBlank() || entry.thread.title.contains(search.trim(), ignoreCase = true)
    }.sortedByDescending { it.thread.updatedAt }
  }

  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Archived Threads", onBack) }) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      OutlinedTextField(
        value = search,
        onValueChange = { search = it },
        label = { Text("Search archived threads") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(16.dp),
      )
      RuntimeError(runtime.error, dispatchState)
      if (entries.isEmpty()) {
        Text(
          if (search.isBlank()) "No archived threads" else "No matching archived threads",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp),
        )
      } else {
        LazyColumn(
          modifier = Modifier.fillMaxSize(),
          contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          items(entries, key = { "${it.environment.environmentId}:${it.thread.id}" }) { entry ->
            Card(modifier = Modifier.fillMaxWidth()) {
              Column(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
              ) {
                Text(entry.thread.title, fontWeight = FontWeight.SemiBold)
                Text(
                  listOfNotNull(entry.environment.label, entry.project?.title).joinToString(" · "),
                  style = MaterialTheme.typography.labelSmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                  Button(onClick = {
                    viewModel.threadAction(
                      entry.environment.environmentId,
                      "thread.unarchive",
                      entry.thread.id,
                    )
                  }) {
                    Icon(Icons.Rounded.Unarchive, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Restore")
                  }
                  TextButton(onClick = { deleteTarget = entry }) { Text("Delete") }
                }
              }
            }
          }
        }
      }
    }
  }

  deleteTarget?.let { entry ->
    AlertDialog(
      onDismissRequest = { deleteTarget = null },
      title = { Text("Delete thread?") },
      text = { Text("This permanently deletes the thread from ${entry.environment.label}.") },
      confirmButton = {
        Button(onClick = {
          viewModel.threadAction(
            entry.environment.environmentId,
            "thread.delete",
            entry.thread.id,
          )
          deleteTarget = null
        }) { Text("Delete") }
      },
      dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun NewTaskScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  initialProjectId: String?,
  onBack: () -> Unit,
  onAddProject: () -> Unit,
) {
  val environmentId = runtime.environment?.environmentId ?: return
  val draftRevision by viewModel.draftRevision.collectAsState()
  val draftKey = remember(environmentId) { DraftStore.newTaskKey(environmentId) }
  var draft by remember(draftKey) { mutableStateOf(viewModel.loadDraft(draftKey)) }
  LaunchedEffect(draftRevision, draftKey) { draft = viewModel.loadDraft(draftKey) }
  val projects = runtime.shell.projects.values.sortedBy(Project::title)
  var projectId by remember(environmentId, initialProjectId) {
    mutableStateOf(initialProjectId ?: projects.firstOrNull()?.id.orEmpty())
  }
  LaunchedEffect(projects, initialProjectId) {
    val requested = projects.firstOrNull { it.id == initialProjectId }?.id
    if (requested != null) projectId = requested
    else if (projects.none { it.id == projectId }) projectId = projects.firstOrNull()?.id.orEmpty()
  }
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
      OutlinedButton(onClick = onAddProject, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Rounded.CreateNewFolder, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Add project")
      }
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        val selectedModel = runtime.providerModels.firstOrNull {
          it.instanceId == draft.modelInstanceId && it.model == draft.model
        } ?: runtime.providerModels.firstOrNull { it.isDefault } ?: runtime.providerModels.firstOrNull()
        SelectionField(
          label = "Model",
          selected = selectedModel?.modelLabel ?: "Default",
          options = runtime.providerModels.map { "${it.instanceId}:${it.model}" to it.modelLabel },
          onSelect = { key ->
            val m = runtime.providerModels.first { "${it.instanceId}:${it.model}" == key }
            draft = draft.copy(modelInstanceId = m.instanceId, model = m.model).also { viewModel.saveDraft(draftKey, it) }
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
          onSelect = { draft = draft.copy(runtimeMode = it).also { next -> viewModel.saveDraft(draftKey, next) } },
          modifier = Modifier.weight(1f),
        )
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
      ComposerAttachmentActions(
        draft = draft,
        onAdd = { viewModel.importDraftAttachments(draftKey, it) },
        onRemove = { viewModel.removeDraftAttachment(draftKey, it) },
        enabled = dispatchState !is DispatchState.Sending,
        onPasteText = {
          draft = draft.copy(text = draft.text + it)
          viewModel.saveDraft(draftKey, draft)
        },
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
        enabled = (draft.text.isNotBlank() || draft.attachments.isNotEmpty()) && projectId.isNotBlank() &&
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
  gitState: GitUiState,
  onBack: () -> Unit,
  onFiles: () -> Unit,
  onGit: () -> Unit,
  onReview: () -> Unit,
  onTerminal: () -> Unit,
) {
  val detail = runtime.thread.detail
  val focusManager = LocalFocusManager.current
  LaunchedEffect(threadId) {
    focusManager.clearFocus(force = true)
    viewModel.selectThread(threadId)
    viewModel.observeGit(threadId)
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

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Text(
            detail?.summary?.title ?: "Thread",
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
          )
        },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = onReview, enabled = detail != null) {
            Icon(Icons.Rounded.RateReview, contentDescription = "Review changes")
          }
          IconButton(onClick = onTerminal, enabled = detail != null) {
            Icon(Icons.Rounded.Terminal, contentDescription = "Open terminal")
          }
          TextButton(onClick = onGit, enabled = detail != null) {
            Icon(Icons.Rounded.AccountTree, contentDescription = null)
            Spacer(Modifier.width(5.dp))
            Text(
              gitState.status?.refName ?: "Git",
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
          IconButton(onClick = onFiles, enabled = detail != null) {
            Icon(Icons.Rounded.FolderOpen, contentDescription = "Files")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
      if (runtime.threadSyncPhase == SyncPhase.Synchronizing) {
        LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
      }
      if (detail == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(runtime.error ?: "Opening thread…")
        }
      } else {
        ThreadFeed(
          detail = detail,
          environmentId = environmentId,
          viewModel = viewModel,
          modifier = Modifier.fillMaxSize(),
          contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 140.dp),
        )
        Column(
          modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth(),
        ) {
          ThreadRequests(detail, viewModel)
          DispatchFailure(dispatchState, viewModel::retryDispatch)
          ChatComposerArea(
            detail = detail,
            draft = draft,
            models = runtime.providerModels,
            enabled = runtime.shell.sequence >= 0,
            sending = dispatchState is DispatchState.Sending,
            onDraftUpdate = { next ->
              draft = next
              viewModel.saveDraft(draftKey, next)
            },
            onAddAttachments = { viewModel.importDraftAttachments(draftKey, it) },
            onRemoveAttachment = { viewModel.removeDraftAttachment(draftKey, it) },
            onSend = { viewModel.sendThreadTurn(threadId, draftKey, draft) },
            onInterrupt = { viewModel.interrupt(threadId) },
            onStop = { viewModel.stop(threadId) },
          )
        }
      }
    }
  }
}

@Composable
private fun ThreadFeed(
  detail: ThreadDetail,
  environmentId: String,
  viewModel: AppViewModel,
  modifier: Modifier = Modifier,
  state: LazyListState = rememberLazyListState(),
  contentPadding: PaddingValues = PaddingValues(16.dp),
) {
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
    contentPadding = contentPadding,
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    items(entries, key = { it.id }) { message ->
      if (message.role == "assistant") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          if (message.text.isNotBlank()) MarkdownMessage(message.text)
          message.attachments.forEach { SentAttachmentImage(environmentId, it, viewModel) }
        }
      } else {
        Surface(
          shape = RoundedCornerShape(16.dp),
          color = if (message.role == "user") Color(0xFF172554) else MaterialTheme.colorScheme.surface,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (message.text.isNotBlank()) UserMessageContent(message.text)
            message.attachments.forEach { SentAttachmentImage(environmentId, it, viewModel) }
          }
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
private fun UserMessageContent(text: String, modifier: Modifier = Modifier) {
  val segments = remember(text) { parseReviewMessageSegments(text) }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    segments.forEach { segment ->
      when (segment) {
        is ReviewMessageSegment.Text -> segment.value.trim().takeIf(String::isNotEmpty)?.let {
          Text(it)
        }
        is ReviewMessageSegment.Comment -> ReviewCommentCard(segment.value)
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
private fun resolveThreadProviderModels(
  threadInstanceId: String,
  allModels: List<ProviderModel>,
): List<ProviderModel> {
  val exactMatches = allModels.filter { it.instanceId == threadInstanceId }
  if (exactMatches.isNotEmpty()) return exactMatches

  val threadDriver = resolveProviderDriver(threadInstanceId, allModels)
  val driverMatches = allModels.filter {
    resolveProviderDriver(it.instanceId, allModels) == threadDriver
  }
  return if (driverMatches.isNotEmpty()) driverMatches else allModels
}

@Composable
private fun ChatComposerArea(
  detail: ThreadDetail,
  draft: ComposerDraft,
  models: List<ProviderModel>,
  enabled: Boolean,
  sending: Boolean,
  onDraftUpdate: (ComposerDraft) -> Unit,
  onAddAttachments: (List<Uri>) -> Unit,
  onRemoveAttachment: (String) -> Unit,
  onSend: () -> Unit,
  onInterrupt: () -> Unit,
  onStop: () -> Unit,
) {
  var showModelMenu by remember { mutableStateOf(false) }
  var showAccessMenu by remember { mutableStateOf(false) }

  val threadInstanceId = detail.summary.modelSelection.instanceId
  val availableModels = remember(threadInstanceId, models) {
    resolveThreadProviderModels(threadInstanceId, models)
  }

  val selectedModel = availableModels.firstOrNull {
    it.instanceId == draft.modelInstanceId && it.model == draft.model
  } ?: availableModels.firstOrNull {
    it.instanceId == threadInstanceId && it.model == detail.summary.modelSelection.model
  } ?: availableModels.firstOrNull { it.isDefault } ?: availableModels.firstOrNull()

  val session = detail.summary.session
  val active = session?.status in setOf("starting", "running")

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    val composerShape = RoundedCornerShape(20.dp)
    Surface(
      shape = composerShape,
      color = Color(0xFF141417),
      border = BorderStroke(1.dp, Color(0xFF27272A)),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        ComposerAttachmentStrip(draft.attachments, onRemoveAttachment, removable = !sending)
        val reviewComments = remember(draft.text) { parseReviewComments(draft.text) }
        reviewComments.forEach { comment ->
          ReviewCommentCard(
            comment = comment,
            onRemove = {
              onDraftUpdate(draft.copy(text = removeReviewComment(draft.text, comment.id)))
            },
          )
        }
        // Message input text field with minimal internal margins on all sides
        BasicTextField(
          value = plainReviewMessageText(draft.text),
          onValueChange = {
            onDraftUpdate(draft.copy(text = replacePlainReviewMessageText(draft.text, it)))
          },
          minLines = 2,
          maxLines = 6,
          textStyle = MaterialTheme.typography.bodyMedium.copy(color = Color.White),
          cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
          decorationBox = { innerTextField ->
            Box(
              modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            ) {
              if (draft.text.isEmpty()) {
                Text(
                  if (enabled) "Send a message…" else "Waiting for sync…",
                  color = Color(0xFF71717A),
                  style = MaterialTheme.typography.bodyMedium,
                )
              }
              innerTextField()
            }
          },
          modifier = Modifier.fillMaxWidth(),
        )

        // Bottom Action Bar housing the 3 Option Pills + Send/Stop Button
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Left side: Option Pills (Model, Access, Mode)
          Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.weight(1f, fill = false),
          ) {
            ComposerAttachmentButtons(
              existingCount = draft.attachments.size,
              onAdd = onAddAttachments,
              enabled = !sending,
              onPasteText = { pasted ->
                onDraftUpdate(draft.copy(text = draft.text + pasted))
              },
            )
            // 1. Model Selector Pill
            Box {
              Surface(
                onClick = { showModelMenu = true },
                shape = RoundedCornerShape(12.dp),
                color = Color(0xFF27272A),
                modifier = Modifier.height(30.dp),
              ) {
                Row(
                  modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                  Text(
                    text = selectedModel?.modelLabel ?: "Default Model",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                    maxLines = 1,
                  )
                  Icon(
                    imageVector = Icons.Rounded.KeyboardArrowDown,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                }
              }

              DropdownMenu(
                expanded = showModelMenu,
                onDismissRequest = { showModelMenu = false },
              ) {
                availableModels.forEach { model ->
                  val isSelected = model.instanceId == draft.modelInstanceId && model.model == draft.model
                  DropdownMenuItem(
                    text = {
                      Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                      ) {
                        Text(
                          model.modelLabel,
                          fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (isSelected) {
                          Icon(
                            Icons.Rounded.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(16.dp),
                          )
                        }
                      }
                    },
                    onClick = {
                      showModelMenu = false
                      onDraftUpdate(draft.copy(modelInstanceId = model.instanceId, model = model.model))
                    },
                  )
                }
              }
            }

            // 2. Access Mode Pill
            val accessLabel = when (draft.runtimeMode) {
              "approval-required" -> "Ask"
              "auto-accept-edits" -> "Auto edits"
              "auto" -> "Auto"
              else -> "Full"
            }
            Box {
              Surface(
                onClick = { showAccessMenu = true },
                shape = RoundedCornerShape(12.dp),
                color = Color(0xFF27272A),
                modifier = Modifier.height(30.dp),
              ) {
                Row(
                  modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                  Icon(
                    imageVector = if (draft.runtimeMode == "approval-required") Icons.Rounded.Shield else Icons.Rounded.Bolt,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = if (draft.runtimeMode == "approval-required") UnsnoozeColor else SettleColor,
                  )
                  Text(
                    text = accessLabel,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                  )
                }
              }

              DropdownMenu(
                expanded = showAccessMenu,
                onDismissRequest = { showAccessMenu = false },
              ) {
                listOf(
                  "approval-required" to "Ask (Approval Required)",
                  "auto-accept-edits" to "Auto Edits",
                  "auto" to "Auto Mode",
                  "full-access" to "Full Access",
                ).forEach { (key, label) ->
                  val isSel = draft.runtimeMode == key
                  DropdownMenuItem(
                    text = {
                      Text(label, fontWeight = if (isSel) FontWeight.Bold else FontWeight.Normal)
                    },
                    onClick = {
                      showAccessMenu = false
                      onDraftUpdate(draft.copy(runtimeMode = key))
                    },
                  )
                }
              }
            }

            // 3. Plan Mode Toggle Pill
            val isPlan = draft.interactionMode == "plan"
            Surface(
              onClick = {
                onDraftUpdate(draft.copy(interactionMode = if (isPlan) "default" else "plan"))
              },
              shape = RoundedCornerShape(12.dp),
              color = if (isPlan) MaterialTheme.colorScheme.primaryContainer else Color(0xFF27272A),
              modifier = Modifier.height(30.dp),
            ) {
              Row(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
              ) {
                Icon(
                  imageVector = Icons.Rounded.EditNote,
                  contentDescription = null,
                  modifier = Modifier.size(14.dp),
                  tint = if (isPlan) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                  text = if (isPlan) "Plan" else "Chat",
                  style = MaterialTheme.typography.labelMedium,
                  fontWeight = FontWeight.SemiBold,
                  color = if (isPlan) MaterialTheme.colorScheme.primary else Color.White,
                )
              }
            }
          }

          // Right side: Send / Interrupt Button
          Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            if (active) {
              IconButton(
                onClick = onInterrupt,
                modifier = Modifier
                  .size(38.dp)
                  .background(Color(0xFFEF4444), CircleShape),
              ) {
                Icon(
                  imageVector = Icons.Rounded.Stop,
                  contentDescription = "Interrupt",
                  tint = Color.White,
                  modifier = Modifier.size(20.dp),
                )
              }
            } else {
              val canSend = enabled &&
                (draft.text.isNotBlank() || draft.attachments.isNotEmpty()) && !sending
              IconButton(
                onClick = onSend,
                enabled = canSend,
                modifier = Modifier
                  .size(38.dp)
                  .background(
                    if (canSend) MaterialTheme.colorScheme.primary else Color(0xFF27272A),
                    CircleShape,
                  ),
              ) {
                Icon(
                  imageVector = Icons.AutoMirrored.Rounded.Send,
                  contentDescription = "Send message",
                  tint = if (canSend) Color.White else Color(0xFF71717A),
                  modifier = Modifier.size(18.dp),
                )
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ComposerAttachmentActions(
  draft: ComposerDraft,
  onAdd: (List<Uri>) -> Unit,
  onRemove: (String) -> Unit,
  enabled: Boolean = true,
  onPasteText: (String) -> Unit,
) {
  ComposerAttachmentStrip(draft.attachments, onRemove, removable = enabled)
  ComposerAttachmentButtons(draft.attachments.size, onAdd, enabled, onPasteText)
}

@Composable
private fun ComposerAttachmentButtons(
  existingCount: Int,
  onAdd: (List<Uri>) -> Unit,
  enabled: Boolean = true,
  onPasteText: (String) -> Unit,
) {
  val context = LocalContext.current
  val picker = rememberLauncherForActivityResult(
    ActivityResultContracts.PickMultipleVisualMedia(MaxComposerAttachments),
    onAdd,
  )
  Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    IconButton(
      onClick = {
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
      },
      enabled = enabled && existingCount < MaxComposerAttachments,
    ) {
      Icon(Icons.Rounded.PhotoLibrary, contentDescription = "Add images")
    }
    IconButton(
      onClick = {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val clip = clipboard?.primaryClip
        val item = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
        val imageUri = item?.uri?.takeIf {
          clip.description.hasMimeType("image/*") || context.contentResolver.getType(it)?.startsWith("image/") == true
        }
        when {
          imageUri != null -> onAdd(listOf(imageUri))
          item != null -> item.coerceToText(context).toString().takeIf(String::isNotEmpty)?.let(onPasteText)
        }
      },
      enabled = enabled,
    ) {
      Icon(Icons.Rounded.ContentPaste, contentDescription = "Paste image or text")
    }
  }
}

@Composable
private fun ComposerAttachmentStrip(
  attachments: List<DraftImageAttachment>,
  onRemove: (String) -> Unit,
  removable: Boolean = true,
) {
  if (attachments.isEmpty()) return
  var preview by remember { mutableStateOf<DraftImageAttachment?>(null) }
  LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    items(attachments, key = DraftImageAttachment::id) { attachment ->
      Box {
        AsyncImage(
          model = File(attachment.path),
          contentDescription = attachment.name,
          contentScale = ContentScale.Crop,
          modifier = Modifier
            .size(72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF27272A), RoundedCornerShape(12.dp))
            .clickable { preview = attachment },
        )
        if (removable) {
          IconButton(
            onClick = { onRemove(attachment.id) },
            modifier = Modifier.align(Alignment.TopEnd).size(28.dp),
          ) {
            Icon(
              Icons.Rounded.Clear,
              contentDescription = "Remove ${attachment.name}",
              tint = Color.White,
              modifier = Modifier
                .size(18.dp)
                .background(Color.Black.copy(alpha = 0.7f), CircleShape),
            )
          }
        }
      }
    }
  }
  preview?.let { attachment ->
    AlertDialog(
      onDismissRequest = { preview = null },
      title = { Text(attachment.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
      text = {
        AsyncImage(
          model = File(attachment.path),
          contentDescription = attachment.name,
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxWidth().height(320.dp),
        )
      },
      confirmButton = { TextButton(onClick = { preview = null }) { Text("Close") } },
    )
  }
}

@Composable
private fun SentAttachmentImage(
  environmentId: String,
  attachment: ChatImageAttachment,
  viewModel: AppViewModel,
) {
  val urls by viewModel.attachmentUrls.collectAsState()
  val key = "$environmentId:${attachment.id}"
  val url = urls[key]
  var preview by remember(attachment.id) { mutableStateOf(false) }
  LaunchedEffect(key) { viewModel.loadAttachmentUrl(environmentId, attachment.id) }
  AsyncImage(
    model = url,
    contentDescription = attachment.name,
    contentScale = ContentScale.Crop,
    modifier = Modifier
      .fillMaxWidth()
      .height(220.dp)
      .clip(RoundedCornerShape(14.dp))
      .background(Color(0xFF27272A), RoundedCornerShape(14.dp))
      .clickable(enabled = url != null) { preview = true },
  )
  if (preview) {
    AlertDialog(
      onDismissRequest = { preview = false },
      title = { Text(attachment.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
      text = {
        AsyncImage(
          model = url,
          contentDescription = attachment.name,
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxWidth().height(320.dp),
        )
      },
      confirmButton = { TextButton(onClick = { preview = false }) { Text("Close") } },
    )
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
    title = {
      Text(
        text = title,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
      )
    },
    navigationIcon = {
      IconButton(onClick = onBack) {
        Icon(
          imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
          contentDescription = "Back",
          tint = Color.White,
        )
      }
    },
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
