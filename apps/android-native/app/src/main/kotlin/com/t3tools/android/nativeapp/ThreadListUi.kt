@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.t3tools.android.nativeapp

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.decode.SvgDecoder
import com.t3tools.android.protocol.ThreadSummary
import java.time.Instant
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

private val StatusApproval = Color(0xFFF59E0B)
private val StatusWorking = Color(0xFF38BDF8)
private val StatusFailed = Color(0xFFEF4444)
private val StatusReady = Color(0xFF3F3F46)
private val StatusInput = Color(0xFFA78BFA)
internal val SettleColor = Color(0xFF007AFF)
internal val SnoozeColor = Color(0xFF5856D6)
internal val UnsnoozeColor = Color(0xFF0A84FF)
private val ScreenBg = Color(0xFF000000)

private val SwipeSpring = spring<Float>(
  dampingRatio = 0.86f,
  stiffness = Spring.StiffnessMediumLow,
)

@Composable
fun ThreadListV2ShelfHeader(
  label: String,
  count: Int,
  expanded: Boolean,
  accent: Color = MaterialTheme.colorScheme.onSurfaceVariant,
  onToggle: () -> Unit,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .combinedClickable(onClick = onToggle)
      .padding(top = 14.dp, bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      text = if (expanded) label else "$label ($count)",
      style = MaterialTheme.typography.labelMedium,
      color = accent,
      fontWeight = FontWeight.SemiBold,
    )
    Box(
      Modifier
        .weight(1f)
        .height(1.dp)
        .background(accent.copy(alpha = 0.25f)),
    )
    Text(
      text = if (expanded) "▾" else "▸",
      style = MaterialTheme.typography.labelSmall,
      color = accent,
    )
  }
}

@Composable
fun ThreadListV2Row(
  item: ThreadListV2Item,
  capabilities: ThreadCapabilities,
  compact: Boolean,
  projectTitle: String?,
  providerDriver: String?,
  faviconUrl: String? = null,
  newPinOrderKey: String? = null,
  canMovePinnedUp: Boolean = false,
  canMovePinnedDown: Boolean = false,
  onOpen: () -> Unit,
  onAction: (command: String, value: String?) -> Unit,
  onMovePinned: (direction: Int) -> Unit = {},
) {
  val thread = item.thread
  val settlement = capabilities.settlement
  val snooze = capabilities.snooze
  val primary = resolveThreadListV2SwipePrimary(item.variant, item.snoozed, settlement)
  val snoozable = canSnoozeThread(thread)
  val showSnooze = resolveThreadListV2SwipeSecondary(item.snoozed, snooze, snoozable)
  var menuOpen by remember(thread.id) { mutableStateOf(false) }
  var confirmDelete by remember(thread.id) { mutableStateOf(false) }
  var snoozePicker by remember(thread.id) { mutableStateOf(false) }

  Box(Modifier.fillMaxWidth()) {
    if (primary == null) {
      Box(
        Modifier.combinedClickable(
          onClick = onOpen,
          onLongClick = { menuOpen = true },
        ),
      ) {
        ThreadListV2RowContent(
          item = item,
          compact = compact,
          projectTitle = projectTitle,
          providerDriver = providerDriver,
          faviconUrl = faviconUrl,
        )
      }
    } else {
      val primaryLabel = when (primary) {
        ThreadListV2SwipePrimary.Settle -> "Settle"
        ThreadListV2SwipePrimary.Unsettle -> "Unsettle"
        ThreadListV2SwipePrimary.Unsnooze -> "Wake"
      }
      val primaryIcon = when (primary) {
        ThreadListV2SwipePrimary.Settle -> Icons.Rounded.Check
        ThreadListV2SwipePrimary.Unsettle -> Icons.AutoMirrored.Rounded.Undo
        ThreadListV2SwipePrimary.Unsnooze -> Icons.Rounded.WbSunny
      }
      val primaryColor = when (primary) {
        ThreadListV2SwipePrimary.Settle, ThreadListV2SwipePrimary.Unsettle -> SettleColor
        ThreadListV2SwipePrimary.Unsnooze -> UnsnoozeColor
      }
      SwipeThreadRow(
        primaryLabel = primaryLabel,
        primaryIcon = primaryIcon,
        primaryColor = primaryColor,
        onPrimary = { runPrimary(primary, onAction) },
        secondaryLabel = if (showSnooze) "Snooze" else null,
        secondaryIcon = if (showSnooze) Icons.Rounded.Schedule else null,
        secondaryColor = SnoozeColor,
        onSecondary = if (showSnooze) {
          { onAction("thread.snooze", Instant.now().plusSeconds(3_600).toString()) }
        } else {
          null
        },
        onClick = onOpen,
        onLongClick = { menuOpen = true },
      ) {
        ThreadListV2RowContent(
          item = item,
          compact = compact,
          projectTitle = projectTitle,
          providerDriver = providerDriver,
          faviconUrl = faviconUrl,
        )
      }
    }

    if (menuOpen) {
      ThreadContextMenuBottomSheet(
        item = item,
        capabilities = capabilities,
        projectTitle = projectTitle,
        onDismiss = { menuOpen = false },
        onAction = onAction,
        newPinOrderKey = newPinOrderKey,
        canMovePinnedUp = canMovePinnedUp,
        canMovePinnedDown = canMovePinnedDown,
        onMovePinned = onMovePinned,
        onSnoozePicker = { snoozePicker = true },
        onConfirmDelete = { confirmDelete = true },
      )
    }
  }

  if (confirmDelete) {
    AlertDialog(
      onDismissRequest = { confirmDelete = false },
      title = { Text("Delete thread?") },
      text = { Text("This permanently deletes the thread from the environment.") },
      confirmButton = {
        Button(
          onClick = {
            onAction("thread.delete", null)
            confirmDelete = false
          },
        ) { Text("Delete") }
      },
      dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )
  }

  if (snoozePicker) {
    val presets = remember { resolveSnoozePresets() }
    AlertDialog(
      onDismissRequest = { snoozePicker = false },
      title = { Text("Snooze") },
      text = {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          presets.forEach { preset ->
            TextButton(
              onClick = {
                onAction("thread.snooze", preset.snoozedUntil.toString())
                snoozePicker = false
              },
              modifier = Modifier.fillMaxWidth(),
            ) { Text(preset.label) }
          }
        }
      },
      confirmButton = {},
      dismissButton = { TextButton(onClick = { snoozePicker = false }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun ThreadListV2RowContent(
  item: ThreadListV2Item,
  compact: Boolean,
  projectTitle: String?,
  providerDriver: String?,
  faviconUrl: String? = null,
) {
  val thread = item.thread
  val status = resolveThreadListV2Status(thread)
  val statusColor = when (status) {
    ThreadListV2Status.Approval -> StatusApproval
    ThreadListV2Status.Input -> StatusInput
    ThreadListV2Status.Working -> StatusWorking
    ThreadListV2Status.Failed -> StatusFailed
    ThreadListV2Status.Ready -> StatusReady
  }
  val statusLabel = when (status) {
    ThreadListV2Status.Approval -> "Approval"
    ThreadListV2Status.Input -> "Input"
    ThreadListV2Status.Working -> "Working"
    ThreadListV2Status.Failed -> "Failed"
    ThreadListV2Status.Ready -> null
  }
  val time = if (item.snoozed) {
    snoozeWakeLabel(thread.snoozedUntil)
  } else {
    relativeTimeLabel(thread.updatedAt)
  }
  val padV = when {
    compact || item.variant == ThreadListV2Variant.Slim -> 8.dp
    else -> 10.dp
  }
  val surface = if (item.variant == ThreadListV2Variant.Slim) {
    Color(0xFF0A0A0C)
  } else {
    MaterialTheme.colorScheme.surface
  }
  val muted = MaterialTheme.colorScheme.onSurfaceVariant
  val project = projectTitle?.takeIf { it.isNotBlank() }

  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = surface),
    shape = RoundedCornerShape(12.dp),
  ) {
    if (item.variant == ThreadListV2Variant.Slim) {
      Row(
        Modifier
          .fillMaxWidth()
          .padding(horizontal = 12.dp, vertical = padV),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        if (project != null) {
          ProjectFaviconMark(title = project, dimmed = true, faviconUrl = faviconUrl)
        }
        Text(
          text = thread.title,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          color = muted,
          style = MaterialTheme.typography.bodyMedium,
        )
        Text(
          text = time,
          style = MaterialTheme.typography.labelSmall,
          color = if (item.snoozed) Color(0xFF60A5FA) else muted,
        )
      }
    } else {
      Column(Modifier.padding(horizontal = 14.dp, vertical = padV)) {
        // Project row — mirrors RN card: favicon + project title · status/time
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          if (project != null) {
            ProjectFaviconMark(title = project, dimmed = false, faviconUrl = faviconUrl)
            Text(
              text = project,
              modifier = Modifier.weight(1f),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              style = MaterialTheme.typography.labelMedium,
              color = muted,
              fontWeight = FontWeight.Medium,
            )
          } else {
            Spacer(Modifier.weight(1f))
          }
          if (item.pinned) {
            Icon(
              imageVector = Icons.Rounded.PushPin,
              contentDescription = "Pinned",
              modifier = Modifier.size(12.dp),
              tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          Text(
            text = statusLabel ?: time,
            style = MaterialTheme.typography.labelSmall,
            color = if (statusLabel != null) statusColor else muted,
          )
        }
        Spacer(Modifier.height(4.dp))
        Text(
          text = thread.title,
          fontWeight = FontWeight.SemiBold,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
          style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(4.dp))
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          val meta = buildString {
            if (thread.branch != null) append(thread.branch)
            if (statusLabel != null && time.isNotEmpty()) {
              if (isNotEmpty()) append("  ·  ")
              append(time)
            } else if (statusLabel == null && time.isNotEmpty()) {
              // time already in top row when ready; still show branch alone
            }
          }
          if (meta.isNotEmpty()) {
            Text(
              text = meta,
              modifier = Modifier.weight(1f),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              style = MaterialTheme.typography.labelSmall,
              color = muted,
            )
          } else {
            Spacer(Modifier.weight(1f))
          }
          if (providerDriver != null) {
            ProviderMark(driver = providerDriver)
          }
        }
      }
    }
  }
}

@Composable
private fun ProjectFaviconMark(
  title: String,
  dimmed: Boolean,
  faviconUrl: String?,
  size: Dp = 15.dp,
) {
  var loadFailed by remember(faviconUrl) { mutableStateOf(false) }

  if (!faviconUrl.isNullOrBlank() && !loadFailed) {
    val context = LocalContext.current
    val imageLoader = remember(context) {
      ImageLoader.Builder(context)
        .components {
          add(SvgDecoder.Factory())
        }
        .build()
    }
    AsyncImage(
      model = faviconUrl,
      contentDescription = title,
      imageLoader = imageLoader,
      onError = { loadFailed = true },
      modifier = Modifier
        .size(size)
        .alpha(if (dimmed) 0.4f else 1f)
        .clip(RoundedCornerShape(4.dp)),
    )
  } else {
    ProjectMark(title = title, dimmed = dimmed, size = size)
  }
}

@Composable
private fun ProjectMark(title: String, dimmed: Boolean, size: Dp = 15.dp) {
  val initial = title.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
  val color = projectColor(title)
  Box(
    modifier = Modifier
      .size(size)
      .alpha(if (dimmed) 0.4f else 1f)
      .clip(RoundedCornerShape(4.dp))
      .background(color),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = initial,
      color = Color.White,
      fontSize = (size.value * 0.6f).sp,
      fontWeight = FontWeight.Bold,
      lineHeight = (size.value * 0.6f).sp,
    )
  }
}

@Composable
private fun ProviderMark(driver: String) {
  Box(
    modifier = Modifier
      .size(16.dp)
      .alpha(0.85f),
    contentAlignment = Alignment.Center,
  ) {
    ProviderIcon(driver = driver, size = 14.dp)
  }
}

@Composable
fun ProviderIcon(
  driver: String,
  modifier: Modifier = Modifier,
  size: Dp = 14.dp,
  isDarkMode: Boolean = true,
) {
  val key = driver.lowercase()
  val density = LocalDensity.current
  val sizePx = remember(density, size) { with(density) { size.toPx() } }

  when {
    key.contains("claude") -> {
      val path = remember {
        PathParser().parsePathString(
          "m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
        ).toPath()
      }
      Canvas(modifier.size(size)) {
        withTransform({
          scale(sizePx / 256f, sizePx / 257f, pivot = Offset.Zero)
        }) {
          drawPath(path, color = Color(0xFFD97757))
        }
      }
    }
    key.contains("grok") -> {
      val p1 = remember {
        PathParser().parsePathString(
          "M9.26905 15.284L17.2479 9.36086C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349C15.0238 18.7976 12.3082 19.228 9.8261 18.2477L7.1146 19.5102C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525C21.0182 16.1985 21.7432 12.9897 21.0653 10.0961L21.0714 10.1023C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913C23.8812 0.595532 23.9406 0.513151 24 0.428711L20.6987 3.74866V3.73836L9.267 15.2861"
        ).toPath()
      }
      val p2 = remember {
        PathParser().parsePathString(
          "M7.62249 16.7237C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905C9.45541 5.72786 12.341 5.00497 14.86 6.06768L17.5653 4.81138C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839C12.4966 2.46764 8.6178 3.13492 5.98413 5.78141C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889C5.04412 18.0871 3.36889 19.8541 1.68137 21.6377C1.08337 22.2699 0.483318 22.9022 0 23.5716L7.62045 16.7257"
        ).toPath()
      }
      val fill = if (isDarkMode) Color(0xFFF5F5F5) else Color(0xFF0F0F0F)
      Canvas(modifier.size(size)) {
        withTransform({
          scale(sizePx / 24f, sizePx / 24f, pivot = Offset.Zero)
        }) {
          drawPath(p1, color = fill)
          drawPath(p2, color = fill)
        }
      }
    }
    key.contains("cursor") -> {
      val path = remember {
        PathParser().parsePathString(
          "M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
        ).toPath()
      }
      val fill = if (isDarkMode) Color(0xFFEDECEC) else Color(0xFF26251E)
      Canvas(modifier.size(size)) {
        withTransform({
          scale(sizePx / 466.73f, sizePx / 532.09f, pivot = Offset.Zero)
        }) {
          drawPath(path, color = fill)
        }
      }
    }
    key.contains("opencode") || key.contains("open code") -> {
      val p1 = remember { PathParser().parsePathString("M24 32H8V16H24V32Z").toPath() }
      val p2 = remember { PathParser().parsePathString("M24 8H8V32H24V8ZM32 40H0V0H32V40Z").toPath() }
      val fill1 = if (isDarkMode) Color(0xFF4B4646) else Color(0xFFCFCECD)
      val fill2 = if (isDarkMode) Color(0xFFF1ECEC) else Color(0xFF211E1E)
      Canvas(modifier.size(size)) {
        withTransform({
          scale(sizePx / 32f, sizePx / 40f, pivot = Offset.Zero)
        }) {
          drawPath(p1, color = fill1)
          drawPath(p2, color = fill2)
        }
      }
    }
    else -> {
      // codex / openai default
      val path = remember {
        PathParser().parsePathString(
          "M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"
        ).toPath()
      }
      val fill = if (isDarkMode) Color(0xFFE5E5E5) else Color(0xFF171717)
      Canvas(modifier.size(size)) {
        withTransform({
          scale(sizePx / 256f, sizePx / 260f, pivot = Offset.Zero)
        }) {
          drawPath(path, color = fill)
        }
      }
    }
  }
}

private fun projectColor(title: String): Color {
  val palette = listOf(
    Color(0xFF2563EB),
    Color(0xFF7C3AED),
    Color(0xFFDB2777),
    Color(0xFF059669),
    Color(0xFFD97706),
    Color(0xFF0891B2),
  )
  val idx = abs(title.hashCode()) % palette.size
  return palette[idx]
}

/**
 * Half swipe reveals primary (+ optional secondary). Past the arm threshold the
 * primary pill stretches across the reveal (RN ThreadSwipeActions feel) and a
 * full release commits primary.
 */
@Composable
private fun SwipeThreadRow(
  primaryLabel: String,
  primaryIcon: ImageVector,
  primaryColor: Color,
  onPrimary: () -> Unit,
  secondaryLabel: String?,
  secondaryIcon: ImageVector?,
  secondaryColor: Color,
  onSecondary: (() -> Unit)?,
  onClick: () -> Unit,
  onLongClick: () -> Unit,
  content: @Composable () -> Unit,
) {
  val scope = rememberCoroutineScope()
  val view = LocalView.current
  val density = LocalDensity.current
  val singleSlotPx = with(density) { 74.dp.toPx() }
  val hasSecondary = secondaryLabel != null && onSecondary != null
  val actionsWidthPx = singleSlotPx * if (hasSecondary) 2f else 1f

  var offsetX by remember { mutableFloatStateOf(0f) }
  val snap = remember { Animatable(0f) }
  var dragging by remember { mutableStateOf(false) }
  var dragVelocity by remember { mutableFloatStateOf(0f) }
  var armed by remember { mutableStateOf(false) }

  val displayOffset = if (dragging) offsetX else snap.value

  BoxWithConstraints(Modifier.fillMaxWidth()) {
    val rowWidth = constraints.maxWidth.toFloat().coerceAtLeast(1f)
    val fullThreshold = max(actionsWidthPx + with(density) { 24.dp.toPx() }, rowWidth * 0.38f)

    val reveal = -displayOffset
    val fullProgress = if (fullThreshold > actionsWidthPx) {
      ((reveal - actionsWidthPx) / (fullThreshold - actionsWidthPx)).coerceIn(0f, 1f)
    } else if (reveal > 0f) {
      (reveal / fullThreshold).coerceIn(0f, 1f)
    } else {
      0f
    }
    val nowArmed = reveal >= fullThreshold

    LaunchedEffect(nowArmed) {
      if (nowArmed && !armed) {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      }
      armed = nowArmed
    }

    LaunchedEffect(Unit) {
      snap.snapTo(0f)
    }

    Box(
      Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(12.dp)),
    ) {
      // Full-height background action layer (Gmail style)
      Box(
        Modifier
          .matchParentSize()
          .clip(RoundedCornerShape(12.dp))
          .background(if (nowArmed) primaryColor else ScreenBg),
      ) {
        Row(
          Modifier.fillMaxSize(),
          horizontalArrangement = Arrangement.End,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          if (secondaryLabel != null && onSecondary != null && secondaryIcon != null) {
            val secondaryAlpha = (1f - fullProgress).coerceIn(0f, 1f)
            val secWidth = with(density) { (74.dp.toPx() * secondaryAlpha).toDp() }
            if (secondaryAlpha > 0.02f) {
              GmailSwipeActionCell(
                label = secondaryLabel,
                icon = secondaryIcon,
                color = secondaryColor,
                widthDp = secWidth,
                contentAlpha = secondaryAlpha,
                iconScale = 1f,
                onClick = {
                  scope.launch {
                    dragging = false
                    snap.snapTo(offsetX)
                    snap.animateTo(0f, SwipeSpring)
                    offsetX = 0f
                  }
                  onSecondary()
                },
              )
            }
          }

          val primaryCellWidth = if (nowArmed || reveal > actionsWidthPx) {
            with(density) { reveal.coerceAtLeast(0f).toDp() } - (if (hasSecondary) with(density) { (74.dp.toPx() * (1f - fullProgress)).toDp() } else 0.dp)
          } else {
            74.dp
          }

          GmailSwipeActionCell(
            label = primaryLabel,
            icon = primaryIcon,
            color = primaryColor,
            widthDp = primaryCellWidth.coerceAtLeast(74.dp),
            contentAlpha = 1f,
            iconScale = 1f + (fullProgress * 0.28f),
            onClick = {
              scope.launch {
                dragging = false
                snap.snapTo(offsetX)
                snap.animateTo(0f, SwipeSpring)
                offsetX = 0f
              }
              onPrimary()
            },
          )
        }
      }

      // Foreground Card layer
      Box(
        Modifier
          .offset { IntOffset(displayOffset.roundToInt(), 0) }
          .fillMaxWidth()
          .pointerInput(actionsWidthPx, fullThreshold, rowWidth) {
            detectHorizontalDragGestures(
              onDragStart = {
                dragging = true
                dragVelocity = 0f
                scope.launch { snap.stop() }
                offsetX = snap.value
              },
              onDragEnd = {
                val revealEnd = -offsetX
                val flingOpen = dragVelocity < -900f
                val flingClose = dragVelocity > 700f
                dragging = false
                scope.launch {
                  snap.snapTo(offsetX)
                  when {
                    flingClose -> {
                      snap.animateTo(0f, SwipeSpring)
                      offsetX = 0f
                    }
                    revealEnd >= fullThreshold || (flingOpen && revealEnd > actionsWidthPx * 0.35f) -> {
                      val peak = -rowWidth
                      view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                      snap.animateTo(peak, spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMedium))
                      onPrimary()
                      snap.animateTo(0f, SwipeSpring)
                      offsetX = 0f
                    }
                    revealEnd >= actionsWidthPx * 0.35f -> {
                      snap.animateTo(-actionsWidthPx, SwipeSpring)
                      offsetX = -actionsWidthPx
                    }
                    else -> {
                      snap.animateTo(0f, SwipeSpring)
                      offsetX = 0f
                    }
                  }
                }
              },
              onDragCancel = {
                dragging = false
                scope.launch {
                  snap.snapTo(offsetX)
                  snap.animateTo(0f, SwipeSpring)
                  offsetX = 0f
                }
              },
              onHorizontalDrag = { change, dragAmount ->
                change.consume()
                val dt = change.previousUptimeMillis.let { prev ->
                  (change.uptimeMillis - prev).coerceAtLeast(1L).toFloat()
                }
                dragVelocity = dragAmount / dt * 1000f
                val raw = offsetX + dragAmount
                offsetX = if (raw > 0f) raw * 0.15f else raw.coerceIn(-rowWidth, 0f)
              },
            )
          }
          .combinedClickable(
            onClick = {
              if (abs(displayOffset) > 8f) {
                scope.launch {
                  dragging = false
                  snap.snapTo(offsetX)
                  snap.animateTo(0f, SwipeSpring)
                  offsetX = 0f
                }
              } else {
                onClick()
              }
            },
            onLongClick = onLongClick,
          ),
      ) {
        content()
      }
    }
  }
}

@Composable
private fun GmailSwipeActionCell(
  label: String,
  icon: ImageVector,
  color: Color,
  widthDp: Dp,
  contentAlpha: Float,
  iconScale: Float,
  onClick: () -> Unit,
) {
  Box(
    modifier = Modifier
      .width(widthDp)
      .fillMaxHeight()
      .background(color)
      .alpha(contentAlpha.coerceIn(0f, 1f))
      .combinedClickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.Center,
      modifier = Modifier.padding(horizontal = 4.dp),
    ) {
      Icon(
        imageVector = icon,
        contentDescription = label,
        tint = Color.White,
        modifier = Modifier
          .size(22.dp)
          .graphicsLayer {
            scaleX = iconScale
            scaleY = iconScale
          },
      )
      Spacer(Modifier.height(3.dp))
      Text(
        text = label,
        color = Color.White,
        style = MaterialTheme.typography.labelMedium,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
      )
    }
  }
}

private fun runPrimary(
  primary: ThreadListV2SwipePrimary,
  onAction: (String, String?) -> Unit,
) {
  when (primary) {
    ThreadListV2SwipePrimary.Settle -> onAction("thread.settle", null)
    ThreadListV2SwipePrimary.Unsettle -> onAction("thread.unsettle", null)
    ThreadListV2SwipePrimary.Unsnooze -> onAction("thread.unsnooze", null)
  }
}

/** Map thread model selection → provider driver key for the icon. */
fun resolveProviderDriver(
  instanceId: String,
  providerModels: List<com.t3tools.android.protocol.ProviderModel>,
): String {
  val match = providerModels.firstOrNull { it.instanceId == instanceId }
  val label = match?.providerLabel ?: instanceId
  val hay = "$instanceId $label".lowercase()
  return when {
    "claude" in hay -> "claudeAgent"
    "cursor" in hay -> "cursor"
    "grok" in hay -> "grok"
    "opencode" in hay || "open code" in hay -> "opencode"
    "codex" in hay || "openai" in hay -> "codex"
    else -> instanceId
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThreadContextMenuBottomSheet(
  item: ThreadListV2Item,
  capabilities: ThreadCapabilities,
  projectTitle: String?,
  onDismiss: () -> Unit,
  onAction: (command: String, value: String?) -> Unit,
  newPinOrderKey: String?,
  canMovePinnedUp: Boolean,
  canMovePinnedDown: Boolean,
  onMovePinned: (direction: Int) -> Unit,
  onSnoozePicker: () -> Unit,
  onConfirmDelete: () -> Unit,
) {
  val thread = item.thread
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
        .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(bottom = 12.dp, start = 8.dp, end = 8.dp),
      ) {
        if (!projectTitle.isNullOrBlank()) {
          Text(
            text = projectTitle,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          Spacer(Modifier.height(2.dp))
        }
        Text(
          text = thread.title,
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.Bold,
          color = Color.White,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }

      HorizontalDivider(color = Color(0xFF27272A), thickness = 1.dp)
      Spacer(Modifier.height(8.dp))

      // 1. Settle / Unsettle / Wake
      if (item.snoozed && capabilities.snooze) {
        ContextMenuItemRow(
          icon = Icons.Rounded.WbSunny,
          iconColor = UnsnoozeColor,
          label = "Wake thread",
          onClick = {
            onDismiss()
            onAction("thread.unsnooze", null)
          },
        )
      } else if (capabilities.settlement) {
        if (item.variant == ThreadListV2Variant.Slim && !item.snoozed) {
          ContextMenuItemRow(
            icon = Icons.AutoMirrored.Rounded.Undo,
            iconColor = SettleColor,
            label = "Unsettle thread",
            onClick = {
              onDismiss()
              onAction("thread.unsettle", null)
            },
          )
        } else if (!item.snoozed) {
          ContextMenuItemRow(
            icon = Icons.Rounded.Check,
            iconColor = SettleColor,
            label = "Settle thread",
            onClick = {
              onDismiss()
              onAction("thread.settle", null)
            },
          )
        }
      }

      // 2. Pin / Unpin
      if (capabilities.pinning && !item.snoozed) {
        val isPinned = thread.pinnedAt != null
        ContextMenuItemRow(
          icon = Icons.Rounded.PushPin,
          iconColor = if (isPinned) MaterialTheme.colorScheme.primary else Color.White,
          label = if (isPinned) "Unpin thread" else "Pin thread",
          onClick = {
            onDismiss()
            if (isPinned) {
              onAction("thread.unpin", null)
            } else {
              onAction(
                "thread.pin",
                if (capabilities.pinReorder) newPinOrderKey else null,
              )
            }
          },
        )
        if (isPinned && capabilities.pinReorder) {
          if (canMovePinnedUp) {
            ContextMenuItemRow(
              icon = Icons.Rounded.KeyboardArrowUp,
              label = "Move up",
              onClick = {
                onDismiss()
                onMovePinned(-1)
              },
            )
          }
          if (canMovePinnedDown) {
            ContextMenuItemRow(
              icon = Icons.Rounded.KeyboardArrowDown,
              label = "Move down",
              onClick = {
                onDismiss()
                onMovePinned(1)
              },
            )
          }
        }
      }

      // 3. Snooze
      if (capabilities.snooze && !item.snoozed && canSnoozeThread(thread)) {
        ContextMenuItemRow(
          icon = Icons.Rounded.Schedule,
          iconColor = SnoozeColor,
          label = "Snooze thread…",
          onClick = {
            onDismiss()
            onSnoozePicker()
          },
        )
      }

      HorizontalDivider(color = Color(0xFF27272A), thickness = 1.dp, modifier = Modifier.padding(vertical = 4.dp))

      // 4. Delete
      ContextMenuItemRow(
        icon = Icons.Rounded.Delete,
        iconColor = Color(0xFFF87171),
        label = "Delete thread",
        labelColor = Color(0xFFF87171),
        onClick = {
          onDismiss()
          onConfirmDelete()
        },
      )

      Spacer(Modifier.height(16.dp))
    }
  }
}

@Composable
private fun ContextMenuItemRow(
  icon: ImageVector,
  label: String,
  onClick: () -> Unit,
  iconColor: Color = Color.White,
  labelColor: Color = Color.White,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(10.dp))
      .clickable(onClick = onClick)
      .padding(horizontal = 12.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Icon(
      imageVector = icon,
      contentDescription = label,
      modifier = Modifier.size(20.dp),
      tint = iconColor,
    )
    Text(
      text = label,
      style = MaterialTheme.typography.bodyLarge,
      fontWeight = FontWeight.Medium,
      color = labelColor,
    )
  }
}
