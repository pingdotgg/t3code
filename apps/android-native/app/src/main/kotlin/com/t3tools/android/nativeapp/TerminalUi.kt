@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.t3tools.android.nativeapp

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.KeyboardHide
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.t3tools.android.protocol.TerminalStatus
import expo.modules.t3terminal.TerminalSurfaceView
import kotlinx.coroutines.flow.collect

private const val TERMINAL_BACKGROUND = "#09090B"
private const val TERMINAL_FOREGROUND = "#F4F4F5"

private enum class TerminalConfirmation { Restart, Close }

private sealed interface TerminalToolbarAction {
  val key: String
  val label: String

  data class Send(
    override val key: String,
    override val label: String,
    val data: String,
  ) : TerminalToolbarAction

  data class Modifier(
    override val key: String,
    override val label: String,
    val modifier: PendingTerminalModifier,
  ) : TerminalToolbarAction

  data object Clear : TerminalToolbarAction {
    override val key = "clear"
    override val label = "clear"
  }
}

@Composable
fun TerminalScreen(
  threadId: String,
  terminalId: String,
  environmentId: String,
  environmentLabel: String,
  connectionPhase: ConnectionPhase,
  fontSize: Float,
  viewModel: AppViewModel,
  onBack: () -> Unit,
  onSelectTerminal: (String) -> Unit,
  onNewTerminal: () -> Unit,
) {
  val state by viewModel.terminalState.collectAsState()
  val targetKey = "$environmentId:$threadId:$terminalId"
  var surface by remember(targetKey) { mutableStateOf<TerminalSurfaceView?>(null) }
  var menuExpanded by remember { mutableStateOf(false) }
  var pendingModifier by remember(terminalId) { mutableStateOf<PendingTerminalModifier?>(null) }
  var confirmation by remember { mutableStateOf<TerminalConfirmation?>(null) }
  var accessoryDismissed by remember { mutableStateOf(false) }
  val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
  val hostPlatform = remember(environmentLabel) { inferTerminalHostPlatform(environmentLabel) }
  val toolbarActions = remember(hostPlatform) { terminalToolbarActions(hostPlatform) }
  val current = state.target?.takeIf { it.key == targetKey }
  val handleInput: (String) -> Unit = { data ->
    if (data.isNotEmpty() && state.status == TerminalStatus.Running) {
      val (nextModifier, input) = consumeTerminalModifier(pendingModifier, data)
      pendingModifier = nextModifier
      viewModel.writeTerminal(input)
    }
  }

  LaunchedEffect(targetKey, viewModel) {
    viewModel.terminalRenderCommands.collect { command ->
      if (command.targetKey != targetKey) return@collect
      when (command) {
        is TerminalRenderCommand.Reset -> surface?.reset(command.buffer)
        is TerminalRenderCommand.Append -> surface?.append(command.data)
        is TerminalRenderCommand.Clear -> surface?.clear()
      }
    }
  }
  LaunchedEffect(threadId, terminalId) {
    viewModel.openTerminalRoute(threadId, terminalId)
  }
  LaunchedEffect(keyboardVisible) {
    if (keyboardVisible) accessoryDismissed = false
  }
  LaunchedEffect(targetKey, surface, state.status) {
    if (state.status == TerminalStatus.Running) surface?.requestKeyboardFocus()
  }
  DisposableEffect(targetKey) {
    onDispose { viewModel.stopTerminalRoute(targetKey) }
  }

  Scaffold(
    containerColor = Color.Black,
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text(
              state.label.ifBlank { "Terminal" },
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.SemiBold,
            )
            Text(
              current?.cwd?.substringAfterLast('/')?.ifBlank { current.cwd } ?: terminalId,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
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
          Box {
            IconButton(onClick = { menuExpanded = true }) {
              Icon(Icons.Rounded.MoreVert, contentDescription = "Terminal options")
            }
            TerminalOptionsMenu(
              expanded = menuExpanded,
              state = state,
              terminalId = terminalId,
              fontSize = fontSize,
              onDismiss = { menuExpanded = false },
              onFontSize = viewModel::updateTerminalFontSize,
              onSelectTerminal = {
                pendingModifier = null
                menuExpanded = false
                onSelectTerminal(it)
              },
              onNewTerminal = {
                pendingModifier = null
                menuExpanded = false
                onNewTerminal()
              },
              onRestart = {
                menuExpanded = false
                if (state.hasRunningSubprocess) confirmation = TerminalConfirmation.Restart
                else viewModel.restartTerminal()
              },
              onClose = {
                menuExpanded = false
                if (state.hasRunningSubprocess) confirmation = TerminalConfirmation.Close
                else viewModel.closeTerminal()
              },
            )
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black),
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding)) {
      Column(Modifier.fillMaxSize().imePadding()) {
        if (connectionPhase != ConnectionPhase.Connected) {
          TerminalConnectionNotice(connectionPhase, viewModel::retryConnection)
        }
        AndroidView(
          factory = { context ->
            TerminalSurfaceView(context).apply {
              terminalKey = targetKey
              backgroundColorHex = TERMINAL_BACKGROUND
              foregroundColorHex = TERMINAL_FOREGROUND
              this.fontSize = fontSize
              onInput = handleInput
              onResize = viewModel::resizeTerminal
              reset(viewModel.terminalReplayBuffer(targetKey))
              autoFocus = true
              surface = this
            }
          },
          update = { terminal ->
            if (terminal.terminalKey != targetKey) {
              terminal.terminalKey = targetKey
              terminal.reset(viewModel.terminalReplayBuffer(targetKey))
            }
            terminal.fontSize = fontSize
            terminal.onInput = handleInput
            terminal.onResize = viewModel::resizeTerminal
            if (surface !== terminal) surface = terminal
          },
          onRelease = { terminal ->
            if (surface === terminal) surface = null
            terminal.cleanup()
          },
          modifier = Modifier.fillMaxWidth().weight(1f).background(Color(0xFF09090B)),
        )
        if (keyboardVisible && !accessoryDismissed) {
          TerminalAccessoryBar(
            actions = toolbarActions,
            pendingModifier = pendingModifier,
            onAction = { action ->
              when (action) {
                is TerminalToolbarAction.Modifier -> {
                  pendingModifier = if (pendingModifier == action.modifier) null else action.modifier
                }
                TerminalToolbarAction.Clear -> {
                  pendingModifier = null
                  viewModel.clearTerminal()
                }
                is TerminalToolbarAction.Send -> {
                  handleInput(action.data)
                }
              }
            },
            onDismissKeyboard = {
              accessoryDismissed = true
              surface?.dismissKeyboard()
            },
          )
        }
      }

      if (!keyboardVisible || accessoryDismissed) {
        Surface(
          onClick = { surface?.requestKeyboardFocus() },
          shape = RoundedCornerShape(24.dp),
          color = Color(0xFF18181B),
          border = BorderStroke(1.dp, Color(0xFF3F3F46)),
          modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).size(48.dp),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Keyboard, contentDescription = "Show keyboard")
          }
        }
      }

      if (state.loading || state.operation != null) {
        Row(
          modifier = Modifier.align(Alignment.TopCenter).padding(top = 12.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
          Text(state.operation ?: "Opening terminal…", style = MaterialTheme.typography.labelMedium)
        }
      }
      state.error?.let { error ->
        Surface(
          color = Color(0xFF2A1014),
          shape = RoundedCornerShape(10.dp),
          modifier = Modifier.align(Alignment.TopCenter).padding(12.dp),
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(error, modifier = Modifier.weight(1f), color = Color(0xFFFDA4AF), maxLines = 2)
            TextButton(onClick = viewModel::retryTerminal) { Text("Retry") }
          }
        }
      }
    }
  }

  confirmation?.let { action ->
    AlertDialog(
      onDismissRequest = { confirmation = null },
      title = { Text(if (action == TerminalConfirmation.Close) "Close terminal?" else "Restart terminal?") },
      text = { Text("A subprocess is still running in this terminal.") },
      confirmButton = {
        Button(onClick = {
          confirmation = null
          if (action == TerminalConfirmation.Close) viewModel.closeTerminal()
          else viewModel.restartTerminal()
        }) { Text(if (action == TerminalConfirmation.Close) "Close" else "Restart") }
      },
      dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun TerminalOptionsMenu(
  expanded: Boolean,
  state: TerminalUiState,
  terminalId: String,
  fontSize: Float,
  onDismiss: () -> Unit,
  onFontSize: (Float) -> Unit,
  onSelectTerminal: (String) -> Unit,
  onNewTerminal: () -> Unit,
  onRestart: () -> Unit,
  onClose: () -> Unit,
) {
  DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
    DropdownMenuItem(
      text = { Text(terminalStatusLabel(state.status, state.hasRunningSubprocess)) },
      onClick = {},
      enabled = false,
    )
    DropdownMenuItem(
      text = { Text("Text size  ${"%.1f".format(fontSize)} pt") },
      onClick = {},
      trailingIcon = {
        Row {
          Text(
            "A−",
            modifier = Modifier.clickable(enabled = fontSize > 6f) { onFontSize(fontSize - 0.5f) }
              .padding(10.dp),
          )
          Text(
            "A+",
            modifier = Modifier.clickable(enabled = fontSize < 14f) { onFontSize(fontSize + 0.5f) }
              .padding(10.dp),
          )
        }
      },
    )
    HorizontalDivider()
    state.sessions.forEach { session ->
      DropdownMenuItem(
        text = {
          Column {
            Text(session.label.ifBlank { session.terminalId })
            Text(
              "${terminalStatusLabel(session.status, session.hasRunningSubprocess)} · ${session.cwd.substringAfterLast('/')}",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        },
        onClick = { onSelectTerminal(session.terminalId) },
        leadingIcon = if (session.terminalId == terminalId) {
          { Icon(Icons.Rounded.Check, contentDescription = null) }
        } else null,
      )
    }
    DropdownMenuItem(
      text = { Text("Open new terminal") },
      onClick = onNewTerminal,
      leadingIcon = { Icon(Icons.Rounded.Add, contentDescription = null) },
    )
    HorizontalDivider()
    DropdownMenuItem(text = { Text("Restart shell") }, onClick = onRestart)
    DropdownMenuItem(text = { Text("Close terminal") }, onClick = onClose)
  }
}

@Composable
private fun TerminalAccessoryBar(
  actions: List<TerminalToolbarAction>,
  pendingModifier: PendingTerminalModifier?,
  onAction: (TerminalToolbarAction) -> Unit,
  onDismissKeyboard: () -> Unit,
) {
  Surface(
    color = Color(0xFF09090B),
    border = BorderStroke(1.dp, Color(0xFF27272A)),
    modifier = Modifier.fillMaxWidth().height(52.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Row(
        modifier = Modifier.weight(1f).fillMaxHeight().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        actions.forEach { action ->
          val active = action is TerminalToolbarAction.Modifier &&
            action.modifier == pendingModifier
          Surface(
            onClick = { onAction(action) },
            color = if (active) MaterialTheme.colorScheme.primary else Color(0xFF18181B),
            contentColor = if (active) Color.Black else Color(0xFFF4F4F5),
            border = BorderStroke(1.dp, if (active) MaterialTheme.colorScheme.primary else Color(0xFF3F3F46)),
            shape = RoundedCornerShape(9.dp),
            modifier = Modifier.height(40.dp),
          ) {
            Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
              Text(
                action.label,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
              )
            }
          }
        }
      }
      Spacer(Modifier.width(6.dp))
      IconButton(onClick = onDismissKeyboard) {
        Icon(Icons.Rounded.KeyboardHide, contentDescription = "Dismiss keyboard")
      }
    }
  }
}

@Composable
private fun TerminalConnectionNotice(phase: ConnectionPhase, onRetry: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth().background(Color(0xFF2A1D08)).padding(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      if (phase == ConnectionPhase.Connecting || phase == ConnectionPhase.Backoff) {
        "Reconnecting to environment…"
      } else {
        "Terminal is offline."
      },
      modifier = Modifier.weight(1f),
      color = Color(0xFFFDE68A),
    )
    TextButton(onClick = onRetry) { Text("Retry") }
  }
}

private fun terminalToolbarActions(host: TerminalHostPlatform): List<TerminalToolbarAction> {
  val modifiers = if (host == TerminalHostPlatform.Mac) {
    listOf(
      TerminalToolbarAction.Modifier("cmd", "cmd", PendingTerminalModifier.Meta),
      TerminalToolbarAction.Modifier("ctrl", "ctrl", PendingTerminalModifier.Ctrl),
    )
  } else {
    listOf(
      TerminalToolbarAction.Modifier("ctrl", "ctrl", PendingTerminalModifier.Ctrl),
      TerminalToolbarAction.Modifier("alt", "alt", PendingTerminalModifier.Meta),
    )
  }
  return listOf(TerminalToolbarAction.Send("esc", "esc", "\u001b")) + modifiers + listOf(
    TerminalToolbarAction.Send("tab", "tab", "\t"),
    TerminalToolbarAction.Clear,
    TerminalToolbarAction.Send("up", "↑", "\u001b[A"),
    TerminalToolbarAction.Send("down", "↓", "\u001b[B"),
    TerminalToolbarAction.Send("left", "←", "\u001b[D"),
    TerminalToolbarAction.Send("right", "→", "\u001b[C"),
    TerminalToolbarAction.Send("tilde", "~", "~"),
    TerminalToolbarAction.Send("pipe", "|", "|"),
    TerminalToolbarAction.Send("slash", "/", "/"),
    TerminalToolbarAction.Send("dash", "-", "-"),
  )
}

private fun terminalStatusLabel(status: TerminalStatus, hasRunningSubprocess: Boolean) = when {
  status == TerminalStatus.Running && hasRunningSubprocess -> "Process running"
  status == TerminalStatus.Running -> "Shell ready"
  status == TerminalStatus.Starting -> "Starting"
  status == TerminalStatus.Exited -> "Exited"
  status == TerminalStatus.Error -> "Error"
  else -> "Closed"
}
