@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import android.content.ClipboardManager
import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Clear
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CreateNewFolder
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.FilterList
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.TextFields
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import kotlin.math.abs
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
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.withTransform
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
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
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
import com.t3tools.android.protocol.ThreadPage
import com.t3tools.android.protocol.ThreadSummary
import com.t3tools.android.protocol.VcsRef
import com.t3tools.android.protocol.ChatImageAttachment
import com.t3tools.android.protocol.ChatMessage
import com.t3tools.android.protocol.DEFAULT_TERMINAL_ID
import com.t3tools.android.protocol.nextTerminalId
import coil.compose.AsyncImage
import java.io.File
import java.time.Instant
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.delay
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
private const val T3_WORDMARK_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
private const val ARCHIVED_THREADS = "settings/archived"
private const val USAGE = "settings/usage"
private const val SETTINGS_ENVIRONMENTS = "settings/environments"
private const val PROJECT_GROUPING = "settings/project-grouping"
private const val APPEARANCE = "settings/appearance"
private const val CLIENT_STORAGE = "settings/storage"
private const val LEGAL = "settings/legal"
private const val THREAD = "thread/{threadId}"
private const val THREAD_FILES = "thread/{threadId}/files"
private const val THREAD_GIT_COMMIT = "thread/{threadId}/git/commit"
private const val THREAD_GIT_BRANCHES = "thread/{threadId}/git/branches"
private const val MESSAGE_ENTRY_MILLIS = 220
private const val FRESH_MESSAGE_WINDOW_MILLIS = 3_000
private const val PAGE_TRANSITION_MILLIS = 220

private data class NewTaskDrawerState(val projectId: String?)
private const val THREAD_TERMINAL = "thread/{threadId}/terminal/{terminalId}"
private const val THREAD_REVIEW = "thread/{threadId}/review"

private fun isWorkspaceRoute(route: String?): Boolean = when (route) {
  HOME,
  THREAD,
  THREAD_FILES,
  THREAD_GIT_COMMIT,
  THREAD_GIT_BRANCHES,
  THREAD_TERMINAL,
  THREAD_REVIEW,
  -> true
  else -> false
}

private enum class HomePane { Screen, Sidebar }

@Composable
private fun WideWorkspaceEmptyDetail(onNewTask: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(
      modifier = Modifier.widthIn(max = 360.dp).padding(32.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Icon(
        Icons.Rounded.ChatBubbleOutline,
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(36.dp),
      )
      Text("Select a thread", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
      Text(
        "Choose a thread from the sidebar or start a new task.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
      )
      Button(onClick = onNewTask) {
        Icon(painterResource(R.drawable.ic_new_task), contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("New Task")
      }
    }
  }
}

@Composable
fun T3NativeApp(viewModel: AppViewModel) {
  val runtime by viewModel.runtime.collectAsState()
  val dispatchState by viewModel.dispatchState.collectAsState()
  val gitState by viewModel.gitState.collectAsState()
  val incomingShares by viewModel.incomingShares.collectAsState()
  val navController = rememberNavController()
  val currentBackStackEntry by navController.currentBackStackEntryAsState()
  val start = remember { if (runtime.environment == null) ONBOARDING else HOME }
  var newTaskDrawer by remember { mutableStateOf<NewTaskDrawerState?>(null) }
  var gitDrawerThreadId by remember { mutableStateOf<String?>(null) }
  var reopenGitDrawerThreadId by remember { mutableStateOf<String?>(null) }
  var homeListTopRequest by remember { mutableIntStateOf(0) }

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
          if (!event.clearEntryRoute) homeListTopRequest += 1
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

  BoxWithConstraints(Modifier.fillMaxSize()) {
    val adaptiveLayout = remember(maxWidth, maxHeight) {
      deriveAdaptiveWorkspaceLayout(maxWidth.value, maxHeight.value)
    }
    val workspaceSplit = adaptiveLayout.usesSplitView &&
      isWorkspaceRoute(currentBackStackEntry?.destination?.route)
    val navigateToThread: (String) -> Unit = { threadId ->
      if (workspaceSplit) {
        val alreadyOpen = currentBackStackEntry?.destination?.route == THREAD &&
          runtime.selectedThreadId == threadId
        if (!alreadyOpen) {
          navController.navigate("thread/${Uri.encode(threadId)}") {
            popUpTo(HOME)
            launchSingleTop = true
          }
        }
      } else {
        navController.navigate("thread/${Uri.encode(threadId)}")
      }
    }

    Row(Modifier.fillMaxSize()) {
      if (workspaceSplit) {
        HomeScreen(
          runtime = runtime,
          dispatchState = dispatchState,
          viewModel = viewModel,
          homeListTopRequest = homeListTopRequest,
          onNewTask = {
            reopenGitDrawerThreadId = null
            newTaskDrawer = NewTaskDrawerState(null)
          },
          onOpenThread = navigateToThread,
          pendingShares = incomingShares,
          onOpenShare = { navController.navigate("share/${Uri.encode(it)}") },
          onAddEnvironment = { navController.navigate(ONBOARDING) },
          onSettings = { navController.navigate(SETTINGS) },
          pane = HomePane.Sidebar,
          selectedThreadId = runtime.selectedThreadId,
          modifier = Modifier.width(requireNotNull(adaptiveLayout.sidebarWidth).dp).fillMaxHeight(),
        )
        VerticalDivider(color = Color(0xFF27272A), modifier = Modifier.fillMaxHeight())
      }
      Box(Modifier.weight(1f).fillMaxHeight()) {
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
      if (workspaceSplit) {
        WideWorkspaceEmptyDetail(
          onNewTask = {
            reopenGitDrawerThreadId = null
            newTaskDrawer = NewTaskDrawerState(null)
          },
        )
      } else {
        HomeScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        homeListTopRequest = homeListTopRequest,
        onNewTask = {
          reopenGitDrawerThreadId = null
          newTaskDrawer = NewTaskDrawerState(null)
        },
        onOpenThread = navigateToThread,
        pendingShares = incomingShares,
        onOpenShare = { navController.navigate("share/${Uri.encode(it)}") },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
        onSettings = { navController.navigate(SETTINGS) },
        )
      }
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
        onAddProject = { navController.navigate(ADD_PROJECT) },
        onOpenEnvironments = { navController.navigate(SETTINGS_ENVIRONMENTS) },
        onOpenArchivedThreads = { navController.navigate(ARCHIVED_THREADS) },
        onOpenUsage = { navController.navigate(USAGE) },
        onOpenProjectGrouping = { navController.navigate(PROJECT_GROUPING) },
        onOpenAppearance = { navController.navigate(APPEARANCE) },
        onOpenClientStorage = { navController.navigate(CLIENT_STORAGE) },
        onOpenLegal = { navController.navigate(LEGAL) },
      )
    }
    composable(SETTINGS_ENVIRONMENTS) {
      EnvironmentSettingsScreen(
        runtime = runtime,
        dispatchState = dispatchState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
        onAddEnvironment = { navController.navigate(ONBOARDING) },
      )
    }
    composable(PROJECT_GROUPING) {
      ProjectGroupingScreen(
        settings = runtime.settings,
        onChange = { mode ->
          viewModel.updateSettings(runtime.settings.copy(projectGroupingMode = mode))
        },
        onBack = { navController.popBackStack() },
      )
    }
    composable(APPEARANCE) {
      AppearanceScreen(
        settings = runtime.settings,
        onChange = viewModel::updateSettings,
        onBack = { navController.popBackStack() },
      )
    }
    composable(USAGE) {
      val usageState by viewModel.usageState.collectAsState()
      LaunchedEffect(Unit) { viewModel.loadUsage() }
      UsageScreen(
        state = usageState,
        onBack = { navController.popBackStack() },
        onWindowSelected = viewModel::loadUsage,
        onRefresh = { viewModel.loadUsage() },
      )
    }
    composable(ARCHIVED_THREADS) {
      val archivedState by viewModel.archivedThreadsState.collectAsState()
      LaunchedEffect(Unit) { viewModel.loadArchivedThreads() }
      ArchivedThreadsScreen(
        state = archivedState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(CLIENT_STORAGE) {
      val storageState by viewModel.clientStorageState.collectAsState()
      LaunchedEffect(Unit) { viewModel.loadClientStorage() }
      ClientStorageScreen(
        state = storageState,
        viewModel = viewModel,
        onBack = { navController.popBackStack() },
      )
    }
    composable(LEGAL) {
      LegalScreen(onBack = { navController.popBackStack() })
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
        wideContent = workspaceSplit,
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
          fontSize = runtime.settings.resolveAppearance().terminalFontSize,
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
      CompactInputField(
        value = host,
        onValueChange = { host = it },
        placeholder = "Host or pairing URL",
        modifier = Modifier.fillMaxWidth(),
      )
      CompactInputField(
        value = code,
        onValueChange = { code = it },
        placeholder = "Pairing code",
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
private fun DraftThreadRow(
  draft: ComposerDraft,
  projectTitle: String?,
  providerLabel: String?,
  branch: String?,
  faviconUrl: String?,
  onResume: () -> Unit,
  onDiscard: () -> Unit,
) {
  val project = projectTitle?.takeIf(String::isNotBlank) ?: "Choose project"
  val metadata = buildList {
    providerLabel?.takeIf(String::isNotBlank)?.let(::add)
    branch?.takeIf(String::isNotBlank)?.let { add(if (draft.isWorktree) "Worktree · $it" else it) }
    if (draft.attachments.isNotEmpty()) {
      add("${draft.attachments.size} image${if (draft.attachments.size == 1) "" else "s"}")
    }
  }.joinToString("  ·  ")

  Surface(
    shape = RoundedCornerShape(16.dp),
    color = Color(0xFF1C1912),
    border = BorderStroke(1.dp, Color(0xFF5A4318)),
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onResume),
  ) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 14.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Box(
        modifier = Modifier
          .size(32.dp)
          .background(Color(0xFF27272A), CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        Icon(
          imageVector = Icons.Rounded.EditNote,
          contentDescription = null,
          tint = Color(0xFFFBBF24),
          modifier = Modifier.size(17.dp),
        )
      }

      Column(modifier = Modifier.weight(1f)) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          ProjectFaviconMark(title = project, dimmed = false, faviconUrl = faviconUrl)
          Text(
            text = project,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
          )
          Text(
            text = "Draft",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFFBBF24),
          )
        }
        Text(
          text = draft.text.ifBlank { "Untitled draft" },
          style = MaterialTheme.typography.bodyLarge,
          color = Color.White,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
        if (metadata.isNotBlank()) {
          Text(
            text = metadata,
            style = MaterialTheme.typography.labelSmall,
            color = Color(0xFFA1A1AA),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
      }

      IconButton(
        onClick = onDiscard,
        modifier = Modifier.size(32.dp),
      ) {
        Icon(
          imageVector = Icons.Rounded.Clear,
          contentDescription = "Discard draft",
          tint = Color(0xFFA1A1AA),
          modifier = Modifier.size(16.dp),
        )
      }
    }
  }
}

@Composable
private fun CompactBrandTitle(statusLabel: String) {
  Column {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      val wordmark = remember { PathParser().parsePathString(T3_WORDMARK_PATH).toPath() }
      Canvas(Modifier.width(25.dp).height(15.dp)) {
        val scale = size.height / 56.96f
        withTransform({
          translate(left = -15.5309f * scale, top = -37f * scale)
          scale(scaleX = scale, scaleY = scale, pivot = Offset.Zero)
        }) {
          drawPath(wordmark, color = Color.White)
        }
      }
      Text(
        text = "Code",
        style = MaterialTheme.typography.titleLarge.copy(
          fontSize = 21.sp,
          fontWeight = FontWeight.Medium,
          letterSpacing = (-0.5).sp,
        ),
        color = Color(0xFFD4D4D8),
      )
      Surface(
        shape = CircleShape,
        color = Color(0xFF27272A),
      ) {
        Text(
          text = "ALPHA",
          modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
          style = MaterialTheme.typography.labelSmall.copy(
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.9.sp,
          ),
          color = Color(0xFFA1A1AA),
        )
      }
    }
    Text(statusLabel, style = MaterialTheme.typography.labelSmall)
  }
}

@Composable
private fun HomeScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  homeListTopRequest: Int,
  onNewTask: () -> Unit,
  onOpenThread: (String) -> Unit,
  pendingShares: List<IncomingShare>,
  onOpenShare: (String) -> Unit,
  onAddEnvironment: () -> Unit,
  onSettings: () -> Unit,
  pane: HomePane = HomePane.Screen,
  selectedThreadId: String? = null,
  modifier: Modifier = Modifier,
) {
  val allDrafts by viewModel.allDrafts.collectAsState()
  val activeEnvId = runtime.environment?.environmentId
  val newTaskDraftKey = activeEnvId?.let { DraftStore.newTaskKey(it) }
  val activeDraft = newTaskDraftKey?.let { allDrafts[it] }?.takeIf {
    it.text.isNotBlank() || it.attachments.isNotEmpty()
  }
  val activeDraftProject = activeDraft?.projectId?.let { runtime.shell.projects[it] }
  val activeDraftProviderInstanceId = activeDraft?.modelInstanceId
    ?: activeDraftProject?.defaultModelSelection?.instanceId
    ?: runtime.providerModels.firstOrNull { it.isDefault }?.instanceId
  val activeDraftProvider = runtime.providerModels
    .firstOrNull { it.instanceId == activeDraftProviderInstanceId }
    ?.providerLabel
    ?: activeDraftProviderInstanceId
  val activeDraftBranch = activeDraft?.let {
    it.branch?.takeIf(String::isNotBlank)
      ?: if (it.isWorktree) "Choose base branch" else "Current checkout"
  }

  var search by remember { mutableStateOf("") }
  var filterStatus by remember { mutableStateOf(ThreadFilterStatus.All) }
  var filterProjectKey by remember { mutableStateOf<String?>(null) }
  var showFilterSheet by remember { mutableStateOf(false) }
  var snoozedExpanded by remember { mutableStateOf(false) }
  var settledExpanded by remember { mutableStateOf(true) }
  var settledLimit by remember { mutableIntStateOf(THREAD_LIST_V2_SETTLED_INITIAL) }
  val threadListState = rememberLazyListState()
  var previousRevealSignal by remember { mutableStateOf(HomeListRevealSignal()) }
  val caps = runtime.threadCapabilities
  val projectGroups = remember(runtime.shell.projects, runtime.settings.projectGroupingMode) {
    buildLogicalProjectGroups(runtime.shell.projects.values, runtime.settings.projectGroupingMode)
  }
  LaunchedEffect(projectGroups, filterProjectKey) {
    if (filterProjectKey != null && projectGroups.none { it.key == filterProjectKey }) {
      filterProjectKey = null
    }
  }
  val projectGroupLabels = remember(projectGroups) {
    projectGroups.flatMap { group -> group.projectIds.map { it to group.label } }.toMap()
  }
  val filteredProjectIds = projectGroups.firstOrNull { it.key == filterProjectKey }?.projectIds

  val revealSignal = HomeListRevealSignal(
    draftVisible = activeDraft != null,
    createdThreadRequest = homeListTopRequest,
  )
  LaunchedEffect(revealSignal) {
    val revealTop = shouldRevealHomeListTop(previousRevealSignal, revealSignal)
    previousRevealSignal = revealSignal
    if (revealTop) threadListState.scrollToItem(0)
  }

  val rawThreads = remember(runtime.shell.threads, filteredProjectIds) {
    if (filteredProjectIds == null) {
      runtime.shell.threads.values
    } else {
      runtime.shell.threads.values.filter { it.projectId in filteredProjectIds }
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

  val isFiltered = filterStatus != ThreadFilterStatus.All || filterProjectKey != null

  Scaffold(
    modifier = modifier,
    topBar = {
      TopAppBar(
        title = {
          CompactBrandTitle(runtime.statusLabel())
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
      FloatingActionButton(
        onClick = onNewTask,
        modifier = Modifier.size(56.dp),
        shape = CircleShape,
        containerColor = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
      ) {
        Icon(
          painter = painterResource(R.drawable.ic_new_task),
          contentDescription = "New task",
          modifier = Modifier.size(22.dp),
        )
      }
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
        CompactSearchField(
          value = search,
          onValueChange = { search = it },
          placeholder = "Search threads",
          modifier = Modifier.weight(1f),
        )
        IconButton(onClick = { showFilterSheet = true }) {
          Icon(
            imageVector = Icons.Rounded.FilterList,
            contentDescription = "Filter threads",
            tint = if (isFiltered) MaterialTheme.colorScheme.primary else Color.White,
          )
        }
      }

      if (isFiltered) {
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
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
          if (filterProjectKey != null) {
            val pTitle = projectGroups.firstOrNull { it.key == filterProjectKey }?.label ?: filterProjectKey
            FilterChip(
              selected = true,
              onClick = { filterProjectKey = null },
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
        state = threadListState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
          start = if (pane == HomePane.Sidebar) 12.dp else 16.dp,
          end = if (pane == HomePane.Sidebar) 12.dp else 16.dp,
          bottom = 96.dp,
        ),
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
        activeDraft?.let { draft ->
          item(key = "active-new-task-draft") {
            DraftThreadRow(
              draft = draft,
              projectTitle = activeDraftProject?.title,
              providerLabel = activeDraftProvider ?: "Default harness",
              branch = activeDraftBranch,
              faviconUrl = activeDraftProject?.let { runtime.projectFavicons[it.id] },
              onResume = onNewTask,
              onDiscard = { viewModel.discardDraft(newTaskDraftKey) },
            )
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
          projectGroupLabels = projectGroupLabels,
          selectedThreadId = selectedThreadId,
          pane = pane,
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
              projectGroupLabels = projectGroupLabels,
              selectedThreadId = selectedThreadId,
              pane = pane,
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
              projectGroupLabels = projectGroupLabels,
              selectedThreadId = selectedThreadId,
              pane = pane,
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
      filterProjectKey = filterProjectKey,
      projectGroups = projectGroups,
      environments = runtime.environments,
      selectedEnvironmentId = runtime.environment?.environmentId,
      onSelectStatus = { filterStatus = it },
      onSelectProject = { filterProjectKey = it },
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
  projectGroupLabels: Map<String, String>,
  selectedThreadId: String?,
  pane: HomePane,
  onOpenThread: (String) -> Unit,
) {
  val orderedPinned = sortPinnedThreads(
    runtime.shell.threads.values.filter { it.pinnedAt != null && it.archivedAt == null },
  )
  val firstPinKey = orderedPinned.firstOrNull()?.pinOrderKey
  items(rows, key = { "$keyPrefix:${it.thread.id}" }) { item ->
    val project = runtime.shell.projects[item.thread.projectId]
    val pinnedIndex = orderedPinned.indexOfFirst { it.id == item.thread.id }
    ThreadListV2Row(
      item = item,
      capabilities = capabilities,
      compact = compact,
      projectTitle = projectGroupLabels[project?.id] ?: project?.title,
      projectPath = project?.workspaceRoot,
      providerDriver = resolveProviderDriver(
        item.thread.modelSelection.instanceId,
        runtime.providerModels,
      ),
      faviconUrl = project?.let { runtime.projectFavicons[it.id] },
      newPinOrderKey = pinOrderKeyBetween(null, firstPinKey),
      canMovePinnedUp = capabilities.pinReorder && pinnedIndex > 0,
      canMovePinnedDown = capabilities.pinReorder && pinnedIndex in 0 until orderedPinned.lastIndex,
      selected = pane == HomePane.Sidebar && item.thread.id == selectedThreadId,
      onOpen = { onOpenThread(item.thread.id) },
      onAction = { command, value ->
        viewModel.threadAction(command, item.thread.id, value)
      },
      onRenameThread = { title -> viewModel.renameThread(item.thread.id, title) },
      onRegenerateTitle = { viewModel.regenerateThreadTitle(item.thread.id) },
      onDeleteThread = { viewModel.deleteThread(item.thread.id) },
      onMovePinned = { direction ->
        viewModel.reorderPinned(planPinnedMove(orderedPinned, item.thread.id, direction))
      },
    )
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThreadFilterBottomSheet(
  filterStatus: ThreadFilterStatus,
  filterProjectKey: String?,
  projectGroups: List<LogicalProjectGroup>,
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
        if (filterStatus != ThreadFilterStatus.All || filterProjectKey != null) {
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

      if (projectGroups.isNotEmpty()) {
        Text("Project", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color.White)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Surface(
            onClick = {
              onSelectProject(null)
              onDismiss()
            },
            color = if (filterProjectKey == null) Color(0xFF1E293B) else Color(0xFF18181B),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Row(
              modifier = Modifier.padding(12.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text("All Projects", fontWeight = FontWeight.Medium, color = Color.White)
              if (filterProjectKey == null) {
                Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
              }
            }
          }
          projectGroups.forEach { group ->
            val isSel = filterProjectKey == group.key
            Surface(
              onClick = {
                onSelectProject(group.key)
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
                Column(Modifier.weight(1f)) {
                  Text(group.label, fontWeight = FontWeight.Medium, color = Color.White)
                  if (group.projects.size > 1) {
                    Text(
                      "${group.projects.size} workspaces",
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
private fun EnvironmentDrawer(
  runtime: OnlineChatState,
  viewModel: AppViewModel,
  onAdd: () -> Unit,
  dismiss: () -> Unit,
) {
  val environment = runtime.environment ?: return
  var label by remember(environment) { mutableStateOf(environment.label) }
  var url by remember(environment) { mutableStateOf(environment.httpBaseUrl) }
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  ModalBottomSheet(
    onDismissRequest = dismiss,
    sheetState = sheetState,
    containerColor = Color(0xFF141417),
    contentColor = Color.White,
    shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    scrimColor = Color.Black.copy(alpha = 0.65f),
  ) {
    Column(Modifier.fillMaxWidth().imePadding()) {
      DrawerHeader(
        icon = Icons.Rounded.Public,
        title = "Environment",
        subtitle = "Switch or edit your current connection",
        onDismiss = dismiss,
        showCloseButton = false,
      )
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .verticalScroll(rememberScrollState())
          .padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Text("Environments", style = MaterialTheme.typography.labelLarge)
        runtime.environments.forEach { item ->
          val status = runtime.environmentStatuses[item.environmentId]
          val selected = item.environmentId == environment.environmentId
          Surface(
            onClick = { viewModel.selectEnvironment(item.environmentId) },
            shape = RoundedCornerShape(14.dp),
            color = if (selected) Color(0xFF1E293B) else Color(0xFF202024),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Row(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              Column(Modifier.weight(1f)) {
                Text(item.label, fontWeight = FontWeight.SemiBold)
                Text(
                  status?.connectionPhase?.name ?: "Loading",
                  style = MaterialTheme.typography.labelSmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
              if (selected) {
                Icon(Icons.Rounded.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
              }
            }
          }
        }
        OutlinedButton(onClick = onAdd, modifier = Modifier.fillMaxWidth()) { Text("Add environment") }
        HorizontalDivider()
        Text("Current environment", style = MaterialTheme.typography.labelLarge)
        CompactInputField(
          value = label,
          onValueChange = { label = it },
          placeholder = "Label",
          modifier = Modifier.fillMaxWidth(),
        )
        CompactInputField(
          value = url,
          onValueChange = { url = it },
          placeholder = "URL",
          enabled = environment.kind == EnvironmentKind.Bearer,
          modifier = Modifier.fillMaxWidth(),
        )
        Button(
          onClick = {
            viewModel.updateEnvironment(label, url)
            dismiss()
          },
          enabled = environment.kind == EnvironmentKind.Bearer && label.isNotBlank() && url.isNotBlank(),
          modifier = Modifier.fillMaxWidth(),
        ) { Text("Save") }
        TextButton(
          onClick = {
            viewModel.forgetEnvironment()
            dismiss()
          },
          modifier = Modifier.fillMaxWidth(),
        ) {
          Text("Forget environment", color = MaterialTheme.colorScheme.error)
        }
      }
    }
  }
}

@Composable
private fun SettingsScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onOpenConnect: () -> Unit,
  onAddProject: () -> Unit,
  onOpenEnvironments: () -> Unit,
  onOpenArchivedThreads: () -> Unit,
  onOpenUsage: () -> Unit,
  onOpenProjectGrouping: () -> Unit,
  onOpenAppearance: () -> Unit,
  onOpenClientStorage: () -> Unit,
  onOpenLegal: () -> Unit,
) {
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Settings", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
      NativeSettingsSection("Account") {
        NativeSettingsRow(
          icon = Icons.Rounded.Person,
          label = "T3 Account",
          value = if (runtime.cloud.signedIn) {
            runtime.cloud.accountLabel ?: runtime.cloud.accountId ?: "Signed in"
          } else {
            "Sign in"
          },
          onClick = onOpenConnect,
        )
      }
      Text(
        "T3 Code works locally without signing in. Cloud features are optional.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(horizontal = 8.dp).offset(y = (-16).dp),
      )

      NativeSettingsSection("Configuration") {
        NativeSettingsRow(Icons.Rounded.Computer, "Environments", runtime.environments.size.toString(), onOpenEnvironments)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.CreateNewFolder, "Add Project", onClick = onAddProject)
      }

      NativeSettingsSection("General") {
        NativeSettingsRow(Icons.Rounded.FolderOpen, "Project Grouping", onClick = onOpenProjectGrouping)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.BarChart, "Usage", onClick = onOpenUsage)
      }

      NativeSettingsSection("Appearance") {
        NativeSettingsRow(Icons.Rounded.Palette, "Appearance", onClick = onOpenAppearance)
      }

      NativeSettingsSection("Legacy") {
        NativeSettingsSwitchRow(
          icon = Icons.Rounded.FilterList,
          label = "Compact thread rows",
          checked = runtime.settings.compactThreadRows,
          onCheckedChange = {
            viewModel.updateSettings(runtime.settings.copy(compactThreadRows = it))
          },
        )
      }

      NativeSettingsSection("Threads") {
        NativeSettingsRow(Icons.Rounded.Archive, "Archived Threads", onClick = onOpenArchivedThreads)
      }

      NativeSettingsSection("App") {
        NativeSettingsRow(Icons.Rounded.Storage, "Client Storage", onClick = onOpenClientStorage)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.Info, "Legal", onClick = onOpenLegal)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.Info, "Version", value = BuildConfig.VERSION_NAME)
      }

      RuntimeError(runtime.error, dispatchState)
      Spacer(Modifier.height(8.dp))
    }
  }
}

@Composable
private fun NativeSettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(
      title,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.labelLarge,
      modifier = Modifier.padding(horizontal = 8.dp),
    )
    Surface(
      shape = RoundedCornerShape(20.dp),
      color = Color(0xFF111113),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(content = content)
    }
  }
}

@Composable
private fun NativeSettingsRow(
  icon: ImageVector,
  label: String,
  value: String? = null,
  onClick: (() -> Unit)? = null,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(enabled = onClick != null) { onClick?.invoke() }
      .padding(horizontal = 16.dp, vertical = 15.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Icon(icon, contentDescription = null, tint = Color(0xFFE4E4E7), modifier = Modifier.size(22.dp))
    Text(label, color = Color.White, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
    value?.let {
      Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (onClick != null) {
      Icon(Icons.Rounded.ChevronRight, contentDescription = null, tint = Color(0xFF71717A), modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
private fun NativeSettingsSwitchRow(
  icon: ImageVector,
  label: String,
  checked: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().clickable { onCheckedChange(!checked) }.padding(horizontal = 16.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Icon(icon, contentDescription = null, tint = Color(0xFFE4E4E7), modifier = Modifier.size(22.dp))
    Text(label, color = Color.White, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
    Switch(checked = checked, onCheckedChange = onCheckedChange)
  }
}

@Composable
private fun ProjectGroupingScreen(
  settings: AppSettings,
  onChange: (ProjectGroupingMode) -> Unit,
  onBack: () -> Unit,
) {
  val options = listOf(
    Triple(ProjectGroupingMode.Repository, "Group by repository", "Matching repositories appear as one project."),
    Triple(ProjectGroupingMode.RepositoryPath, "Group by repository path", "Keep monorepo paths separate."),
    Triple(ProjectGroupingMode.Separate, "Keep separate", "Show every workspace as its own project."),
  )
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Project Grouping", onBack) }) { padding ->
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp)) {
      NativeSettingsSection("Default grouping") {
        options.forEachIndexed { index, (mode, label, description) ->
          if (index > 0) HorizontalDivider(color = Color(0xFF27272A))
          Row(
            modifier = Modifier.fillMaxWidth().clickable { onChange(mode) }.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
          ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(label, style = MaterialTheme.typography.bodyLarge, color = Color.White)
              Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
            }
            if (settings.projectGroupingMode == mode) {
              Icon(Icons.Rounded.Check, contentDescription = "Selected", modifier = Modifier.size(18.dp))
            }
          }
        }
      }
    }
  }
}

@Composable
private fun AppearanceScreen(
  settings: AppSettings,
  onChange: (AppSettings) -> Unit,
  onBack: () -> Unit,
) {
  var previewSettings by remember { mutableStateOf(settings) }
  LaunchedEffect(settings) { previewSettings = settings }
  val appearance = previewSettings.resolveAppearance()
  fun commit(next: AppSettings) {
    previewSettings = next
    onChange(next)
  }
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Appearance", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
      NativeSettingsSection("Text") {
        TextAppearancePreview(appearance.baseFontSize)
        HorizontalDivider(color = Color(0xFF27272A))
        AppearanceSliderRow(
          label = "Text size",
          value = appearance.baseFontSize,
          valueLabel = "${appearance.baseFontSize.toInt()} pt",
          range = MIN_BASE_FONT_SIZE..MAX_BASE_FONT_SIZE,
          steps = 10,
          onPreview = { previewSettings = previewSettings.copy(baseFontSize = normalizeBaseFontSize(it)) },
          onCommit = { commit(previewSettings.copy(baseFontSize = normalizeBaseFontSize(it))) },
        )
      }

      NativeSettingsSection("Terminal") {
        TerminalAppearancePreview(appearance.terminalFontSize)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsSwitchRow(
          icon = Icons.Rounded.Terminal,
          label = "Custom font size",
          checked = appearance.terminalFontSizeCustom,
          onCheckedChange = { enabled ->
            commit(previewSettings.copy(terminalFontSizeOverride = if (enabled) appearance.terminalFontSize else null))
          },
        )
        if (appearance.terminalFontSizeCustom) {
          HorizontalDivider(color = Color(0xFF27272A))
          AppearanceSliderRow(
            label = "Font size",
            value = appearance.terminalFontSize,
            valueLabel = "${"%.1f".format(appearance.terminalFontSize)} pt",
            range = MIN_TERMINAL_FONT_SIZE..MAX_TERMINAL_FONT_SIZE,
            steps = 15,
            onPreview = {
              previewSettings = previewSettings.copy(terminalFontSizeOverride = normalizeTerminalFontSize(it))
            },
            onCommit = { commit(previewSettings.copy(terminalFontSizeOverride = normalizeTerminalFontSize(it))) },
          )
        }
      }

      NativeSettingsSection("Code & Diffs") {
        CodeAppearancePreview(appearance.codeFontSize, appearance.codeWordBreak)
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsSwitchRow(
          icon = Icons.Rounded.Build,
          label = "Custom font size",
          checked = appearance.codeFontSizeCustom,
          onCheckedChange = { enabled ->
            commit(previewSettings.copy(codeFontSizeOverride = if (enabled) appearance.codeFontSize else null))
          },
        )
        if (appearance.codeFontSizeCustom) {
          HorizontalDivider(color = Color(0xFF27272A))
          AppearanceSliderRow(
            label = "Font size",
            value = appearance.codeFontSize,
            valueLabel = "${appearance.codeFontSize.toInt()} pt",
            range = MIN_CODE_FONT_SIZE..MAX_CODE_FONT_SIZE,
            steps = 9,
            onPreview = {
              previewSettings = previewSettings.copy(codeFontSizeOverride = normalizeCodeFontSize(it))
            },
            onCommit = { commit(previewSettings.copy(codeFontSizeOverride = normalizeCodeFontSize(it))) },
          )
        }
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsSwitchRow(
          icon = Icons.Rounded.TextFields,
          label = "Word break",
          checked = appearance.codeWordBreak,
          onCheckedChange = { commit(previewSettings.copy(codeWordBreak = it)) },
        )
      }
      Spacer(Modifier.height(8.dp))
    }
  }
}

@Composable
private fun AppearanceSliderRow(
  label: String,
  value: Float,
  valueLabel: String,
  range: ClosedFloatingPointRange<Float>,
  steps: Int,
  onPreview: (Float) -> Unit,
  onCommit: (Float) -> Unit,
) {
  Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(label, style = MaterialTheme.typography.bodyMedium)
      Text(valueLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Slider(
      value = value,
      onValueChange = onPreview,
      onValueChangeFinished = { onCommit(value) },
      valueRange = range,
      steps = steps,
    )
  }
}

@Composable
private fun TextAppearancePreview(fontSize: Float) {
  val sizes = resolveMarkdownFontSizes(fontSize)
  Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text("The quick brown fox jumps over the lazy dog.", fontSize = sizes.body.sp, lineHeight = sizes.bodyLineHeight.sp)
    Text(
      "Messages, labels, and headings scale with this size.",
      fontSize = sizes.small.sp,
      lineHeight = (sizes.small * 1.4f).sp,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun TerminalAppearancePreview(fontSize: Float) {
  Column(
    Modifier.fillMaxWidth().background(Color.Black).padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    Text("→ t3code git:(main) ✗ vpr dev", fontFamily = FontFamily.Monospace, fontSize = fontSize.sp, color = Color(0xFFE4E4E7))
    Text("VITE v7.1.1 ready in 1.24s", fontFamily = FontFamily.Monospace, fontSize = fontSize.sp, color = Color(0xFF4ADE80))
    Text("✓ 85 passed  △ 2 warnings  ✗ 0 failed", fontFamily = FontFamily.Monospace, fontSize = fontSize.sp, color = Color(0xFF60A5FA))
  }
}

@Composable
private fun CodeAppearancePreview(fontSize: Float, wordBreak: Boolean) {
  val code = "function formatUser(user) {\n  return `${'$'}{user.name} <${'$'}{user.email}>` // demonstrates how long lines behave\n}"
  Text(
    code,
    fontFamily = FontFamily.Monospace,
    fontSize = fontSize.sp,
    lineHeight = (fontSize + 6f).sp,
    modifier = (if (wordBreak) Modifier.fillMaxWidth() else Modifier.horizontalScroll(rememberScrollState()))
      .background(Color(0xFF0B0B0D))
      .padding(16.dp),
  )
}

@Composable
private fun EnvironmentSettingsScreen(
  runtime: OnlineChatState,
  dispatchState: DispatchState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onAddEnvironment: () -> Unit,
) {
  val sections = splitEnvironmentSettings(
    saved = runtime.environments,
    listedRelay = if (runtime.cloud.signedIn) runtime.cloud.relayEnvironments else emptyList(),
  )
  var expandedId by remember { mutableStateOf<String?>(null) }
  var removeTarget by remember { mutableStateOf<SavedEnvironment?>(null) }
  val busy = dispatchState is DispatchState.Sending
  BackHandler(onBack = onBack)
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Environments", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = onAddEnvironment) {
            Icon(Icons.Rounded.Add, contentDescription = "Add environment")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
      if (sections.local.isEmpty()) {
        EmptyEnvironmentSettingsCard()
      } else {
        Surface(
          shape = RoundedCornerShape(24.dp),
          color = Color(0xFF111113),
          modifier = Modifier.fillMaxWidth(),
        ) {
          Column {
            sections.local.forEachIndexed { index, environment ->
              if (index > 0) HorizontalDivider(color = Color(0xFF27272A))
              LocalEnvironmentSettingsRow(
                environment = environment,
                status = runtime.environmentStatuses[environment.environmentId],
                expanded = expandedId == environment.environmentId,
                busy = busy,
                onToggle = {
                  expandedId = environment.environmentId.takeUnless { it == expandedId }
                },
                onSave = { label, url ->
                  viewModel.updateEnvironment(environment.environmentId, label, url)
                },
                onRetry = { viewModel.retryEnvironment(environment.environmentId) },
                onRemove = { removeTarget = environment },
              )
            }
          }
        }
      }

      if (sections.connectedRelay.isNotEmpty() || runtime.cloud.signedIn) {
        T3ConnectEnvironmentSection(
          connected = sections.connectedRelay,
          available = sections.availableRelay,
          statuses = runtime.environmentStatuses,
          discoveryError = runtime.cloud.lastError,
          discoveryAvailable = runtime.cloud.signedIn,
          busy = busy,
          onRefresh = viewModel::refreshCloudEnvironments,
          onConnect = { viewModel.connectRelay(it, openHome = false) },
          onRetry = viewModel::retryEnvironment,
          onRemove = { removeTarget = it },
        )
      }

      AuthError(dispatchState, viewModel::clearDispatchFailure)
      RuntimeError(runtime.error, dispatchState)
    }
  }

  removeTarget?.let { environment ->
    AlertDialog(
      onDismissRequest = { removeTarget = null },
      title = { Text("Remove environment?") },
      text = { Text("Disconnect and forget ${environment.label} on this device.") },
      confirmButton = {
        TextButton(
          onClick = {
            expandedId = null
            removeTarget = null
            viewModel.removeEnvironment(environment.environmentId)
          },
        ) { Text("Remove", color = MaterialTheme.colorScheme.error) }
      },
      dismissButton = { TextButton(onClick = { removeTarget = null }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun EmptyEnvironmentSettingsCard() {
  Column(
    modifier = Modifier.fillMaxWidth().background(Color(0xFF111113), RoundedCornerShape(24.dp)).padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(
      modifier = Modifier.size(48.dp).background(Color(0xFF1C1C1F), RoundedCornerShape(16.dp)),
      contentAlignment = Alignment.Center,
    ) {
      Icon(Icons.Rounded.Computer, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Text(
      "No environments connected yet.\nTap + to add one.",
      textAlign = androidx.compose.ui.text.style.TextAlign.Center,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.bodyMedium,
    )
  }
}

@Composable
private fun LocalEnvironmentSettingsRow(
  environment: SavedEnvironment,
  status: EnvironmentConnectionStatus?,
  expanded: Boolean,
  busy: Boolean,
  onToggle: () -> Unit,
  onSave: (String, String) -> Unit,
  onRetry: () -> Unit,
  onRemove: () -> Unit,
) {
  var label by remember(environment.environmentId, environment.label) { mutableStateOf(environment.label) }
  var url by remember(environment.environmentId, environment.httpBaseUrl) { mutableStateOf(environment.httpBaseUrl) }
  Column(Modifier.fillMaxWidth()) {
    Row(
      modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 16.dp, vertical = 14.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      EnvironmentStatusDot(status?.connectionPhase)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(environment.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(environment.httpBaseUrl, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
          environmentConnectionLabel(status),
          style = MaterialTheme.typography.labelMedium,
          color = if (status?.error != null) Color(0xFFF87171) else MaterialTheme.colorScheme.onSurfaceVariant,
          maxLines = if (expanded) Int.MAX_VALUE else 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      Icon(
        Icons.Rounded.KeyboardArrowDown,
        contentDescription = if (expanded) "Collapse environment" else "Expand environment",
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(20.dp).graphicsLayer { rotationZ = if (expanded) 180f else 0f },
      )
    }
    AnimatedVisibility(visible = expanded) {
      Column(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        EnvironmentEditField("Label", label, { label = it }, "My MacBook")
        EnvironmentEditField("URL", url, { url = it }, "192.168.1.100:8080")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(
            onClick = { onSave(label.trim(), url.trim()) },
            enabled = !busy && label.isNotBlank() && url.isNotBlank(),
            modifier = Modifier.weight(1f).height(44.dp),
          ) {
            Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("Save")
          }
          OutlinedButton(onClick = onRetry, enabled = !busy, modifier = Modifier.height(44.dp)) {
            Icon(Icons.Rounded.Refresh, contentDescription = "Reconnect", modifier = Modifier.size(18.dp))
          }
          OutlinedButton(onClick = onRemove, enabled = !busy, modifier = Modifier.height(44.dp)) {
            Icon(Icons.Rounded.Delete, contentDescription = "Remove", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
          }
        }
      }
    }
  }
}

@Composable
private fun EnvironmentEditField(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  placeholder: String,
) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    CompactInputField(value, onValueChange, placeholder, Modifier.fillMaxWidth())
  }
}

@Composable
private fun EnvironmentStatusDot(phase: ConnectionPhase?) {
  val color = when (phase) {
    ConnectionPhase.Connected -> Color(0xFF22C55E)
    ConnectionPhase.Connecting, ConnectionPhase.Backoff -> Color(0xFFF59E0B)
    ConnectionPhase.Blocked, ConnectionPhase.Error -> Color(0xFFEF4444)
    else -> Color(0xFF71717A)
  }
  Box(Modifier.size(8.dp).background(color, CircleShape))
}

@Composable
private fun T3ConnectEnvironmentSection(
  connected: List<SavedEnvironment>,
  available: List<RelayEnvironment>,
  statuses: Map<String, EnvironmentConnectionStatus>,
  discoveryError: String?,
  discoveryAvailable: Boolean,
  busy: Boolean,
  onRefresh: () -> Unit,
  onConnect: (String) -> Unit,
  onRetry: (String) -> Unit,
  onRemove: (SavedEnvironment) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("T3 CONNECT", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
      if (discoveryAvailable) {
        IconButton(onClick = onRefresh, enabled = !busy) {
          Icon(Icons.Rounded.Refresh, contentDescription = "Refresh T3 Connect environments", modifier = Modifier.size(18.dp))
        }
      }
    }
    Surface(shape = RoundedCornerShape(24.dp), color = Color(0xFF111113), modifier = Modifier.fillMaxWidth()) {
      Column {
        val rowCount = connected.size + available.size
        connected.forEachIndexed { index, environment ->
          if (index > 0) HorizontalDivider(color = Color(0xFF27272A))
          T3ConnectEnvironmentRow(
            label = environment.label,
            status = environmentConnectionLabel(statuses[environment.environmentId]),
            phase = statuses[environment.environmentId]?.connectionPhase,
            checked = true,
            busy = busy,
            onCheckedChange = { enabled ->
              if (enabled) onRetry(environment.environmentId) else onRemove(environment)
            },
          )
        }
        available.forEachIndexed { index, environment ->
          if (connected.isNotEmpty() || index > 0) HorizontalDivider(color = Color(0xFF27272A))
          T3ConnectEnvironmentRow(
            label = environment.label.ifBlank { environment.environmentId },
            status = "Available",
            phase = null,
            checked = false,
            busy = busy,
            onCheckedChange = { enabled -> if (enabled) onConnect(environment.environmentId) },
          )
        }
        if (rowCount == 0 && discoveryError == null) {
          Text("No additional linked cloud environments.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(20.dp))
        }
      }
    }
    discoveryError?.takeIf { discoveryAvailable }?.let { error ->
      Column(
        Modifier.fillMaxWidth().background(Color(0xFF111113), RoundedCornerShape(24.dp)).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text("Could not load T3 Connect environments", fontWeight = FontWeight.SemiBold)
        Text(error, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onRefresh, enabled = !busy) { Text("Try again") }
      }
    }
  }
}

@Composable
private fun T3ConnectEnvironmentRow(
  label: String,
  status: String,
  phase: ConnectionPhase?,
  checked: Boolean,
  busy: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    EnvironmentStatusDot(phase)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(status, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = !busy)
  }
}

@Composable
private fun ArchivedThreadsScreen(
  state: ArchivedThreadsUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  var search by remember { mutableStateOf("") }
  var selectedEnvironmentId by remember { mutableStateOf<String?>(null) }
  var sortOrder by remember { mutableStateOf(ArchivedThreadSortOrder.Newest) }
  var filterOpen by remember { mutableStateOf(false) }
  var deleteTarget by remember { mutableStateOf<ArchivedThreadEntry?>(null) }
  val groups = remember(state.reports, selectedEnvironmentId, search, sortOrder) {
    buildArchivedThreadGroups(state.reports, selectedEnvironmentId, search, sortOrder)
  }
  val failedReports = state.reports.filter { it.error != null }

  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Archived Threads", onBack) }) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        CompactSearchField(search, { search = it }, "Search archived threads", Modifier.weight(1f))
        IconButton(onClick = viewModel::loadArchivedThreads) {
          Icon(Icons.Rounded.Refresh, contentDescription = "Refresh archived threads")
        }
        Box {
          IconButton(onClick = { filterOpen = true }) {
            Icon(Icons.Rounded.FilterList, contentDescription = "Filter and sort archived threads")
          }
          DropdownMenu(filterOpen, { filterOpen = false }, containerColor = Color(0xFF1C1C1F)) {
            DropdownMenuItem(
              text = { Text("All environments") },
              onClick = { selectedEnvironmentId = null; filterOpen = false },
              trailingIcon = { if (selectedEnvironmentId == null) Icon(Icons.Rounded.Check, null) },
            )
            state.reports.forEach { report ->
              DropdownMenuItem(
                text = { Text(report.environmentLabel) },
                onClick = { selectedEnvironmentId = report.environmentId; filterOpen = false },
                trailingIcon = { if (selectedEnvironmentId == report.environmentId) Icon(Icons.Rounded.Check, null) },
              )
            }
            HorizontalDivider(color = Color(0xFF3F3F46))
            ArchivedThreadSortOrder.entries.forEach { order ->
              DropdownMenuItem(
                text = { Text(if (order == ArchivedThreadSortOrder.Newest) "Newest first" else "Oldest first") },
                onClick = { sortOrder = order; filterOpen = false },
                trailingIcon = { if (sortOrder == order) Icon(Icons.Rounded.Check, null) },
              )
            }
          }
        }
      }
      if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
      state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
      if (failedReports.isNotEmpty()) {
        Text(
          failedReports.joinToString("\n") { "${it.environmentLabel}: ${it.error}" },
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          style = MaterialTheme.typography.bodySmall,
          modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
      }
      if (!state.loading && groups.isEmpty()) {
        Text(
          if (search.isBlank()) "No archived threads" else "No matching archived threads",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp),
        )
      } else {
        LazyColumn(
          modifier = Modifier.fillMaxSize(),
          contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
        ) {
          groups.forEach { group ->
            item("group:${group.key}") {
              ArchivedThreadGroupHeader(group)
            }
            group.threads.forEachIndexed { index, entry ->
              item("${entry.environmentId}:${entry.thread.id}") {
                ArchivedThreadRow(
                  entry = entry,
                  first = index == 0,
                  last = index == group.threads.lastIndex,
                  onRestore = {
                    viewModel.archivedThreadAction(
                      entry.environmentId,
                      "thread.unarchive",
                      entry.thread.id,
                    )
                  },
                  onDelete = { deleteTarget = entry },
                )
              }
            }
            item("spacer:${group.key}") { Spacer(Modifier.height(16.dp)) }
          }
        }
      }
    }
  }

  deleteTarget?.let { entry ->
    AlertDialog(
      onDismissRequest = { deleteTarget = null },
      title = { Text("Delete thread?") },
      text = { Text("This permanently deletes the thread from ${entry.environmentLabel}.") },
      confirmButton = {
        Button(onClick = {
          viewModel.archivedThreadAction(
            entry.environmentId,
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
private fun ArchivedThreadGroupHeader(group: ArchivedThreadGroup) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(start = 8.dp, top = 12.dp, end = 8.dp, bottom = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      Icons.Rounded.FolderOpen,
      contentDescription = null,
      tint = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.size(18.dp),
    )
    Spacer(Modifier.width(10.dp))
    Text(
      group.project.title.uppercase(),
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.labelLarge,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    Spacer(Modifier.width(12.dp))
    Text(
      group.environmentLabel,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.labelMedium,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ArchivedThreadRow(
  entry: ArchivedThreadEntry,
  first: Boolean,
  last: Boolean,
  onRestore: () -> Unit,
  onDelete: () -> Unit,
) {
  var menuOpen by remember { mutableStateOf(false) }
  val shape = when {
    first && last -> RoundedCornerShape(20.dp)
    first -> RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
    last -> RoundedCornerShape(bottomStart = 20.dp, bottomEnd = 20.dp)
    else -> RoundedCornerShape(0.dp)
  }

  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = Color(0xFF161618)),
    shape = shape,
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 12.dp, bottom = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(
        modifier = Modifier.size(48.dp).background(Color(0xFF202024), RoundedCornerShape(14.dp)),
        contentAlignment = Alignment.Center,
      ) {
        Icon(
          Icons.Rounded.Archive,
          contentDescription = null,
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(22.dp),
        )
      }
      Spacer(Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
          entry.thread.title,
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
          Icon(
            Icons.Rounded.AccountTree,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
          )
          Spacer(Modifier.width(5.dp))
          Text(
            listOfNotNull(entry.environmentLabel, entry.thread.branch).joinToString(" · "),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
      }
      Text(
        archivedThreadAgeLabel(entry.thread.archivedAt),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Box {
        IconButton(onClick = { menuOpen = true }) {
          Icon(Icons.Rounded.MoreVert, contentDescription = "Archived thread actions")
        }
        DropdownMenu(menuOpen, { menuOpen = false }, containerColor = Color(0xFF1C1C1F)) {
          DropdownMenuItem(
            text = { Text("Restore") },
            onClick = { menuOpen = false; onRestore() },
            leadingIcon = { Icon(Icons.Rounded.Unarchive, contentDescription = null) },
          )
          DropdownMenuItem(
            text = { Text("Delete") },
            onClick = { menuOpen = false; onDelete() },
            leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null) },
          )
        }
      }
    }
    if (!last) {
      HorizontalDivider(color = Color(0xFF27272A), modifier = Modifier.padding(start = 74.dp))
    }
  }
}

@Composable
private fun ClientStorageScreen(
  state: ClientStorageUiState,
  viewModel: AppViewModel,
  onBack: () -> Unit,
) {
  var clearEnvironment by remember { mutableStateOf<EnvironmentCacheSummary?>(null) }
  var clearAll by remember { mutableStateOf(false) }
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Client Storage", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
      if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
      NativeSettingsSection("Environment caches") {
        if (!state.loading && state.environments.isEmpty()) {
          Text("No cached data", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
        }
        state.environments.forEachIndexed { index, environment ->
          if (index > 0) HorizontalDivider(color = Color(0xFF27272A))
          Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(Modifier.weight(1f)) {
              Text(environment.environmentLabel)
              Text(
                "${environment.recordCount} records · ${formatStorageBytes(environment.payloadBytes)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
              )
            }
            TextButton(enabled = !state.clearing, onClick = { clearEnvironment = environment }) {
              Text("Clear", color = MaterialTheme.colorScheme.error)
            }
          }
        }
      }
      NativeSettingsSection("Actions") {
        NativeSettingsRow(
          icon = Icons.Rounded.Delete,
          label = if (state.payloadBytes > 0) "Clear ${formatStorageBytes(state.payloadBytes)}" else "Clear all caches",
          onClick = if (!state.clearing && state.recordCount > 0) ({ clearAll = true }) else null,
        )
      }
      Text(
        "Clearing caches removes offline snapshots only. Connections, credentials, drafts, and preferences stay intact.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
      )
      state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
  }

  clearEnvironment?.let { environment ->
    AlertDialog(
      onDismissRequest = { clearEnvironment = null },
      title = { Text("Clear cache for ${environment.environmentLabel}?") },
      text = { Text("Offline snapshots for this environment will be downloaded again when needed.") },
      confirmButton = {
        Button(onClick = { viewModel.clearCache(environment.environmentId); clearEnvironment = null }) { Text("Clear Cache") }
      },
      dismissButton = { TextButton(onClick = { clearEnvironment = null }) { Text("Cancel") } },
    )
  }
  if (clearAll) {
    AlertDialog(
      onDismissRequest = { clearAll = false },
      title = { Text("Clear all client caches?") },
      text = { Text("Offline snapshots for every environment will be removed. Saved connections stay intact.") },
      confirmButton = {
        Button(onClick = { viewModel.clearCache(null); clearAll = false }) { Text("Clear All Caches") }
      },
      dismissButton = { TextButton(onClick = { clearAll = false }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun LegalScreen(onBack: () -> Unit) {
  val context = LocalContext.current
  fun open(url: String) {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
  }
  BackHandler(onBack = onBack)
  Scaffold(topBar = { BackTopBar("Legal", onBack) }) { padding ->
    Column(
      Modifier.fillMaxSize().padding(padding).padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
      NativeSettingsSection("Documents") {
        NativeSettingsRow(Icons.Rounded.Info, "Legal", onClick = { open("https://t3.codes/legal?source=app") })
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.Info, "Privacy Policy", onClick = { open("https://t3.codes/privacy-policy?source=app") })
        HorizontalDivider(color = Color(0xFF27272A))
        NativeSettingsRow(Icons.Rounded.Info, "Terms of Service", onClick = { open("https://t3.codes/terms-of-service?source=app") })
      }
      Text("Documents open in your browser.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
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
  LaunchedEffect(draftRevision, draftKey) {
    val loaded = viewModel.loadDraft(draftKey)
    draft = loaded
  }
  val projectGroups = remember(runtime.shell.projects, runtime.settings.projectGroupingMode) {
    buildLogicalProjectGroups(runtime.shell.projects.values, runtime.settings.projectGroupingMode)
  }
  val projects = projectGroups.map(LogicalProjectGroup::representative)
  val projectLabels = projectGroups.associate { it.representative.id to it.label }
  fun groupedProjectId(id: String?): String? = projectGroups
    .firstOrNull { id != null && id in it.projectIds }
    ?.representative?.id
  var projectId by remember(environmentId, initialProjectId) {
    mutableStateOf(
      groupedProjectId(initialProjectId ?: draft.projectId) ?: projects.firstOrNull()?.id.orEmpty(),
    )
  }
  LaunchedEffect(projectGroups, initialProjectId) {
    val requested = groupedProjectId(initialProjectId)
    if (requested != null) projectId = requested
    else if (projects.none { it.id == projectId }) projectId = projects.firstOrNull()?.id.orEmpty()
  }
  val project = projects.firstOrNull { it.id == projectId }
  var worktree by remember(environmentId, projectId) {
    mutableStateOf(draft.isWorktree && draft.projectId == projectId)
  }
  var existingWorktreePath by remember(environmentId, projectId) {
    mutableStateOf(draft.worktreePath.takeIf { draft.projectId == projectId })
  }
  var baseBranch by remember(environmentId, projectId) {
    mutableStateOf(if (draft.isWorktree && draft.projectId == projectId) draft.branch.orEmpty() else "")
  }
  var startFromOrigin by remember(environmentId, projectId) { mutableStateOf(true) }
  var runSetup by remember(environmentId, projectId) { mutableStateOf(false) }

  LaunchedEffect(environmentId, projectId) {
    if (projectId.isNotBlank()) viewModel.loadNewTaskBranches(projectId)
  }
  val projectBranchesState = branchesState.takeIf {
    it.environmentId == environmentId && it.projectId == projectId
  } ?: NewTaskBranchesUiState(environmentId = environmentId, projectId = projectId, loading = true)
  val currentBranch = projectBranchesState.refs.firstOrNull { it.current }?.name
  val selectedExistingBranch = projectBranchesState.refs
    .firstOrNull { it.worktreePath == existingWorktreePath }
  val canStartFromOrigin = canStartWorktreeFromOrigin(baseBranch, projectBranchesState.refs)
  LaunchedEffect(worktree, projectBranchesState.refs, projectId) {
    if (worktree && baseBranch.isBlank()) {
      baseBranch = projectBranchesState.refs.firstOrNull { it.isDefault }?.name
        ?: projectBranchesState.refs.firstOrNull { it.current }?.name
        ?: ""
    }
  }
  LaunchedEffect(
    environmentId,
    projectId,
    worktree,
    baseBranch,
    currentBranch,
    existingWorktreePath,
    selectedExistingBranch,
  ) {
    val current = viewModel.loadDraft(draftKey)
    val next = current.copy(
      projectId = projectId.takeIf { it.isNotBlank() },
      branch = when {
        worktree -> baseBranch
        selectedExistingBranch != null -> selectedExistingBranch.name
        else -> currentBranch
      }?.takeIf { it.isNotBlank() },
      worktreePath = existingWorktreePath,
      isWorktree = worktree,
    )
    if (next != current) {
      draft = next
      viewModel.saveDraft(draftKey, next)
    }
  }
  LaunchedEffect(worktree, baseBranch, canStartFromOrigin) {
    if (worktree && !canStartFromOrigin) startFromOrigin = false
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
        projectLabels = projectLabels,
        selectedProjectId = projectId,
        onSelectProject = { projectId = it },
        onAddProject = onAddProject,
        projectRoot = project?.workspaceRoot,
        worktree = worktree,
        selectedWorktreePath = existingWorktreePath,
        onUseCurrentCheckout = {
          worktree = false
          existingWorktreePath = null
        },
        onCreateNewWorktree = {
          worktree = true
          existingWorktreePath = null
        },
        onCreateNewWorktreeFrom = { ref ->
          worktree = true
          existingWorktreePath = null
          baseBranch = ref.name
        },
        onUseExistingWorktree = { ref ->
          worktree = false
          existingWorktreePath = ref.worktreePath
        },
        branchesState = projectBranchesState,
        baseBranch = baseBranch,
        startFromOrigin = startFromOrigin,
        canStartFromOrigin = canStartFromOrigin,
        onStartFromOriginChange = { startFromOrigin = it },
        runSetup = runSetup,
        onRunSetupChange = { runSetup = it },
        onRefreshBranches = { viewModel.loadNewTaskBranches(projectId, force = true) },
        onLoadMoreBranches = { viewModel.loadMoreNewTaskBranches(projectId) },
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
              branch = if (existingWorktreePath != null) {
                selectedExistingBranch?.name ?: draft.branch
              } else {
                currentBranch
              },
              existingPath = existingWorktreePath,
              startFromOrigin = startFromOrigin,
              runSetupScript = runSetup,
            ),
          )
        },
        onInterrupt = null,
        viewModel = viewModel,
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
  projectLabels: Map<String, String>,
  selectedProjectId: String,
  onSelectProject: (String) -> Unit,
  onAddProject: () -> Unit,
  projectRoot: String?,
  worktree: Boolean,
  selectedWorktreePath: String?,
  onUseCurrentCheckout: () -> Unit,
  onCreateNewWorktree: () -> Unit,
  onCreateNewWorktreeFrom: (VcsRef) -> Unit,
  onUseExistingWorktree: (VcsRef) -> Unit,
  branchesState: NewTaskBranchesUiState,
  baseBranch: String,
  startFromOrigin: Boolean,
  canStartFromOrigin: Boolean,
  onStartFromOriginChange: (Boolean) -> Unit,
  runSetup: Boolean,
  onRunSetupChange: (Boolean) -> Unit,
  onRefreshBranches: () -> Unit,
  onLoadMoreBranches: () -> Unit,
) {
  var showProjects by remember { mutableStateOf(false) }
  var showEnvironments by remember { mutableStateOf(false) }
  var showWorkspace by remember { mutableStateOf(false) }
  val currentBranch = branchesState.refs.firstOrNull { it.current }?.name
  val refGroups = projectRoot?.let { groupNewTaskRefs(it, branchesState.refs) }
    ?: NewTaskRefGroups(emptyList(), emptyList(), emptyList())
  val existingWorktrees = refGroups.worktrees
  val selectedExistingWorktree = existingWorktrees.firstOrNull {
    it.worktreePath == selectedWorktreePath
  }
  val workspaceLabel = when {
    worktree && baseBranch.isNotBlank() -> "New · $baseBranch"
    worktree -> "New worktree"
    selectedExistingWorktree != null -> "Worktree · ${selectedExistingWorktree.name}"
    else -> currentBranch?.let { "Current · $it" } ?: "Current checkout"
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
          label = projectLabels[selectedProjectId]
            ?: projects.firstOrNull { it.id == selectedProjectId }?.title
            ?: "Project",
          onClick = { showProjects = true },
        )
        ComposerOptionsMenu(showProjects, { showProjects = false }) {
          ComposerMenuSection("Project")
          projects.forEach { project ->
            ComposerMenuChoice(
              label = projectLabels[project.id] ?: project.title,
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
            selected = !worktree && selectedWorktreePath == null,
            onClick = {
              showWorkspace = false
              onUseCurrentCheckout()
            },
          )
          ComposerMenuChoice(
            label = "New worktree",
            selected = worktree,
            onClick = {
              showWorkspace = false
              onCreateNewWorktree()
            },
          )
          existingWorktrees.forEach { ref ->
            ComposerMenuChoice(
              label = ref.name,
              description = ref.worktreePath,
              selected = ref.worktreePath == selectedWorktreePath,
              onClick = {
                showWorkspace = false
                onUseExistingWorktree(ref)
              },
            )
          }
          if (refGroups.localBranches.isNotEmpty()) {
            HorizontalDivider(color = Color(0xFF3F3F46))
            ComposerMenuSection("Local branches")
            refGroups.localBranches.forEach { ref ->
              ComposerMenuChoice(
                label = ref.name,
                description = if (ref.isDefault) "Default" else null,
                selected = worktree && ref.name == baseBranch,
                onClick = {
                  showWorkspace = false
                  onCreateNewWorktreeFrom(ref)
                },
              )
            }
          }
          if (refGroups.remoteBranches.isNotEmpty()) {
            HorizontalDivider(color = Color(0xFF3F3F46))
            ComposerMenuSection("Remote branches")
            refGroups.remoteBranches.forEach { ref ->
              ComposerMenuChoice(
                label = ref.name,
                description = ref.remoteName?.let { "Remote · $it" } ?: "Remote",
                selected = worktree && ref.name == baseBranch,
                onClick = {
                  showWorkspace = false
                  onCreateNewWorktreeFrom(ref)
                },
              )
            }
          }
          if (branchesState.loading && branchesState.refs.isEmpty()) {
            DropdownMenuItem(
              text = { Text("Loading branches…") },
              enabled = false,
              onClick = {},
            )
          } else if (branchesState.refs.isEmpty()) {
            DropdownMenuItem(
              text = { Text(branchesState.error ?: "No branches available") },
              enabled = false,
              onClick = {},
            )
          }
          if (branchesState.nextCursor != null) {
            HorizontalDivider(color = Color(0xFF3F3F46))
            DropdownMenuItem(
              text = {
                Text(
                  if (branchesState.loadingMore) "Loading more…"
                  else "Load more (${branchesState.refs.size}/${branchesState.totalCount})",
                )
              },
              enabled = !branchesState.loadingMore,
              onClick = onLoadMoreBranches,
            )
          }
          if (worktree) {
            HorizontalDivider(color = Color(0xFF3F3F46))
            ComposerMenuChoice(
              label = "Start from origin",
              description = if (canStartFromOrigin) {
                "Base the worktree on the latest origin branch"
              } else {
                "No matching origin branch"
              },
              selected = startFromOrigin,
              enabled = canStartFromOrigin,
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
          HorizontalDivider(color = Color(0xFF3F3F46))
          DropdownMenuItem(
            text = { Text("Refresh branches") },
            leadingIcon = { Icon(Icons.Rounded.Refresh, contentDescription = null) },
            onClick = {
              showWorkspace = false
              onRefreshBranches()
            },
          )
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
  wideContent: Boolean = false,
) {
  val liveDetail = runtime.thread.detail
  var leaving by remember(threadId) { mutableStateOf(false) }
  var retainedDetail by remember(threadId) { mutableStateOf(liveDetail) }
  LaunchedEffect(liveDetail) {
    if (liveDetail != null) retainedDetail = liveDetail
  }
  val detail = liveDetail ?: retainedDetail.takeIf { leaving }
  val leaveThread = {
    if (!leaving) {
      leaving = true
      onBack()
    }
  }
  val focusManager = LocalFocusManager.current
  LaunchedEffect(threadId) {
    focusManager.clearFocus(force = true)
    viewModel.selectThread(threadId)
    viewModel.observeGit(threadId)
  }
  LaunchedEffect(threadId, detail != null) {
    if (detail != null) focusManager.clearFocus(force = true)
  }
  BackHandler(onBack = leaveThread)
  val environment = runtime.environment ?: return
  val environmentId = environment.environmentId
  val draftRevision by viewModel.draftRevision.collectAsState()
  val draftKey = remember(environmentId, threadId) { DraftStore.threadKey(environmentId, threadId) }
  var draft by remember(draftKey) { mutableStateOf(viewModel.loadDraft(draftKey)) }
  LaunchedEffect(draftRevision, draftKey) { draft = viewModel.loadDraft(draftKey) }

  val activeThread = runtime.shell.threads[threadId]
  val titleText = activeThread?.title ?: detail?.summary?.title ?: "Thread"
  val branchName = gitState.status?.refName ?: activeThread?.branch ?: "main"
  val envLabel = environment.label

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column(
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(
              text = titleText,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
              color = Color.White,
            )
            Text(
              text = "$branchName · $envLabel",
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              style = MaterialTheme.typography.labelSmall,
              color = Color(0xFFA1A1AA),
            )
          }
        },
        navigationIcon = {
          IconButton(onClick = leaveThread) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 40.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              IconButton(
                onClick = onGit,
                enabled = detail != null,
                modifier = Modifier.size(40.dp),
              ) {
                Icon(Icons.Rounded.AccountTree, contentDescription = "Git")
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
      val contentModifier = if (wideContent) {
        Modifier.align(Alignment.Center).fillMaxHeight().widthIn(max = 960.dp).fillMaxWidth()
      } else {
        Modifier.fillMaxSize()
      }
      Box(contentModifier) {
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
                viewModel = viewModel,
              )
            }
          }.single().measure(constraints.copy(minHeight = 0))
          val feed = subcompose("feed") {
            ThreadFeed(
              detail = detail,
              page = runtime.thread.page,
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
}

@Composable
private fun ThreadFeed(
  detail: ThreadDetail,
  page: ThreadPage?,
  environmentId: String,
  viewModel: AppViewModel,
  modifier: Modifier = Modifier,
  state: LazyListState = rememberLazyListState(),
  contentPadding: PaddingValues = PaddingValues(16.dp),
  bottomAnchorKey: Int = 0,
) {
  val context = LocalContext.current
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
  val activeWork = deriveActiveWorkPresentation(latestTurn, detail.summary.session)
  val activeWorkStartedAt = activeWork?.startedAt
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
      activeWorkTurn = activeWork?.turn,
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
                    val turnStillRunning = latestTurn?.let {
                      message.turnId == it.id && (it.state == "running" || it.completedAt == null)
                    } == true
                    if (message.text.isNotBlank()) {
                      T3Markdown(
                        markdown = message.text,
                        streaming = message.streaming || turnStillRunning,
                      )
                    }
                    message.attachments.forEach { SentAttachmentImage(environmentId, it, viewModel) }
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
              Text(workToggleLabel(entry))
            }

            is ThreadFeedItem.Working -> Row(
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              modifier = Modifier
                .padding(vertical = 7.dp),
            ) {
              WorkingSweepIndicator()
              WorkingStatusText(entry.createdAt, entry.stepLabel)
            }
        }
      }
    }
      if (page?.hasMore == true || page?.loadingOlder == true) {
        item(key = "load-earlier-turns") {
          TextButton(
            onClick = viewModel::loadOlderTurns,
            enabled = !page.loadingOlder,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(if (page.loadingOlder) "Loading earlier turns…" else "Load earlier turns")
          }
        }
      }
    }
  }

@Composable
private fun WorkingSweepIndicator() {
  val transition = rememberInfiniteTransition(label = "working-indicator")
  val position by transition.animateFloat(
    initialValue = 0f,
    targetValue = 1f,
    animationSpec = infiniteRepeatable(
      animation = tween(durationMillis = 650, easing = LinearEasing),
      repeatMode = RepeatMode.Reverse,
    ),
    label = "working-indicator-position",
  )
  val travel = with(LocalDensity.current) { 18.dp.toPx() }
  Box(
    Modifier
      .width(28.dp)
      .height(2.dp)
      .clip(RoundedCornerShape(1.dp))
      .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f)),
  ) {
    Box(
      Modifier
        .width(10.dp)
        .fillMaxHeight()
        .graphicsLayer { translationX = travel * position }
        .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(1.dp)),
    )
  }
}

@Composable
private fun WorkingStatusText(startedAt: String, stepLabel: String?) {
  var now by remember(startedAt) { mutableStateOf(Instant.now().toString()) }
  LaunchedEffect(startedAt) {
    while (true) {
      now = Instant.now().toString()
      delay(1_000)
    }
  }
  val elapsed = formatWorkingTimer(startedAt, now) ?: "0s"
  Text(
    stepLabel?.let { "Working for $elapsed · $it" } ?: "Working for $elapsed",
    style = MaterialTheme.typography.labelMedium,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
  )
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
  if (entry is ThreadFeedItem.ActivityGroup) {
    val alpha by animateFloatAsState(
      targetValue = if (visible) 1f else 0f,
      animationSpec = tween(MESSAGE_ENTRY_MILLIS),
      label = "tool-call-entry",
    )
    Column(Modifier.graphicsLayer { this.alpha = alpha }) {
      content()
    }
  } else {
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
        Row(
          modifier = Modifier.weight(1f),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text(
            text = activity.summary,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = Color.White,
            maxLines = 1,
          )
          activity.detail?.takeIf { !expanded }?.let {
            Text(
              text = it,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.weight(1f),
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
  val sizes = resolveMarkdownFontSizes(LocalT3Appearance.current.baseFontSize)
  Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    segments.forEach { segment ->
      when (segment) {
        is ReviewMessageSegment.Text -> segment.value.trim().takeIf(String::isNotEmpty)?.let {
          Text(it, fontSize = sizes.body.sp, lineHeight = sizes.bodyLineHeight.sp)
        }
        is ReviewMessageSegment.Comment -> ReviewCommentCard(segment.value)
      }
    }
  }
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
  enabled: Boolean = true,
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
    enabled = enabled,
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
private fun ComposerModelChoices(
  models: List<ProviderModel>,
  legacyExpanded: Boolean,
  selectedInstanceId: String?,
  selectedModelId: String?,
  selectedOptions: JsonElement?,
  draft: ComposerDraft,
  onToggleLegacy: () -> Unit,
  onSelect: (ComposerDraft) -> Unit,
) {
  val sections = remember(models) { providerModelSections(models) }
  sections.current.forEach { model ->
    ComposerModelChoice(
      model = model,
      selectedInstanceId = selectedInstanceId,
      selectedModelId = selectedModelId,
      selectedOptions = selectedOptions,
      draft = draft,
      onSelect = onSelect,
    )
  }
  if (sections.legacy.isNotEmpty()) {
    DropdownMenuItem(
      text = {
        Column {
          Text("Legacy models", fontWeight = FontWeight.SemiBold)
          Text(
            "${sections.legacy.size} model${if (sections.legacy.size == 1) "" else "s"}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      },
      onClick = onToggleLegacy,
      trailingIcon = {
        Icon(
          Icons.Rounded.ChevronRight,
          contentDescription = null,
          modifier = Modifier.graphicsLayer { rotationZ = if (legacyExpanded) 90f else 0f },
        )
      },
    )
    if (legacyExpanded) {
      sections.legacy.forEach { model ->
        ComposerModelChoice(
          model = model,
          selectedInstanceId = selectedInstanceId,
          selectedModelId = selectedModelId,
          selectedOptions = selectedOptions,
          draft = draft,
          onSelect = onSelect,
        )
      }
    }
  }
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
  viewModel: AppViewModel? = null,
) {
  var showModelMenu by remember { mutableStateOf(false) }
  var showAccessMenu by remember { mutableStateOf(false) }
  var showTraitsMenu by remember { mutableStateOf(false) }
  var showStashSheet by remember { mutableStateOf(false) }
  val stashedEntries by (viewModel?.promptStashEntries ?: MutableStateFlow(emptyList())).collectAsState()

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
  var expandedLegacyProviderIds by remember { mutableStateOf(emptySet<String>()) }
  LaunchedEffect(selectedModel?.instanceId, selectedModel?.model) {
    selectedLegacyModelInstance(selectedModel)?.let { instanceId ->
      expandedLegacyProviderIds += instanceId
    }
  }
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
                    val instanceId = selectedModel?.instanceId ?: availableModels.firstOrNull()?.instanceId
                    ComposerModelChoices(
                      models = availableModels,
                      legacyExpanded = instanceId in expandedLegacyProviderIds,
                      selectedInstanceId = selectedInstanceId,
                      selectedModelId = selectedModelId,
                      selectedOptions = selectedOptions,
                      draft = draft,
                      onToggleLegacy = {
                        if (instanceId != null) {
                          expandedLegacyProviderIds = if (instanceId in expandedLegacyProviderIds) {
                            expandedLegacyProviderIds - instanceId
                          } else {
                            expandedLegacyProviderIds + instanceId
                          }
                        }
                      },
                      onSelect = { next ->
                        showModelMenu = false
                        onDraftUpdate(next)
                      },
                    )
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
                        ComposerModelChoices(
                          models = group,
                          legacyExpanded = provider.instanceId in expandedLegacyProviderIds,
                          selectedInstanceId = selectedInstanceId,
                          selectedModelId = selectedModelId,
                          selectedOptions = selectedOptions,
                          draft = draft,
                          onToggleLegacy = {
                            expandedLegacyProviderIds =
                              if (provider.instanceId in expandedLegacyProviderIds) {
                                expandedLegacyProviderIds - provider.instanceId
                              } else {
                                expandedLegacyProviderIds + provider.instanceId
                              }
                          },
                          onSelect = { next ->
                            showModelMenu = false
                            onDraftUpdate(next)
                          },
                        )
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

            // Right side: Stop button overlays Send button when active with no text, slides left when typing
            val canSend = enabled && (draft.text.isNotBlank() || draft.attachments.isNotEmpty()) && !sending
            val stopOffsetX by animateDpAsState(
              targetValue = if (active && canSend) (-44).dp else 0.dp,
              animationSpec = tween(220),
              label = "stopButtonOffset",
            )

            Box(
              modifier = Modifier
                .height(38.dp)
                .width(38.dp),
              contentAlignment = Alignment.CenterEnd,
            ) {
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

              if (active) {
                IconButton(
                  onClick = { onInterrupt?.invoke() },
                  modifier = Modifier
                    .offset(x = stopOffsetX)
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
            }
          }
        }
      }
      contextWindowUsage?.let { usage ->
        Box(Modifier.matchParentSize()) {
          ContextWindowMeter(
            usage = usage,
            modifier = Modifier
              .align(Alignment.CenterEnd)
              .padding(top = 20.dp, bottom = 20.dp, end = 3.dp)
              .fillMaxHeight(),
          )
        }
      }
      val canStash = plainText.isNotBlank() || draft.attachments.isNotEmpty()
      if (stashedEntries.isNotEmpty() || canStash) {
        StashButton(
          stashedCount = stashedEntries.size,
          canStash = canStash,
          onStash = {
            if (viewModel != null) {
              val ok = viewModel.stashDraft(
                text = plainText,
                attachments = draft.attachments,
              )
              if (ok) {
                onDraftUpdate(draft.copy(text = "", attachments = emptyList()))
              }
            }
          },
          onOpenStash = { showStashSheet = true },
          modifier = Modifier
            .align(Alignment.TopEnd)
            .offset(x = (-16).dp, y = (-12).dp),
        )
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
    if (showStashSheet && viewModel != null) {
      StashBottomSheet(
        entries = stashedEntries,
        onRestore = { entry ->
          val item = viewModel.takeStashEntry(entry.id)
          if (item != null) {
            onDraftUpdate(
              draft.copy(
                text = appendStashedText(draft.text, item.text),
                attachments = draft.attachments + item.attachments,
              ),
            )
          }
        },
        onDelete = { id -> viewModel.deleteStashEntry(id) },
        onDismiss = { showStashSheet = false },
      )
    }
  }
}

@Composable
private fun ContextWindowMeter(
  usage: ContextWindowUsage,
  modifier: Modifier = Modifier,
) {
  val meterColor = if (usage.usedPercentage > 90f) Color(0xFFF87171) else Color(0xFFE4E4E7)
  val animatedFraction by animateFloatAsState(
    targetValue = usage.fraction.coerceIn(0.05f, 1f),
    animationSpec = tween(durationMillis = 350),
    label = "context-window-fill",
  )
  Box(
    modifier = modifier
      .width(3.dp)
      .clip(CircleShape)
      .background(Color(0xFF27272A)),
  ) {
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .fillMaxHeight(animatedFraction)
        .align(Alignment.BottomCenter)
        .clip(CircleShape)
        .background(meterColor),
    )
  }
}

@Composable
private fun StashButton(
  stashedCount: Int,
  canStash: Boolean,
  onStash: () -> Unit,
  onOpenStash: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val haptic = LocalHapticFeedback.current
  var totalDragX by remember { mutableFloatStateOf(0f) }
  var totalDragY by remember { mutableFloatStateOf(0f) }

  Surface(
    shape = RoundedCornerShape(12.dp),
    color = Color(0xFF27272A),
    border = BorderStroke(1.dp, Color(0xFF3F3F46)),
    modifier = modifier
      .height(26.dp)
      .pointerInput(canStash) {
        detectTapGestures(
          onTap = { onOpenStash() },
        )
      }
      .pointerInput(canStash) {
        detectDragGestures(
          onDragStart = {
            totalDragX = 0f
            totalDragY = 0f
          },
          onDrag = { change, dragAmount ->
            change.consume()
            totalDragX += dragAmount.x
            totalDragY += dragAmount.y
          },
          onDragEnd = {
            val isFlick = totalDragY < -20f || abs(totalDragX) > 24f
            if (isFlick && canStash) {
              haptic.performHapticFeedback(HapticFeedbackType.LongPress)
              onStash()
            }
            totalDragX = 0f
            totalDragY = 0f
          },
        )
      },
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(
        text = if (stashedCount > 0) "Stash ($stashedCount)" else "Stash",
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = Color.White,
      )
    }
  }
}

@Composable
private fun StashBottomSheet(
  entries: List<PromptStashEntry>,
  onRestore: (PromptStashEntry) -> Unit,
  onDelete: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    containerColor = Color(0xFF18181B),
    dragHandle = { BottomSheetDefaults.DragHandle(color = Color(0xFF3F3F46)) },
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
      Text(
        text = "Stashed Prompts",
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold,
        color = Color.White,
        modifier = Modifier.padding(bottom = 12.dp),
      )

      if (entries.isEmpty()) {
        Text(
          text = "No stashed prompts. Flick the Stash button on the composer to stash your text.",
          style = MaterialTheme.typography.bodyMedium,
          color = Color(0xFFA1A1AA),
          modifier = Modifier.padding(vertical = 16.dp),
        )
      } else {
        LazyColumn(
          modifier = Modifier.fillMaxWidth(),
          verticalArrangement = Arrangement.spacedBy(8.dp),
          contentPadding = PaddingValues(bottom = 24.dp),
        ) {
          items(entries, key = { it.id }) { entry ->
            Surface(
              shape = RoundedCornerShape(12.dp),
              color = Color(0xFF27272A),
              border = BorderStroke(1.dp, Color(0xFF3F3F46)),
              modifier = Modifier
                .fillMaxWidth()
                .clickable {
                  onRestore(entry)
                  onDismiss()
                },
            ) {
              Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
              ) {
                Column(modifier = Modifier.weight(1f)) {
                  Text(
                    text = entry.text.ifBlank { "(${entry.attachments.size} image attachments)" },
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                  )
                  if (entry.attachments.isNotEmpty()) {
                    Text(
                      text = "${entry.attachments.size} image${if (entry.attachments.size == 1) "" else "s"}",
                      style = MaterialTheme.typography.labelSmall,
                      color = MaterialTheme.colorScheme.primary,
                      modifier = Modifier.padding(top = 2.dp),
                    )
                  }
                }

                IconButton(
                  onClick = { onDelete(entry.id) },
                  modifier = Modifier.size(32.dp),
                ) {
                  Icon(
                    imageVector = Icons.Rounded.Delete,
                    contentDescription = "Delete stash",
                    tint = Color(0xFFF87171),
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
internal fun BackTopBar(title: String, onBack: () -> Unit) {
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
