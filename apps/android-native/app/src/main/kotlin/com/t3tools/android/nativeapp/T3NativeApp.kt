@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.content.ClipboardManager
import android.content.ClipData
import android.os.Build
import android.net.Uri
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Clear
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CreateNewFolder
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.FilterList
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.WarningAmber
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
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import com.t3tools.android.protocol.ProviderOptionDescriptor
import com.t3tools.android.protocol.ThreadDetail
import com.t3tools.android.protocol.ThreadSummary
import com.t3tools.android.protocol.ChatImageAttachment
import com.t3tools.android.protocol.ChatMessage
import com.t3tools.android.protocol.DEFAULT_TERMINAL_ID
import com.t3tools.android.protocol.nextTerminalId
import io.noties.markwon.Markwon
import coil.compose.AsyncImage
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

private const val ONBOARDING = "onboarding"
private const val CONNECT = "connect"
private const val HOME = "home"
private const val INCOMING_SHARE = "share/{shareId}"
private const val ADD_PROJECT = "add-project"
private const val SETTINGS = "settings"
private const val ARCHIVED_THREADS = "settings/archived"
private const val THREAD = "thread/{threadId}"
private const val THREAD_FILES = "thread/{threadId}/files"
private const val THREAD_GIT_COMMIT = "thread/{threadId}/git/commit"
private const val THREAD_GIT_BRANCHES = "thread/{threadId}/git/branches"
private const val MESSAGE_ENTRY_MILLIS = 220
private const val FRESH_MESSAGE_WINDOW_MILLIS = 3_000
private const val PAGE_TRANSITION_MILLIS = 220

private val markdownRenderDispatcher = Dispatchers.Default.limitedParallelism(1)

private data class RenderedMarkdown(
  val source: String,
  val content: Spanned,
)

private data class NewTaskDrawerState(val projectId: String?)
private const val THREAD_TERMINAL = "thread/{threadId}/terminal/{terminalId}"
private const val THREAD_REVIEW = "thread/{threadId}/review"

@Composable
fun T3NativeApp(viewModel: AppViewModel) {
  val runtime by viewModel.runtime.collectAsState()
  val dispatchState by viewModel.dispatchState.collectAsState()
  val gitState by viewModel.gitState.collectAsState()
  val incomingShares by viewModel.incomingShares.collectAsState()
  val navController = rememberNavController()
  val start = remember { if (runtime.environment == null) ONBOARDING else HOME }
  var newTaskDrawer by remember { mutableStateOf<NewTaskDrawerState?>(null) }
  var gitDrawerThreadId by remember { mutableStateOf<String?>(null) }
  var reopenGitDrawerThreadId by remember { mutableStateOf<String?>(null) }

  LaunchedEffect(viewModel) {
    viewModel.events.collectLatest { event ->
      when (event) {
        AppEvent.OpenHome -> {
          newTaskDrawer = null
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = null
          navController.navigate(HOME) {
            popUpTo(ONBOARDING) { inclusive = true }
            launchSingleTop = true
          }
        }
        AppEvent.OpenAddEnvironment -> {
          newTaskDrawer = null
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = null
          navController.navigate(ONBOARDING) { launchSingleTop = true }
        }
        is AppEvent.OpenNewTask -> {
          reopenGitDrawerThreadId = null
          if (event.clearEntryRoute) {
            navController.navigate(HOME) {
              popUpTo(0)
              launchSingleTop = true
            }
          } else if (navController.currentDestination?.route == ADD_PROJECT) {
            navController.popBackStack()
          }
          newTaskDrawer = NewTaskDrawerState(event.projectId)
        }
        is AppEvent.OpenIncomingShare -> navController.navigate(
          "share/${Uri.encode(event.shareId)}",
        ) {
          popUpTo(0)
          launchSingleTop = true
        }
        is AppEvent.OpenThread -> {
          newTaskDrawer = null
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = null
          navController.navigate("thread/${Uri.encode(event.threadId)}") {
            if (event.clearEntryRoute) popUpTo(0)
            launchSingleTop = true
          }
        }
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
    NavHost(
      navController = navController,
      startDestination = start,
      enterTransition = {
        fadeIn(tween(PAGE_TRANSITION_MILLIS)) + slideInHorizontally(
          animationSpec = tween(PAGE_TRANSITION_MILLIS),
          initialOffsetX = { it / 10 },
        )
      },
      exitTransition = {
        fadeOut(tween(PAGE_TRANSITION_MILLIS)) + slideOutHorizontally(
          animationSpec = tween(PAGE_TRANSITION_MILLIS),
          targetOffsetX = { -it / 20 },
        )
      },
      popEnterTransition = {
        fadeIn(tween(PAGE_TRANSITION_MILLIS)) + slideInHorizontally(
          animationSpec = tween(PAGE_TRANSITION_MILLIS),
          initialOffsetX = { -it / 20 },
        )
      },
      popExitTransition = {
        fadeOut(tween(PAGE_TRANSITION_MILLIS)) + slideOutHorizontally(
          animationSpec = tween(PAGE_TRANSITION_MILLIS),
          targetOffsetX = { it / 10 },
        )
      },
    ) {
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
        onNewTask = {
          reopenGitDrawerThreadId = null
          newTaskDrawer = NewTaskDrawerState(null)
        },
        onOpenThread = { navController.navigate("thread/$it") },
        pendingShares = incomingShares,
        onOpenShare = { navController.navigate("share/${Uri.encode(it)}") },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
        onSettings = { navController.navigate(SETTINGS) },
      )
    }
    composable(
      route = INCOMING_SHARE,
      arguments = listOf(navArgument("shareId") { type = NavType.StringType }),
    ) { entry ->
      val shareId = requireNotNull(entry.arguments?.getString("shareId"))
      IncomingShareScreen(
        share = incomingShares.firstOrNull { it.id == shareId },
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
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
        onGit = { gitDrawerThreadId = threadId },
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
      route = THREAD_GIT_COMMIT,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      GitCommitScreen(
        threadId = threadId,
        state = gitState,
        viewModel = viewModel,
        onBack = {
          navController.popBackStack()
          reopenGitDrawerThreadId?.takeIf { it == threadId }?.let {
            reopenGitDrawerThreadId = null
            gitDrawerThreadId = it
          }
        },
      )
    }
    composable(
      route = THREAD_GIT_BRANCHES,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      GitBranchesScreen(
        threadId = threadId,
        state = gitState,
        viewModel = viewModel,
        onBack = {
          navController.popBackStack()
          reopenGitDrawerThreadId?.takeIf { it == threadId }?.let {
            reopenGitDrawerThreadId = null
            gitDrawerThreadId = it
          }
        },
      )
    }
    composable(
      route = THREAD_REVIEW,
      arguments = listOf(navArgument("threadId") { type = NavType.StringType }),
    ) { entry ->
      val threadId = requireNotNull(entry.arguments?.getString("threadId"))
      ReviewScreen(
        threadId = threadId,
        connectionPhase = runtime.connectionPhase,
        viewModel = viewModel,
        onBack = {
          navController.popBackStack()
          reopenGitDrawerThreadId?.takeIf { it == threadId }?.let {
            reopenGitDrawerThreadId = null
            gitDrawerThreadId = it
          }
        },
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
    newTaskDrawer?.let { drawer ->
      NewTaskDrawer(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        initialProjectId = drawer.projectId,
        onDismiss = { newTaskDrawer = null },
        onAddProject = {
          newTaskDrawer = null
          navController.navigate(ADD_PROJECT)
        },
      )
    }
    gitDrawerThreadId?.let { threadId ->
      GitOverviewDrawer(
        threadId = threadId,
        state = gitState,
        viewModel = viewModel,
        onDismiss = { gitDrawerThreadId = null },
        onCommit = {
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = threadId
          navController.navigate("thread/$threadId/git/commit")
        },
        onBranches = {
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = threadId
          navController.navigate("thread/$threadId/git/branches")
        },
        onReview = {
          gitDrawerThreadId = null
          reopenGitDrawerThreadId = threadId
          navController.navigate("thread/$threadId/review")
        },
      )
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
  onOpenThread: (String) -> Unit,
  pendingShares: List<IncomingShare>,
  onOpenShare: (String) -> Unit,
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
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        OutlinedTextField(
          value = search,
          onValueChange = { search = it },
          label = { Text("Search threads") },
          singleLine = true,
          modifier = Modifier.weight(1f),
        )
        IconButton(onClick = { showFilterSheet = true }) {
          Icon(
            imageVector = if (isFiltered) Icons.Rounded.FilterAlt else Icons.Rounded.FilterList,
            contentDescription = "Filter threads",
            tint = if (isFiltered) MaterialTheme.colorScheme.primary else Color.White,
          )
        }
      }

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
        pendingShares.firstOrNull()?.let { share ->
          item(key = "incoming-share-${share.id}") {
            Card(onClick = { onOpenShare(share.id) }) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
              ) {
                Icon(Icons.Rounded.PhotoLibrary, contentDescription = null)
                Column(Modifier.weight(1f)) {
                  Text("Shared content waiting", fontWeight = FontWeight.SemiBold)
                  Text(
                    share.summaryLabel(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                }
                Text("Resume", color = MaterialTheme.colorScheme.primary)
              }
            }
          }
        }

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
private fun IncomingShareScreen(
  share: IncomingShare?,
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onAddEnvironment: () -> Unit,
) {
  val environments = runtime.environments
  var environmentId by remember(share?.id, environments) {
    mutableStateOf(
      runtime.environment?.environmentId
        ?.takeIf { selected -> environments.any { it.environmentId == selected } }
        ?: environments.firstOrNull()?.environmentId.orEmpty(),
    )
  }

  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Shared content", onBack) }) { padding ->
    Column(
      Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      if (share == null) {
        Text("This shared content is no longer available.")
        Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Done") }
        return@Column
      }

      Text(
        "Choose where to continue. The content will be added to a new task draft.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      if (share.text.isNotBlank()) {
        Card(Modifier.fillMaxWidth()) {
          Text(
            share.text,
            modifier = Modifier.padding(16.dp),
            maxLines = 10,
            overflow = TextOverflow.Ellipsis,
          )
        }
      }
      if (share.images.isNotEmpty()) {
        Card(Modifier.fillMaxWidth()) {
          Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
              if (share.images.size == 1) "1 image" else "${share.images.size} images",
              fontWeight = FontWeight.SemiBold,
            )
            share.images.forEach { image ->
              Text(
                image.name,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
            }
          }
        }
      }
      share.warning?.let {
        Text(it, color = MaterialTheme.colorScheme.error)
      }

      if (environments.isEmpty()) {
        Text("Add an environment before creating the task.")
        Button(onClick = onAddEnvironment, modifier = Modifier.fillMaxWidth()) {
          Text("Add environment")
        }
      } else {
        SelectionField(
          label = "Environment",
          selected = environments.firstOrNull { it.environmentId == environmentId }?.label
            ?: "Choose environment",
          options = environments.map { it.environmentId to it.label },
          onSelect = { environmentId = it },
        )
        Button(
          onClick = { viewModel.acceptIncomingShare(share.id, environmentId) },
          enabled = environmentId.isNotBlank() && dispatchState !is DispatchState.Sending,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Text(if (dispatchState is DispatchState.Sending) "Preparing…" else "Continue to new task")
        }
      }
      TextButton(
        onClick = { viewModel.discardIncomingShare(share.id) },
        enabled = dispatchState !is DispatchState.Sending,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text("Discard shared content")
      }
      RuntimeError(runtime.error, dispatchState)
    }
  }
}

private fun IncomingShare.summaryLabel(): String = buildList {
  if (text.isNotBlank()) add("Text")
  if (images.isNotEmpty()) add(if (images.size == 1) "1 image" else "${images.size} images")
}.joinToString(" · ")

@Composable
private fun NewTaskDrawer(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  initialProjectId: String?,
  onDismiss: () -> Unit,
  onAddProject: () -> Unit,
) {
  val environmentId = runtime.environment?.environmentId ?: return
  val draftRevision by viewModel.draftRevision.collectAsState()
  val branchesState by viewModel.newTaskBranchesState.collectAsState()
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
  val project = projects.firstOrNull { it.id == projectId }
  var worktree by remember(environmentId, projectId) { mutableStateOf(false) }
  var baseBranch by remember(environmentId, projectId) { mutableStateOf("") }
  var startFromOrigin by remember(environmentId, projectId) { mutableStateOf(true) }
  var runSetup by remember(environmentId, projectId) { mutableStateOf(false) }

  LaunchedEffect(environmentId, projectId) {
    if (projectId.isNotBlank()) viewModel.loadNewTaskBranches(projectId)
  }
  val projectBranchesState = branchesState.takeIf {
    it.environmentId == environmentId && it.projectId == projectId
  } ?: NewTaskBranchesUiState(environmentId = environmentId, projectId = projectId, loading = true)
  LaunchedEffect(worktree, projectBranchesState.refs, projectId) {
    if (worktree && baseBranch.isBlank()) {
      baseBranch = projectBranchesState.refs.firstOrNull { it.isDefault }?.name
        ?: projectBranchesState.refs.firstOrNull { it.current }?.name
        ?: ""
    }
  }
  val fallbackModelSelection = project?.defaultModelSelection
    ?: runtime.providerModels.firstOrNull { it.isDefault }?.let {
      ModelSelection(it.instanceId, it.model, it.optionsWith(null))
    }
    ?: runtime.providerModels.firstOrNull()?.let {
      ModelSelection(it.instanceId, it.model, it.optionsWith(null))
    }

  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    containerColor = Color(0xFF141417),
    contentColor = Color.White,
    shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    scrimColor = Color.Black.copy(alpha = 0.65f),
  ) {
    Column(Modifier.fillMaxWidth()) {
      DrawerHeader(
        icon = Icons.Rounded.EditNote,
        title = "New task",
        subtitle = "Start something in your workspace",
        onDismiss = onDismiss,
        showCloseButton = false,
      )
      DispatchFailure(dispatchState, viewModel::retryDispatch)
      NewTaskContextStrip(
        environments = runtime.environments,
        selectedEnvironmentId = environmentId,
        onSelectEnvironment = viewModel::selectEnvironment,
        projects = projects,
        selectedProjectId = projectId,
        onSelectProject = { projectId = it },
        onAddProject = onAddProject,
        worktree = worktree,
        onWorktreeChange = { worktree = it },
        branchesState = projectBranchesState,
        baseBranch = baseBranch,
        onBaseBranchChange = { baseBranch = it },
        startFromOrigin = startFromOrigin,
        onStartFromOriginChange = { startFromOrigin = it },
        runSetup = runSetup,
        onRunSetupChange = { runSetup = it },
        onRefreshBranches = { viewModel.loadNewTaskBranches(projectId, force = true) },
      )
      ChatComposerArea(
        defaultModelSelection = fallbackModelSelection,
        draft = draft,
        models = runtime.providerModels,
        lockProvider = false,
        queuedMessageCount = 0,
        active = false,
        placeholder = project?.let { "Describe a task in ${it.title}…" } ?: "Describe a task…",
        enabled = projectId.isNotBlank() && fallbackModelSelection != null &&
          (!worktree || baseBranch.isNotBlank()) && runtime.shell.sequence >= 0,
        sending = dispatchState is DispatchState.Sending,
        onDraftUpdate = { next ->
          draft = next
          viewModel.saveDraft(draftKey, next)
        },
        onAddAttachments = { viewModel.importDraftAttachments(draftKey, it) },
        onRemoveAttachment = { viewModel.removeDraftAttachment(draftKey, it) },
        onSend = {
          viewModel.createTask(
            projectId = projectId,
            draftKey = draftKey,
            draft = draft,
            worktree = WorktreeChoice(
              enabled = worktree,
              baseBranch = baseBranch,
              branch = "",
              startFromOrigin = startFromOrigin,
              runSetupScript = runSetup,
            ),
          )
        },
        onInterrupt = null,
      )
    }
  }
}

@Composable
private fun NewTaskContextStrip(
  environments: List<SavedEnvironment>,
  selectedEnvironmentId: String,
  onSelectEnvironment: (String) -> Unit,
  projects: List<Project>,
  selectedProjectId: String,
  onSelectProject: (String) -> Unit,
  onAddProject: () -> Unit,
  worktree: Boolean,
  onWorktreeChange: (Boolean) -> Unit,
  branchesState: NewTaskBranchesUiState,
  baseBranch: String,
  onBaseBranchChange: (String) -> Unit,
  startFromOrigin: Boolean,
  onStartFromOriginChange: (Boolean) -> Unit,
  runSetup: Boolean,
  onRunSetupChange: (Boolean) -> Unit,
  onRefreshBranches: () -> Unit,
) {
  var showProjects by remember { mutableStateOf(false) }
  var showEnvironments by remember { mutableStateOf(false) }
  var showWorkspace by remember { mutableStateOf(false) }
  var showBranches by remember { mutableStateOf(false) }
  val currentBranch = branchesState.refs.firstOrNull { it.current }?.name
  val workspaceLabel = if (worktree) "New worktree" else {
    currentBranch?.let { "Current · $it" } ?: "Current checkout"
  }

  Surface(
    shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 10.dp, bottomEnd = 10.dp),
    color = Color(0xFF1D1D21),
    border = BorderStroke(1.dp, Color(0xFF34343A)),
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box {
        NewTaskContextPill(
          icon = Icons.Rounded.FolderOpen,
          label = projects.firstOrNull { it.id == selectedProjectId }?.title ?: "Project",
          onClick = { showProjects = true },
        )
        ComposerOptionsMenu(showProjects, { showProjects = false }) {
          ComposerMenuSection("Project")
          projects.forEach { project ->
            ComposerMenuChoice(
              label = project.title,
              description = project.workspaceRoot,
              selected = project.id == selectedProjectId,
              onClick = {
                showProjects = false
                onSelectProject(project.id)
              },
            )
          }
          HorizontalDivider(color = Color(0xFF3F3F46))
          DropdownMenuItem(
            text = { Text("Add project") },
            leadingIcon = { Icon(Icons.Rounded.CreateNewFolder, contentDescription = null) },
            onClick = {
              showProjects = false
              onAddProject()
            },
          )
        }
      }

      Box {
        NewTaskContextPill(
          icon = Icons.Rounded.Public,
          label = environments.firstOrNull { it.environmentId == selectedEnvironmentId }?.label
            ?: "Environment",
          onClick = { showEnvironments = true },
        )
        ComposerOptionsMenu(showEnvironments, { showEnvironments = false }) {
          ComposerMenuSection("Environment")
          environments.forEach { environment ->
            ComposerMenuChoice(
              label = environment.label,
              selected = environment.environmentId == selectedEnvironmentId,
              onClick = {
                showEnvironments = false
                onSelectEnvironment(environment.environmentId)
              },
            )
          }
        }
      }

      Box {
        NewTaskContextPill(
          icon = Icons.Rounded.AccountTree,
          label = workspaceLabel,
          onClick = { showWorkspace = true },
        )
        ComposerOptionsMenu(showWorkspace, { showWorkspace = false }) {
          ComposerMenuSection("Workspace")
          ComposerMenuChoice(
            label = "Current checkout",
            selected = !worktree,
            onClick = {
              showWorkspace = false
              onWorktreeChange(false)
            },
          )
          ComposerMenuChoice(
            label = "New worktree",
            selected = worktree,
            onClick = {
              showWorkspace = false
              onWorktreeChange(true)
            },
          )
          if (worktree) {
            HorizontalDivider(color = Color(0xFF3F3F46))
            ComposerMenuChoice(
              label = "Start from origin",
              description = "Base the worktree on the latest origin branch",
              selected = startFromOrigin,
              onClick = {
                showWorkspace = false
                onStartFromOriginChange(!startFromOrigin)
              },
            )
            ComposerMenuChoice(
              label = "Run setup script",
              selected = runSetup,
              onClick = {
                showWorkspace = false
                onRunSetupChange(!runSetup)
              },
            )
          }
        }
      }

      if (worktree) {
        Box {
          NewTaskContextPill(
            icon = Icons.Rounded.AccountTree,
            label = when {
              branchesState.loading -> "Loading branches…"
              baseBranch.isNotBlank() -> baseBranch
              !branchesState.isRepo -> "Not a Git project"
              else -> "Choose branch"
            },
            onClick = { showBranches = true },
          )
          ComposerOptionsMenu(showBranches, { showBranches = false }) {
            ComposerMenuSection("Base branch")
            branchesState.refs.distinctBy { it.name }.forEach { branch ->
              ComposerMenuChoice(
                label = branch.name,
                description = when {
                  branch.isDefault -> "Default"
                  branch.current -> "Current"
                  branch.isRemote -> "Remote"
                  branch.worktreePath != null -> "Worktree"
                  else -> null
                },
                selected = branch.name == baseBranch,
                onClick = {
                  showBranches = false
                  onBaseBranchChange(branch.name)
                },
              )
            }
            if (!branchesState.loading && branchesState.refs.isEmpty()) {
              DropdownMenuItem(
                text = { Text(branchesState.error ?: "No branches available") },
                enabled = false,
                onClick = {},
              )
            }
            HorizontalDivider(color = Color(0xFF3F3F46))
            DropdownMenuItem(
              text = { Text("Refresh branches") },
              leadingIcon = { Icon(Icons.Rounded.Refresh, contentDescription = null) },
              onClick = {
                showBranches = false
                onRefreshBranches()
              },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun NewTaskContextPill(icon: ImageVector, label: String, onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(12.dp),
    color = Color(0xFF29292F),
    modifier = Modifier.height(34.dp),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
      Icon(icon, contentDescription = null, modifier = Modifier.size(15.dp))
      Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
      Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(14.dp))
    }
  }
}

@Composable
internal fun DrawerHeader(
  icon: ImageVector,
  title: String,
  subtitle: String,
  onDismiss: () -> Unit,
  showCloseButton: Boolean = true,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, bottom = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Surface(
      modifier = Modifier.size(44.dp),
      shape = RoundedCornerShape(14.dp),
      color = MaterialTheme.colorScheme.primaryContainer,
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
      }
    }
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
      Text(
        subtitle,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    if (showCloseButton) {
      IconButton(onClick = onDismiss) {
        Icon(Icons.Rounded.Close, contentDescription = "Close")
      }
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
            style = MaterialTheme.typography.titleMedium.copy(
              fontSize = (MaterialTheme.typography.titleMedium.fontSize.value - 0.5f).sp,
            ),
            fontWeight = FontWeight.SemiBold,
          )
        },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 40.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              TextButton(
                onClick = onGit,
                enabled = detail != null,
                modifier = Modifier.height(40.dp),
                contentPadding = PaddingValues(horizontal = 2.dp),
              ) {
                Icon(Icons.Rounded.AccountTree, contentDescription = null)
                Spacer(Modifier.width(4.dp))
                Text(
                  gitState.status?.refName ?: "Git",
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
              IconButton(
                onClick = onFiles,
                enabled = detail != null,
                modifier = Modifier.size(40.dp),
              ) {
                Icon(Icons.Rounded.FolderOpen, contentDescription = "Files")
              }
              IconButton(
                onClick = onTerminal,
                enabled = detail != null,
                modifier = Modifier.size(40.dp),
              ) {
                Icon(Icons.Rounded.Terminal, contentDescription = "Open terminal")
              }
            }
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
        SubcomposeLayout(Modifier.fillMaxSize()) { constraints ->
          val composer = subcompose("composer") {
            Column(Modifier.fillMaxWidth()) {
              ThreadRequests(detail, viewModel)
              DispatchFailure(dispatchState, viewModel::retryDispatch)
              ChatComposerArea(
                defaultModelSelection = detail.summary.modelSelection,
                contextWindowUsage = remember(detail.activities) {
                  deriveLatestContextWindowUsage(detail.activities)
                },
                draft = draft,
                models = runtime.providerModels,
                lockProvider = true,
                queuedMessageCount = runtime.pendingTasks.count {
                  it.threadId == threadId && !it.createsThread && it.status == PendingTaskStatus.Queued
                },
                active = detail.summary.session?.status in setOf("starting", "running"),
                placeholder = "Send a message…",
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
              )
            }
          }.single().measure(constraints.copy(minHeight = 0))
          val feed = subcompose("feed") {
            ThreadFeed(
              detail = detail,
              environmentId = environmentId,
              viewModel = viewModel,
              modifier = Modifier.fillMaxSize(),
              contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = 16.dp,
                bottom = composer.height.toDp() + 8.dp,
              ),
              bottomAnchorKey = composer.height,
            )
          }.single().measure(constraints)
          layout(constraints.maxWidth, constraints.maxHeight) {
            feed.placeRelative(0, 0)
            composer.placeRelative(0, constraints.maxHeight - composer.height)
          }
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
  bottomAnchorKey: Int = 0,
) {
  val context = LocalContext.current
  val markwon = remember(context) { createMarkdownRenderer(context) }
  val rawFeed = remember(detail.messages, detail.activities) { buildThreadFeed(detail) }
  val terminalAssistantMessageIds = remember(rawFeed) {
    buildMap<String, String> {
      rawFeed.filterIsInstance<ThreadFeedItem.Message>().forEach { entry ->
        val message = entry.message
        val turnId = message.turnId
        if (message.role == "assistant" && turnId != null) put(turnId, message.id)
      }
    }.values.toSet()
  }
  var expandedTurnIds by remember(detail.summary.id) { mutableStateOf(emptySet<String>()) }
  var expandedWorkGroupIds by remember(detail.summary.id) { mutableStateOf(emptySet<String>()) }
  var expandedActivityIds by remember(detail.summary.id) { mutableStateOf(emptySet<String>()) }
  var expandedPlanIds by remember(detail.summary.id) { mutableStateOf(emptySet<String>()) }
  var followBottom by remember(detail.summary.id) { mutableStateOf(true) }
  val layoutAnchor = remember(detail.summary.id) { intArrayOf(-1, -1) }
  val isFeedDragged by state.interactionSource.collectIsDraggedAsState()
  val latestTurn = detail.summary.latestTurn
  LaunchedEffect(latestTurn?.id, latestTurn?.state) {
    if (latestTurn?.state == "interrupted") expandedTurnIds += latestTurn.id
  }
  val activeWorkStartedAt = detail.summary.session?.takeIf {
    it.status == "starting" || it.status == "running"
  }?.let { latestTurn?.startedAt ?: it.updatedAt }
  val entries = remember(
    rawFeed,
    latestTurn,
    expandedTurnIds,
    expandedWorkGroupIds,
    activeWorkStartedAt,
  ) {
    presentThreadFeed(
      feed = rawFeed,
      latestTurn = latestTurn,
      expandedTurnIds = expandedTurnIds,
      expandedWorkGroupIds = expandedWorkGroupIds,
      activeWorkStartedAt = activeWorkStartedAt,
    )
  }
  val bottomFirstEntries = remember(entries) { entries.asReversed() }
  val shownEntryIds = remember(detail.summary.id) {
    entries.mapTo(mutableSetOf(), ThreadFeedItem::id)
  }
  LaunchedEffect(entries) {
    shownEntryIds.retainAll(entries.map(ThreadFeedItem::id).toSet())
  }
  LaunchedEffect(state, detail.summary.id) {
    snapshotFlow {
      Triple(state.firstVisibleItemIndex, state.firstVisibleItemScrollOffset, isFeedDragged)
    }.collectLatest { (firstIndex, firstOffset, isDragged) ->
      val atBottom = firstIndex == 0 && firstOffset == 0
      if (isDragged) {
        followBottom = atBottom
      } else if (atBottom) {
        followBottom = true
      }
    }
  }
  SideEffect {
    if (entries.isNotEmpty() && followBottom && !isFeedDragged) {
      state.requestScrollToItem(0)
    }
  }
  LazyColumn(
    state = state,
    modifier = modifier
      .fillMaxWidth()
      .layout { measurable, constraints ->
        if (layoutAnchor[0] != constraints.maxHeight || layoutAnchor[1] != bottomAnchorKey) {
          layoutAnchor[0] = constraints.maxHeight
          layoutAnchor[1] = bottomAnchorKey
          if (entries.isNotEmpty() && followBottom && !isFeedDragged) {
            state.requestScrollToItem(0)
          }
        }
        val placeable = measurable.measure(constraints)
        layout(placeable.width, placeable.height) {
          placeable.placeRelative(0, 0)
        }
      },
    reverseLayout = true,
    contentPadding = contentPadding,
    verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom),
  ) {
    items(bottomFirstEntries, key = ThreadFeedItem::id) { entry ->
      FreshFeedEntry(entry, shownEntryIds) {
        when (entry) {
            is ThreadFeedItem.Message -> {
              val message = entry.message
              if (message.text.isNotBlank() || message.attachments.isNotEmpty()) {
                if (message.role == "assistant") {
                  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (message.text.isNotBlank()) MarkdownMessage(message.text, markwon)
                    message.attachments.forEach { SentAttachmentImage(environmentId, it, viewModel) }
                    val turnStillRunning = latestTurn?.let {
                      message.turnId == it.id && (it.state == "running" || it.completedAt == null)
                    } == true
                    if (message.text.isNotBlank() && message.id in terminalAssistantMessageIds &&
                      !message.streaming && !turnStillRunning) {
                      MessageCopyButton(message.text)
                    }
                  }
                } else {
                  Column(horizontalAlignment = Alignment.End) {
                    Surface(
                      shape = RoundedCornerShape(16.dp),
                      color = if (message.role == "user") Color(0xFF172554) else MaterialTheme.colorScheme.surface,
                      modifier = Modifier.fillMaxWidth(),
                    ) {
                      Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (message.text.isNotBlank()) {
                          SelectionContainer { UserMessageContent(message.text) }
                        }
                        message.attachments.forEach { SentAttachmentImage(environmentId, it, viewModel) }
                      }
                    }
                    if (message.role == "user" && message.text.isNotBlank()) {
                      MessageCopyButton(message.text)
                    }
                  }
                }
              }
            }

            is ThreadFeedItem.TurnFold -> {
              Row(
                modifier = Modifier
                  .fillMaxWidth()
                  .clickable {
                    expandedTurnIds = if (entry.turnId in expandedTurnIds) {
                      expandedTurnIds - entry.turnId
                    } else {
                      expandedTurnIds + entry.turnId
                    }
                  }
                  .padding(vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
              ) {
                Icon(
                  Icons.Rounded.KeyboardArrowDown,
                  contentDescription = if (entry.expanded) "Collapse work" else "Expand work",
                  tint = MaterialTheme.colorScheme.onSurfaceVariant,
                  modifier = Modifier
                    .size(18.dp)
                    .graphicsLayer { rotationZ = if (entry.expanded) 180f else 0f },
                )
                Text(
                  entry.label,
                  style = MaterialTheme.typography.labelMedium,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
            }

            is ThreadFeedItem.ActivityGroup -> entry.activities.forEach { activity ->
              ThreadActivityRow(
                activity = activity,
                expanded = activity.id in expandedActivityIds,
                onToggle = {
                  expandedActivityIds = if (activity.id in expandedActivityIds) {
                    expandedActivityIds - activity.id
                  } else {
                    expandedActivityIds + activity.id
                  }
                },
                onCopy = {
                  val text = listOfNotNull(activity.summary, activity.detail, activity.expandedBody)
                    .distinct().joinToString("\n")
                  context.getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText("T3 activity", text))
                },
              )
            }

            is ThreadFeedItem.Plan -> ThreadPlanRow(
              plan = entry,
              expanded = entry.id in expandedPlanIds,
              onToggle = {
                expandedPlanIds = if (entry.id in expandedPlanIds) {
                  expandedPlanIds - entry.id
                } else {
                  expandedPlanIds + entry.id
                }
              },
            )

            is ThreadFeedItem.WorkToggle -> TextButton(
              onClick = {
                expandedWorkGroupIds = if (entry.groupId in expandedWorkGroupIds) {
                  expandedWorkGroupIds - entry.groupId
                } else {
                  expandedWorkGroupIds + entry.groupId
                }
              },
            ) {
              Text(if (entry.expanded) "Show less" else "${entry.hiddenCount} more")
            }

            is ThreadFeedItem.Working -> Row(
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              modifier = Modifier
                .padding(vertical = 7.dp),
            ) {
              LinearProgressIndicator(Modifier.width(28.dp).height(2.dp))
              Text(
                entry.stepLabel?.let { "Working… · $it" } ?: "Working…",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
            }
        }
      }
    }
  }
}

@Composable
private fun FreshFeedEntry(
  entry: ThreadFeedItem,
  shownEntryIds: MutableSet<String>,
  content: @Composable () -> Unit,
) {
  val shouldAnimate = remember(entry.id, entry.createdAt) {
    entry.id !in shownEntryIds && runCatching {
      Instant.now().toEpochMilli() - Instant.parse(entry.createdAt).toEpochMilli() < FRESH_MESSAGE_WINDOW_MILLIS
    }.getOrDefault(false)
  }
  var visible by remember(entry.id) { mutableStateOf(!shouldAnimate) }
  val rise = with(LocalDensity.current) { 10.dp.roundToPx() }
  LaunchedEffect(entry.id) {
    shownEntryIds += entry.id
    visible = true
  }
  AnimatedVisibility(
    visible = visible,
    enter = if (entry is ThreadFeedItem.Message && entry.message.role == "assistant") {
      fadeIn(tween(MESSAGE_ENTRY_MILLIS))
    } else {
      fadeIn(tween(MESSAGE_ENTRY_MILLIS)) + slideInVertically(
        animationSpec = tween(MESSAGE_ENTRY_MILLIS),
        initialOffsetY = { rise },
      )
    },
  ) {
    content()
  }
}

@Composable
private fun ThreadPlanRow(
  plan: ThreadFeedItem.Plan,
  expanded: Boolean,
  onToggle: () -> Unit,
) {
  val completedCount = plan.steps.count { it.status == ThreadPlanStepStatus.Completed }
  val allDone = completedCount == plan.steps.size
  val success = Color(0xFF4ADE80)
  val active = MaterialTheme.colorScheme.primary
  val pending = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)

  Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp)) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .clickable(onClick = onToggle)
        .padding(horizontal = 2.dp, vertical = 3.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Icon(
        Icons.Rounded.KeyboardArrowDown,
        contentDescription = if (expanded) "Collapse plan" else "Expand plan",
        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
        modifier = Modifier
          .size(16.dp)
          .graphicsLayer { rotationZ = if (expanded) 0f else -90f },
      )
      if (plan.steps.size > 1) {
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
          plan.steps.forEach { step ->
            Box(
              Modifier
                .width(10.dp)
                .height(3.dp)
                .background(
                  when (step.status) {
                    ThreadPlanStepStatus.Completed -> success
                    ThreadPlanStepStatus.InProgress -> active
                    ThreadPlanStepStatus.Pending -> pending
                  },
                  CircleShape,
                ),
            )
          }
        }
      }
      Text(
        plan.currentStepLabel,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = if (allDone) FontWeight.Normal else FontWeight.Medium,
        color = if (allDone) {
          MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f)
        } else {
          MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f)
        },
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      if (plan.steps.size > 1) {
        Text(
          "$completedCount/${plan.steps.size}",
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
        )
      }
    }
    if (expanded) {
      Column(Modifier.padding(start = 24.dp, top = 2.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        plan.steps.forEach { step ->
          val color = when (step.status) {
            ThreadPlanStepStatus.Completed -> success
            ThreadPlanStepStatus.InProgress -> active
            ThreadPlanStepStatus.Pending -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
          }
          Row(
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(vertical = 2.dp),
          ) {
            Text(
              when (step.status) {
                ThreadPlanStepStatus.Completed -> "✓"
                ThreadPlanStepStatus.InProgress -> "●"
                ThreadPlanStepStatus.Pending -> "○"
              },
              color = color,
              style = MaterialTheme.typography.labelSmall,
              modifier = Modifier.width(14.dp),
            )
            Text(
              step.step,
              style = MaterialTheme.typography.bodySmall,
              color = when (step.status) {
                ThreadPlanStepStatus.Completed -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                ThreadPlanStepStatus.InProgress -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.92f)
                ThreadPlanStepStatus.Pending -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f)
              },
              modifier = Modifier.weight(1f),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ThreadActivityRow(
  activity: ThreadFeedActivity,
  expanded: Boolean,
  onToggle: () -> Unit,
  onCopy: () -> Unit,
) {
  val statusColor = when (activity.status) {
    ThreadFeedActivityStatus.Success -> Color(0xFF4ADE80)
    ThreadFeedActivityStatus.Failure -> MaterialTheme.colorScheme.error
    ThreadFeedActivityStatus.Neutral, null -> MaterialTheme.colorScheme.onSurfaceVariant
  }
  Surface(
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(10.dp),
    modifier = Modifier.fillMaxWidth().clickable(
      enabled = activity.canExpand,
      onClick = onToggle,
    ),
  ) {
    Column(Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
          when (activity.icon) {
            ThreadFeedActivityIcon.Agent -> Icons.Rounded.SmartToy
            ThreadFeedActivityIcon.Check -> Icons.Rounded.Check
            ThreadFeedActivityIcon.Command -> Icons.Rounded.Terminal
            ThreadFeedActivityIcon.Edit -> Icons.Rounded.EditNote
            ThreadFeedActivityIcon.Eye -> Icons.Rounded.Visibility
            ThreadFeedActivityIcon.Globe -> Icons.Rounded.Public
            ThreadFeedActivityIcon.Message -> Icons.Rounded.ChatBubbleOutline
            ThreadFeedActivityIcon.Warning -> Icons.Rounded.WarningAmber
            ThreadFeedActivityIcon.Wrench -> Icons.Rounded.Build
            ThreadFeedActivityIcon.Generic -> Icons.Rounded.Bolt
          },
          contentDescription = activity.icon.name,
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
          Text(activity.summary, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
          activity.detail?.takeIf { !expanded }?.let {
            Text(
              it,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        if (activity.canExpand) {
          Icon(
            Icons.Rounded.KeyboardArrowDown,
            contentDescription = if (expanded) "Collapse tool details" else "Expand tool details",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
              .size(16.dp)
              .graphicsLayer { rotationZ = if (expanded) 0f else -90f },
          )
        }
        if (activity.status != null) {
          Icon(
            if (activity.status == ThreadFeedActivityStatus.Failure) Icons.Rounded.Clear else Icons.Rounded.Check,
            contentDescription = when (activity.status) {
              ThreadFeedActivityStatus.Success -> "Completed"
              ThreadFeedActivityStatus.Failure -> "Failed"
              ThreadFeedActivityStatus.Neutral -> "In progress"
            },
            tint = statusColor,
            modifier = Modifier.size(15.dp),
          )
        }
        IconButton(onClick = onCopy, modifier = Modifier.size(30.dp)) {
          Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy activity", modifier = Modifier.size(15.dp))
        }
      }
      if (expanded) {
        SelectionContainer {
          Text(
            activity.expandedBody.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 24.dp, top = 6.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun MessageCopyButton(text: String, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  var copied by remember(text) { mutableStateOf(false) }
  LaunchedEffect(copied) {
    if (copied) {
      delay(1_200)
      copied = false
    }
  }
  IconButton(
    onClick = {
      context.getSystemService(ClipboardManager::class.java)
        .setPrimaryClip(ClipData.newPlainText("T3 message", text))
      copied = true
    },
    modifier = modifier.size(28.dp),
  ) {
    Icon(
      if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
      contentDescription = if (copied) "Copied" else "Copy message",
      tint = if (copied) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.size(14.dp),
    )
  }
}

@Composable
private fun UserMessageContent(text: String, modifier: Modifier = Modifier) {
  val segments = remember(text) { parseReviewMessageSegments(text) }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    segments.forEach { segment ->
      when (segment) {
        is ReviewMessageSegment.Text -> segment.value.trim().takeIf(String::isNotEmpty)?.let {
          Text(it, fontSize = 15.sp)
        }
        is ReviewMessageSegment.Comment -> ReviewCommentCard(segment.value)
      }
    }
  }
}

@Composable
private fun MarkdownMessage(markdown: String, markwon: Markwon) {
  val rendered by produceState<RenderedMarkdown?>(null, markdown, markwon) {
    val content = withContext(markdownRenderDispatcher) {
      markwon.toMarkdown(markdown)
    }
    value = RenderedMarkdown(markdown, content)
  }
  AndroidView(
    factory = {
      TextView(it).apply {
        setTextColor(android.graphics.Color.rgb(229, 229, 229))
        setTextIsSelectable(true)
        movementMethod = LinkMovementMethod.getInstance()
        textSize = 15f
        includeFontPadding = false
        setLineSpacing(0f, 1.27f)
        setPadding(4, 6, 4, 6)
      }
    },
    update = { textView ->
      rendered?.takeIf { it.source == markdown && textView.tag != it.source }?.let {
        textView.tag = it.source
        markwon.setParsedMarkdown(textView, it.content)
      }
    },
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

private data class ComposerSlashTrigger(val start: Int, val query: String)

private data class ComposerSlashSuggestion(
  val name: String,
  val description: String,
  val opensModelMenu: Boolean = false,
)

private val ComposerSlashPattern = Regex("(?:^|\\s)/([^\\s/]*)$")

private fun composerSlashTrigger(text: String): ComposerSlashTrigger? {
  val match = ComposerSlashPattern.find(text) ?: return null
  val slashOffset = match.value.lastIndexOf('/')
  return ComposerSlashTrigger(
    start = match.range.first + slashOffset,
    query = match.groupValues[1],
  )
}

private fun replaceComposerSlashTrigger(
  text: String,
  trigger: ComposerSlashTrigger,
  replacement: String,
) = text.replaceRange(trigger.start, text.length, replacement)

private fun JsonElement?.providerOptionValues(): Map<String, JsonPrimitive> = when (this) {
  is JsonArray -> mapNotNull { element ->
    val item = element as? JsonObject ?: return@mapNotNull null
    val id = (item["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
    val value = item["value"] as? JsonPrimitive ?: return@mapNotNull null
    id to value
  }.toMap()
  is JsonObject -> mapNotNull { (id, value) ->
    (value as? JsonPrimitive)?.let { id to it }
  }.toMap()
  else -> emptyMap()
}

private fun ProviderOptionDescriptor.valueFrom(options: JsonElement?): JsonPrimitive? =
  options.providerOptionValues()[id]
    ?: currentValue
    ?: choices.firstOrNull { it.isDefault }?.let { JsonPrimitive(it.id) }

private fun ProviderModel.optionsWith(
  current: JsonElement?,
  changedId: String? = null,
  changedValue: JsonPrimitive? = null,
): JsonArray? {
  val selections = optionDescriptors.mapNotNull { descriptor ->
    val value = (if (descriptor.id == changedId) changedValue else descriptor.valueFrom(current))
      ?: return@mapNotNull null
    buildJsonObject {
      put("id", JsonPrimitive(descriptor.id))
      put("value", value)
    }
  }
  return selections.takeIf(List<*>::isNotEmpty)?.let(::JsonArray)
}

private fun ProviderOptionDescriptor.currentLabel(options: JsonElement?): String? {
  val value = valueFrom(options) ?: return null
  return if (type == "boolean") {
    if (value.booleanOrNull == true) "On" else "Off"
  } else {
    choices.firstOrNull { it.id == value.contentOrNull }?.label
  }
}

private fun ProviderOptionDescriptor.isSpeedOption() = id == "fastMode" ||
  (id == "serviceTier" && choices.any { it.label.equals("Fast", ignoreCase = true) })

private fun ProviderOptionDescriptor.fastEnabled(options: JsonElement?): Boolean = when {
  id == "fastMode" -> valueFrom(options)?.booleanOrNull == true
  id == "serviceTier" -> {
    val current = valueFrom(options)?.contentOrNull
    choices.firstOrNull { it.id == current }?.label.equals("Fast", ignoreCase = true)
  }
  else -> false
}

private fun traitsTriggerLabel(
  descriptors: List<ProviderOptionDescriptor>,
  options: JsonElement?,
): Pair<String, Boolean> {
  val fast = descriptors.any { it.isSpeedOption() && it.fastEnabled(options) }
  val labels = descriptors.filterNot(ProviderOptionDescriptor::isSpeedOption)
    .mapNotNull { it.currentLabel(options) }
    .toMutableList()
  if (fast) labels += "Fast"
  if (labels.isEmpty()) labels += if (descriptors.any(ProviderOptionDescriptor::isSpeedOption)) "Standard" else "Options"
  return labels.joinToString(" · ") to fast
}

private fun runtimeModeLabel(mode: String) = when (mode) {
  "approval-required" -> "Supervised"
  "auto-accept-edits" -> "Auto-accept edits"
  "auto" -> "Auto"
  else -> "Full access"
}

private fun runtimeModeDescription(mode: String) = when (mode) {
  "approval-required" -> "Ask before commands and file changes"
  "auto-accept-edits" -> "Approve edits, ask before other actions"
  "auto" -> "Approve routine supported actions"
  else -> "Allow commands and edits without prompts"
}

private fun runtimeModeIcon(mode: String): ImageVector = when (mode) {
  "approval-required" -> Icons.Rounded.Shield
  "auto-accept-edits" -> Icons.Rounded.EditNote
  "auto" -> Icons.Rounded.AutoAwesome
  else -> Icons.Rounded.LockOpen
}

@Composable
private fun ComposerOptionsMenu(
  expanded: Boolean,
  onDismissRequest: () -> Unit,
  content: @Composable ColumnScope.() -> Unit,
) {
  DropdownMenu(
    expanded = expanded,
    onDismissRequest = onDismissRequest,
    modifier = Modifier.widthIn(min = 240.dp, max = 320.dp),
    shape = RoundedCornerShape(20.dp),
    containerColor = Color(0xFF1C1C1F),
    tonalElevation = 6.dp,
    shadowElevation = 12.dp,
    border = BorderStroke(1.dp, Color(0xFF3F3F46)),
    content = content,
  )
}

@Composable
private fun ComposerMenuSection(title: String) {
  Text(
    title,
    style = MaterialTheme.typography.labelSmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
  )
}

@Composable
private fun ComposerMenuChoice(
  label: String,
  description: String? = null,
  selected: Boolean,
  icon: ImageVector? = null,
  onClick: () -> Unit,
) {
  DropdownMenuItem(
    text = {
      Column {
        Text(label, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
        description?.let {
          Text(
            it,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    },
    onClick = onClick,
    leadingIcon = icon?.let { imageVector ->
      {
        Icon(
          imageVector,
          contentDescription = null,
          tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    },
    trailingIcon = {
      if (selected) {
        Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
      }
    },
    modifier = Modifier
      .padding(horizontal = 6.dp, vertical = 2.dp)
      .clip(RoundedCornerShape(14.dp))
      .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 5.dp),
  )
}

@Composable
private fun ComposerModelChoice(
  model: ProviderModel,
  selectedInstanceId: String?,
  selectedModelId: String?,
  selectedOptions: JsonElement?,
  draft: ComposerDraft,
  onSelect: (ComposerDraft) -> Unit,
) {
  val selected = model.instanceId == selectedInstanceId && model.model == selectedModelId
  ComposerMenuChoice(
    label = model.modelLabel,
    description = model.providerLabel,
    selected = selected,
    onClick = {
      onSelect(
        draft.copy(
          modelInstanceId = model.instanceId,
          model = model.model,
          modelOptions = if (selected) selectedOptions else model.optionsWith(null),
        ),
      )
    },
  )
}

@Composable
private fun ChatComposerArea(
  defaultModelSelection: ModelSelection?,
  contextWindowUsage: ContextWindowUsage? = null,
  draft: ComposerDraft,
  models: List<ProviderModel>,
  lockProvider: Boolean,
  queuedMessageCount: Int,
  active: Boolean,
  placeholder: String,
  enabled: Boolean,
  sending: Boolean,
  onDraftUpdate: (ComposerDraft) -> Unit,
  onAddAttachments: (List<Uri>) -> Unit,
  onRemoveAttachment: (String) -> Unit,
  onSend: () -> Unit,
  onInterrupt: (() -> Unit)?,
) {
  var showModelMenu by remember { mutableStateOf(false) }
  var showAccessMenu by remember { mutableStateOf(false) }
  var showTraitsMenu by remember { mutableStateOf(false) }

  var expandedProviderId by remember { mutableStateOf<String?>(null) }

  val defaultInstanceId = defaultModelSelection?.instanceId
  val availableModels = remember(defaultInstanceId, models, lockProvider) {
    if (lockProvider && defaultInstanceId != null) {
      resolveThreadProviderModels(defaultInstanceId, models)
    } else {
      models
    }
  }

  val selectedInstanceId = draft.modelInstanceId ?: defaultModelSelection?.instanceId
  val selectedModelId = draft.model ?: defaultModelSelection?.model
  val selectedModel = availableModels.firstOrNull {
    it.instanceId == selectedInstanceId && it.model == selectedModelId
  } ?: availableModels.firstOrNull { it.isDefault } ?: availableModels.firstOrNull()
  val providerGroups = remember(availableModels, selectedModel?.instanceId) {
    availableModels.groupBy(ProviderModel::instanceId).values.sortedBy { group ->
      if (group.firstOrNull()?.instanceId == selectedModel?.instanceId) 0 else 1
    }
  }
  val selectedOptions = if (draft.modelInstanceId != null && draft.model != null) {
    draft.modelOptions
  } else {
    defaultModelSelection?.options
  }
  val plainText = plainReviewMessageText(draft.text)
  val slashTrigger = composerSlashTrigger(plainText)
  val slashSuggestions = remember(slashTrigger, selectedModel) {
    val query = slashTrigger?.query?.lowercase() ?: return@remember emptyList()
    buildList {
      if ("model".contains(query)) {
        add(ComposerSlashSuggestion("model", "Switch model", opensModelMenu = true))
      }
      selectedModel?.slashCommands.orEmpty().forEach { command ->
        if (command.name.lowercase().contains(query)) {
          add(
            ComposerSlashSuggestion(
              name = command.name,
              description = command.description ?: command.inputHint ?: "Run provider command",
            ),
          )
        }
      }
    }.distinctBy { it.name.lowercase() }
  }

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    if (slashTrigger != null && slashSuggestions.isNotEmpty()) {
      Surface(
        shape = RoundedCornerShape(14.dp),
        color = Color(0xFF1C1C1F),
        border = BorderStroke(1.dp, Color(0xFF3F3F46)),
        modifier = Modifier
          .fillMaxWidth()
          .padding(bottom = 8.dp),
      ) {
        Column(Modifier.padding(vertical = 5.dp)) {
          Text(
            "Commands",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
          )
          slashSuggestions.take(6).forEach { suggestion ->
            Row(
              modifier = Modifier
                .fillMaxWidth()
                .clickable {
                  val replacement = if (suggestion.opensModelMenu) "" else "/${suggestion.name} "
                  val nextText = replaceComposerSlashTrigger(plainText, slashTrigger, replacement)
                  onDraftUpdate(draft.copy(text = replacePlainReviewMessageText(draft.text, nextText)))
                  if (suggestion.opensModelMenu) showModelMenu = true
                }
                .padding(horizontal = 12.dp, vertical = 9.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              Icon(
                Icons.Rounded.Terminal,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
              )
              Text(
                "/${suggestion.name}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
              )
              Text(
                suggestion.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
              )
            }
          }
        }
      }
    }
    val composerShape = RoundedCornerShape(20.dp)
    Box(
      modifier = Modifier.fillMaxWidth(),
    ) {
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
                    if (enabled) placeholder else "Waiting for sync…",
                    color = Color(0xFF71717A),
                    style = MaterialTheme.typography.bodyMedium,
                  )
                }
                innerTextField()
              }
            },
            modifier = Modifier.fillMaxWidth(),
          )

          // Bottom action bar
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            // Left side: attachments and server-driven settings
            Row(
              horizontalArrangement = Arrangement.spacedBy(6.dp),
              verticalAlignment = Alignment.CenterVertically,
              modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            ) {
              ComposerAttachmentButtons(
                existingCount = draft.attachments.size,
                onAdd = onAddAttachments,
                enabled = !sending,
              )
              // Model selector
              Box {
                Surface(
                  onClick = {
                    expandedProviderId = selectedModel?.instanceId
                    showModelMenu = true
                  },
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

                ComposerOptionsMenu(
                  expanded = showModelMenu,
                  onDismissRequest = { showModelMenu = false },
                ) {
                  if (lockProvider) {
                    ComposerMenuSection("Models")
                    availableModels.forEach { model ->
                      ComposerModelChoice(
                        model = model,
                        selectedInstanceId = selectedInstanceId,
                        selectedModelId = selectedModelId,
                        selectedOptions = selectedOptions,
                        onSelect = { next ->
                          showModelMenu = false
                          onDraftUpdate(next)
                        },
                        draft = draft,
                      )
                    }
                  } else {
                    ComposerMenuSection("Providers")
                    providerGroups.forEach { group ->
                      val provider = group.first()
                      val expanded = provider.instanceId == expandedProviderId
                      DropdownMenuItem(
                        text = {
                          Column {
                            Text(provider.providerLabel, fontWeight = FontWeight.SemiBold)
                            Text(
                              "${group.size} model${if (group.size == 1) "" else "s"}",
                              style = MaterialTheme.typography.bodySmall,
                              color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                          }
                        },
                        onClick = {
                          expandedProviderId = provider.instanceId.takeUnless { expanded }
                        },
                        leadingIcon = {
                          Icon(Icons.Rounded.SmartToy, contentDescription = null)
                        },
                        trailingIcon = {
                          Icon(
                            Icons.Rounded.KeyboardArrowDown,
                            contentDescription = null,
                            modifier = Modifier.graphicsLayer { rotationZ = if (expanded) 180f else 0f },
                          )
                        },
                      )
                      if (expanded) {
                        group.forEach { model ->
                          ComposerModelChoice(
                            model = model,
                            selectedInstanceId = selectedInstanceId,
                            selectedModelId = selectedModelId,
                            selectedOptions = selectedOptions,
                            onSelect = { next ->
                              showModelMenu = false
                              onDraftUpdate(next)
                            },
                            draft = draft,
                          )
                        }
                      }
                    }
                  }
                }
              }

              selectedModel?.takeIf { it.optionDescriptors.isNotEmpty() }?.let { optionModel ->
                val (traitsLabel, fastEnabled) = traitsTriggerLabel(optionModel.optionDescriptors, selectedOptions)
                Box {
                  Surface(
                    onClick = { showTraitsMenu = true },
                    shape = RoundedCornerShape(12.dp),
                    color = Color(0xFF27272A),
                    modifier = Modifier.height(30.dp),
                  ) {
                    Row(
                      modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                      verticalAlignment = Alignment.CenterVertically,
                      horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                      if (fastEnabled) {
                        Icon(
                          Icons.Rounded.Bolt,
                          contentDescription = "Fast mode",
                          tint = MaterialTheme.colorScheme.primary,
                          modifier = Modifier.size(14.dp),
                        )
                      }
                      Text(
                        traitsLabel,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                      )
                      Icon(
                        Icons.Rounded.KeyboardArrowDown,
                        contentDescription = "Model options",
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                      )
                    }
                  }
                  ComposerOptionsMenu(
                    expanded = showTraitsMenu,
                    onDismissRequest = { showTraitsMenu = false },
                  ) {
                    optionModel.optionDescriptors.forEachIndexed { index, descriptor ->
                      if (index > 0) {
                        HorizontalDivider(
                          color = Color(0xFF3F3F46),
                          modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                      }
                      ComposerMenuSection(if (descriptor.isSpeedOption()) "Speed" else descriptor.label)
                      val currentValue = descriptor.valueFrom(selectedOptions)
                      if (descriptor.type == "select") {
                        descriptor.choices.filterNot {
                          it.id in descriptor.promptInjectedValues || it.id == "ultracode"
                        }.forEach { choice ->
                          val isSelected = choice.id == currentValue?.contentOrNull
                          ComposerMenuChoice(
                            label = choice.label,
                            selected = isSelected,
                            icon = if (descriptor.isSpeedOption() && choice.label.equals("Fast", true)) {
                              Icons.Rounded.Bolt
                            } else {
                              null
                            },
                            onClick = {
                              showTraitsMenu = false
                              onDraftUpdate(
                                draft.copy(
                                  modelInstanceId = optionModel.instanceId,
                                  model = optionModel.model,
                                  modelOptions = optionModel.optionsWith(
                                    selectedOptions,
                                    descriptor.id,
                                    JsonPrimitive(choice.id),
                                  ),
                                ),
                              )
                            },
                          )
                        }
                      } else if (descriptor.type == "boolean") {
                        val currentBoolean = currentValue?.booleanOrNull ?: false
                        val labels = if (descriptor.isSpeedOption()) {
                          listOf(false to "Standard", true to "Fast")
                        } else {
                          listOf(false to "Off", true to "On")
                        }
                        labels.forEach { (value, label) ->
                          val isSelected = currentBoolean == value
                          ComposerMenuChoice(
                            label = label,
                            selected = isSelected,
                            icon = if (descriptor.isSpeedOption() && value) Icons.Rounded.Bolt else null,
                            onClick = {
                              showTraitsMenu = false
                              onDraftUpdate(
                                draft.copy(
                                  modelInstanceId = optionModel.instanceId,
                                  model = optionModel.model,
                                  modelOptions = optionModel.optionsWith(
                                    selectedOptions,
                                    descriptor.id,
                                    JsonPrimitive(value),
                                  ),
                                ),
                              )
                            },
                          )
                        }
                      }
                    }
                  }
                }
              }

              // Access mode
              val accessLabel = runtimeModeLabel(draft.runtimeMode)
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
                      imageVector = runtimeModeIcon(draft.runtimeMode),
                      contentDescription = null,
                      modifier = Modifier.size(14.dp),
                      tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                      text = accessLabel,
                      style = MaterialTheme.typography.labelMedium,
                      fontWeight = FontWeight.SemiBold,
                      color = Color.White,
                    )
                  }
                }

                ComposerOptionsMenu(
                  expanded = showAccessMenu,
                  onDismissRequest = { showAccessMenu = false },
                ) {
                  ComposerMenuSection("Runtime")
                  listOf("approval-required", "auto-accept-edits", "auto", "full-access").forEach { key ->
                    val isSel = draft.runtimeMode == key
                    ComposerMenuChoice(
                      label = runtimeModeLabel(key),
                      description = runtimeModeDescription(key),
                      selected = isSel,
                      icon = runtimeModeIcon(key),
                      onClick = {
                        showAccessMenu = false
                        onDraftUpdate(draft.copy(runtimeMode = key))
                      },
                    )
                  }
                }
              }
            }

            // Right side: Stop and Send/Queue
            Row(
              horizontalArrangement = Arrangement.spacedBy(6.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              if (active) {
                IconButton(
                  onClick = { onInterrupt?.invoke() },
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
              }
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
                  contentDescription = if (active || queuedMessageCount > 0) "Queue message" else "Send message",
                  tint = if (canSend) Color.White else Color(0xFF71717A),
                  modifier = Modifier.size(18.dp),
                )
              }
            }
          }
        }
      }
      contextWindowUsage?.let { usage ->
        Box(Modifier.matchParentSize()) {
          ContextWindowMeter(
            usage = usage,
            modifier = Modifier
              .align(Alignment.BottomEnd)
              .height(116.dp)
              .offset(x = 14.dp),
          )
        }
      }
    }
    if (queuedMessageCount > 0) {
      Text(
        "$queuedMessageCount queued message${if (queuedMessageCount == 1) "" else "s"} will send automatically",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 6.dp, top = 5.dp),
      )
    }
  }
}

@Composable
private fun ContextWindowMeter(
  usage: ContextWindowUsage,
  modifier: Modifier = Modifier,
) {
  val fillColor = if (usage.usedPercentage > 90f) {
    MaterialTheme.colorScheme.error
  } else {
    Color(0xFFA1A1AA)
  }
  Column(
    modifier = modifier.width(20.dp).padding(vertical = 2.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Box(
      modifier = Modifier
        .weight(1f)
        .width(3.dp)
        .clip(RoundedCornerShape(50))
        .background(Color(0xFF27272A)),
    ) {
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .fillMaxHeight(usage.fraction)
          .align(Alignment.BottomCenter)
          .background(fillColor),
      )
    }
    Text(
      text = usage.label,
      color = if (usage.usedPercentage > 90f) fillColor else Color(0xFFA1A1AA),
      fontSize = 9.sp,
      lineHeight = 10.sp,
      maxLines = 1,
    )
  }
}

@Composable
private fun ComposerAttachmentActions(
  draft: ComposerDraft,
  onAdd: (List<Uri>) -> Unit,
  onRemove: (String) -> Unit,
  enabled: Boolean = true,
) {
  ComposerAttachmentStrip(draft.attachments, onRemove, removable = enabled)
  ComposerAttachmentButtons(draft.attachments.size, onAdd, enabled)
}

@Composable
private fun ComposerAttachmentButtons(
  existingCount: Int,
  onAdd: (List<Uri>) -> Unit,
  enabled: Boolean = true,
) {
  val picker = rememberLauncherForActivityResult(
    ActivityResultContracts.PickMultipleVisualMedia(MaxComposerAttachments),
    onAdd,
  )
  CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 36.dp) {
    IconButton(
      onClick = {
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
      },
      enabled = enabled && existingCount < MaxComposerAttachments,
      modifier = Modifier.size(36.dp),
    ) {
      Icon(Icons.Rounded.PhotoLibrary, contentDescription = "Add images")
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
