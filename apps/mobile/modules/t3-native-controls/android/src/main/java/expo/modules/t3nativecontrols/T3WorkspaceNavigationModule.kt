package expo.modules.t3nativecontrols

import android.content.Context
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scrim
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.unit.sp
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3WorkspaceNavigationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3WorkspaceNavigation")
    View(T3WorkspaceNavigationView::class) {
      Prop("tabs") { view: T3WorkspaceNavigationView, value: List<String> -> view.tabs = value }
      Prop("selectedTab") { view: T3WorkspaceNavigationView, value: String ->
        view.selectedTab = value
      }
      Prop("floating") { view: T3WorkspaceNavigationView, value: Boolean ->
        view.floating = value
        view.clipToPadding = !value
        view.clipChildren = !value
      }
      Prop("rail") { view: T3WorkspaceNavigationView, value: Boolean -> view.rail = value }
      Prop("dark") { view: T3WorkspaceNavigationView, value: Boolean -> view.dark = value }
      Prop("textScale") { view: T3WorkspaceNavigationView, value: Float -> view.textScale = value }
      Prop("newEnabled") { view: T3WorkspaceNavigationView, value: Boolean ->
        view.newEnabled = value
      }
      Prop("safeAreaTop") { view: T3WorkspaceNavigationView, value: Float ->
        view.safeAreaTop = value
      }
      Prop("safeAreaBottom") { view: T3WorkspaceNavigationView, value: Float ->
        view.safeAreaBottom = value
      }
      Prop("headerHeight") { view: T3WorkspaceNavigationView, value: Float ->
        view.headerHeight = value
      }
      Prop("containerColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.containerColor = value
      }
      Prop("selectedColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.selectedColor = value
      }
      Prop("indicatorColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.indicatorColor = value
      }
      Prop("unselectedColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.unselectedColor = value
      }
      Prop("actionColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.actionColor = value
      }
      Prop("actionContentColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.actionContentColor = value
      }
      Prop("environmentLabel") { view: T3WorkspaceNavigationView, value: String ->
        view.environmentLabel = value
      }
      Prop("environmentOnline") { view: T3WorkspaceNavigationView, value: Boolean ->
        view.environmentOnline = value
      }
      Prop("quickThreadKeys") { view: T3WorkspaceNavigationView, value: List<String> ->
        view.quickThreadKeys = value
      }
      Prop("quickThreadTitles") { view: T3WorkspaceNavigationView, value: List<String> ->
        view.quickThreadTitles = value
      }
      Prop("quickThreadWorking") { view: T3WorkspaceNavigationView, value: List<Boolean> ->
        view.quickThreadWorking = value
      }
      Prop("showQuickThreads") { view: T3WorkspaceNavigationView, value: Boolean ->
        view.showQuickThreads = value
      }
      Prop("selectedThreadKey") { view: T3WorkspaceNavigationView, value: String ->
        view.selectedThreadKey = value
      }
      Events(
        "onTabSelected",
        "onNewThread",
        "onEnvironmentSelected",
        "onThreadSelected",
        "onOverlayChange",
      )
    }
  }
}

/** One Material3 selection surface moves from below the list to its leading edge. */
class T3WorkspaceNavigationView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  // Compose must remeasure native children when Yoga resizes the folded window.
  override val shouldUseAndroidLayout = true

  private val onTabSelected by EventDispatcher()
  private val onNewThread by EventDispatcher()
  private val onEnvironmentSelected by EventDispatcher()
  private val onThreadSelected by EventDispatcher()
  private val onOverlayChange by EventDispatcher()
  var tabs by mutableStateOf(listOf("threads", "pullRequests", "issues", "usage", "settings"))
  var selectedTab by mutableStateOf("threads")
  var rail by mutableStateOf(false)
  var floating by mutableStateOf(false)
  var dark by mutableStateOf(false)
  var textScale by mutableStateOf(1f)
  var newEnabled by mutableStateOf(false)
  var safeAreaTop by mutableStateOf(0f)
  var safeAreaBottom by mutableStateOf(0f)
  var headerHeight by mutableStateOf(56f)
  var containerColor by mutableStateOf(0)
  var selectedColor by mutableStateOf(0)
  var indicatorColor by mutableStateOf(0)
  var unselectedColor by mutableStateOf(0)
  var actionColor by mutableStateOf(0)
  var actionContentColor by mutableStateOf(0)
  var environmentLabel by mutableStateOf("Environment")
  var environmentOnline by mutableStateOf(false)
  var quickThreadKeys by mutableStateOf(emptyList<String>())
  var quickThreadTitles by mutableStateOf(emptyList<String>())
  var quickThreadWorking by mutableStateOf(emptyList<Boolean>())
  var showQuickThreads by mutableStateOf(true)
  var selectedThreadKey by mutableStateOf("")

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Fabric measures the replacement bar before attaching it on a fold.
    // Compose needs an attached window to obtain its lifecycle recomposer.
    if (!isAttachedToWindow) {
      setMeasuredDimension(
        MeasureSpec.getSize(widthMeasureSpec),
        MeasureSpec.getSize(heightMeasureSpec)
      )
      return
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (isAttachedToWindow) super.onLayout(changed, left, top, right, bottom)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    requestLayout()
  }

  init {
    addView(
      ComposeView(context).apply {
        clipChildren = false
        setViewCompositionStrategy(
          ViewCompositionStrategy.DisposeOnDetachedFromWindowOrReleasedFromPool
        )
        setContent {
          MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
            if (rail) {
              rail()
            } else if (floating) {
              floatingTabs()
            } else {
              NavigationBar(
                modifier = Modifier.fillMaxSize(),
                containerColor = Color(containerColor),
                tonalElevation = androidx.compose.ui.unit.Dp(0f),
                windowInsets = WindowInsets(0),
              ) {
                tabs.forEach { tab ->
                  NavigationBarItem(
                    selected = selectedTab == tab,
                    onClick = { onTabSelected(mapOf("tab" to tab)) },
                    icon = { Icon(tabIconPainter(tab), contentDescription = null) },
                    label = { Text(tabTitle(tab), fontSize = (12 * textScale).sp) },
                    colors = NavigationBarItemDefaults.colors(
                      selectedIconColor = Color(selectedColor),
                      selectedTextColor = Color(selectedColor),
                      indicatorColor = Color(indicatorColor),
                      unselectedIconColor = Color(unselectedColor),
                      unselectedTextColor = Color(unselectedColor),
                    ),
                  )
                }
              }
            }
          }
        }
      },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
  }

  @Composable
  private fun floatingTabs() {
    Surface(
      modifier = Modifier.fillMaxSize().padding(8.dp),
      shape = CircleShape,
      color = Color(containerColor),
      shadowElevation = 6.dp,
    ) {
      Row(
        modifier = Modifier.fillMaxSize().selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        tabs.forEach { tab ->
          val selected = selectedTab == tab
          val tint = Color(if (selected) selectedColor else unselectedColor)
          Box(
            modifier = Modifier
              .weight(1f)
              .fillMaxHeight()
              .clip(CircleShape)
              .selectable(
                selected = selected,
                role = Role.Tab,
                onClick = { onTabSelected(mapOf("tab" to tab)) },
              )
              .semantics { contentDescription = expandedTabTitle(tab) }
              .padding(4.dp)
              .background(if (selected) Color(indicatorColor) else Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
          ) {
            Icon(
              tabIconPainter(tab),
              contentDescription = null,
              modifier = Modifier.size((24 * textScale).dp),
              tint = tint,
            )
          }
        }
      }
    }
  }

  @Composable
  private fun rail() {
    var expanded by remember { mutableStateOf(false) }
    var roomy by remember { mutableStateOf(false) }
    val progress by animateFloatAsState(
      targetValue = if (expanded && roomy) 1f else 0f,
      animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
    )
    val overlay = expanded || progress != 0f
    LaunchedEffect(overlay) { onOverlayChange(mapOf("overlay" to overlay)) }
    val backDispatcher = (appContext.currentActivity as? ComponentActivity)?.onBackPressedDispatcher
    DisposableEffect(backDispatcher, expanded) {
      val callback = object : OnBackPressedCallback(expanded) {
        override fun handleOnBackPressed() {
          expanded = false
        }
      }
      backDispatcher?.addCallback(callback)
      onDispose { callback.remove() }
    }
    val density = LocalDensity.current
    Box(
      Modifier.fillMaxSize().onSizeChanged {
        roomy = with(density) { it.width.toDp() } >= EXPANDED_RAIL_WIDTH
      },
    ) {
      val fraction = progress.coerceIn(0f, 1f)
      val railShape = RoundedCornerShape(topEnd = 16.dp * fraction, bottomEnd = 16.dp * fraction)
      if (fraction > 0f) {
        Scrim(
          contentDescription = "Close navigation rail",
          onClick = { expanded = false },
          alpha = { fraction },
        )
      }
      Column(
        Modifier
          .fillMaxHeight()
          .width(lerp(RAIL_WIDTH, EXPANDED_RAIL_WIDTH, fraction))
          .shadow(RAIL_SHADOW * fraction, railShape, clip = false)
          .background(Color(containerColor), railShape)
          .padding(top = safeAreaTop.dp, bottom = safeAreaBottom.dp + 12.dp)
          .selectableGroup(),
      ) {
        Box(
          Modifier.height(headerHeight.dp).padding(start = RAIL_INSET),
          contentAlignment = Alignment.CenterStart,
        ) {
          IconButton(
            onClick = { expanded = !expanded },
            modifier = Modifier.semantics {
              contentDescription =
                if (expanded) "Collapse navigation rail" else "Expand navigation rail"
            },
          ) {
            Icon(
              painterResource(R.drawable.t3_menu),
              contentDescription = null,
              tint = Color(unselectedColor),
            )
          }
        }
        sectionSpacer(fraction)
        environmentItem(fraction) {
          expanded = false
          onEnvironmentSelected(emptyMap<String, Any>())
        }
        sectionSpacer(fraction)
        if (showQuickThreads) {
          quickThreadKeys.take(MAX_QUICK_THREADS).forEachIndexed { index, key ->
            quickThreadItem(
              key = key,
              title = quickThreadTitles.getOrNull(index) ?: "Thread",
              working = quickThreadWorking.getOrNull(index) == true,
              fraction = fraction,
            ) {
              expanded = false
              onThreadSelected(mapOf("key" to key))
            }
          }
        }
        railItem("threads", fraction, icon = R.drawable.t3_threads_rail) {
          expanded = false
          onTabSelected(mapOf("tab" to "threads"))
        }
        if (selectedTab == "threads") {
          newThreadButton(fraction) {
            expanded = false
            onNewThread(emptyMap<String, Any>())
          }
        } else {
          Spacer(Modifier.padding(top = 12.dp).height(FAB_SIZE))
        }
        Spacer(Modifier.weight(1f))
        tabs.filterNot { it == "threads" }.forEach { tab ->
          railItem(tab, fraction) {
            expanded = false
            onTabSelected(mapOf("tab" to tab))
          }
        }
        Spacer(Modifier.weight(1f))
      }
    }
  }

  @Composable
  private fun sectionSpacer(fraction: Float) {
    Box(
      Modifier
        .padding(start = RAIL_INSET, end = RAIL_INSET, top = 4.dp, bottom = 8.dp)
        .height(1.dp)
        .width(lerp(ITEM_HEIGHT, EXPANDED_RAIL_WIDTH - RAIL_INSET * 2, fraction))
        .background(Color(unselectedColor).copy(alpha = 0.18f)),
    )
  }

  @Composable
  private fun environmentItem(fraction: Float, onClick: () -> Unit) {
    val initials = initials(environmentLabel).ifBlank { "ENV" }
    railEntry(
      selected = false,
      title = "Environment: $environmentLabel",
      fraction = fraction,
      onClick = onClick,
      icon = {
        Box(contentAlignment = Alignment.Center) {
          Surface(
            shape = MaterialTheme.shapes.small,
            color = STATUS_GREEN.copy(alpha = 0.12f),
            modifier = Modifier.size(28.dp),
          ) {
            Box(contentAlignment = Alignment.Center) {
              Text(initials, color = STATUS_GREEN, fontSize = 9.sp)
            }
          }
          Box(
            Modifier
              .align(Alignment.BottomEnd)
              .size(8.dp)
              .background(
                if (environmentOnline) STATUS_GREEN else Color(unselectedColor).copy(alpha = 0.55f),
                CircleShape,
              ),
          )
        }
      },
    )
  }

  @Composable
  private fun quickThreadItem(
    key: String,
    title: String,
    working: Boolean,
    fraction: Float,
    onClick: () -> Unit,
  ) {
    railEntry(
      selected = key == selectedThreadKey,
      title = if (working) "Working: $title" else title,
      fraction = fraction,
      onClick = onClick,
      icon = {
        Box(contentAlignment = Alignment.Center) {
          if (working) {
            Icon(
              painterResource(R.drawable.t3_chats),
              contentDescription = null,
              tint = STATUS_GREEN,
            )
            Box(
              Modifier
                .align(Alignment.TopEnd)
                .size(6.dp)
                .background(STATUS_GREEN, CircleShape),
            )
          } else {
            Surface(
              shape = CircleShape,
              color = Color(unselectedColor).copy(alpha = 0.10f),
              modifier = Modifier.size(28.dp),
            ) {
              Box(contentAlignment = Alignment.Center) {
                Text(initials(title).ifBlank { "·" }, color = Color(unselectedColor), fontSize = 9.sp)
              }
            }
          }
        }
      },
    )
  }

  @Composable
  private fun newThreadButton(fraction: Float, onClick: () -> Unit) {
    Surface(
      onClick = onClick,
      enabled = newEnabled,
      shape = MaterialTheme.shapes.large,
      color = Color(actionColor),
      contentColor = Color(actionContentColor),
      shadowElevation = 3.dp,
      modifier = Modifier
        .padding(start = RAIL_INSET, top = 12.dp)
        .height(FAB_SIZE)
        .width(lerp(FAB_SIZE, EXPANDED_RAIL_WIDTH - RAIL_INSET * 2, fraction))
        .alpha(if (newEnabled) 1f else DISABLED_ALPHA)
        .semantics { contentDescription = "New thread" },
    ) {
      Row(
        Modifier.padding(start = (FAB_SIZE - ICON_SIZE) / 2).clipToBounds(),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(painterResource(R.drawable.t3_new_thread), contentDescription = null)
        Text(
          "New thread",
          Modifier.padding(start = 12.dp).alpha(labelAlpha(fraction)).clearAndSetSemantics {},
          style = MaterialTheme.typography.labelLarge,
          fontSize = (14 * textScale).sp,
          maxLines = 1,
          softWrap = false,
        )
      }
    }
  }

  @Composable
  private fun railItem(
    tab: String,
    fraction: Float,
    icon: Int? = null,
    onClick: () -> Unit,
  ) {
    val selected = selectedTab == tab
    val title = expandedTabTitle(tab)
    val tint = Color(if (selected) selectedColor else unselectedColor)
    railEntry(
      selected = selected,
      title = title,
      fraction = fraction,
      onClick = onClick,
      icon = {
        Icon(
          icon?.let { painterResource(it) } ?: tabIconPainter(tab),
          contentDescription = null,
          tint = tint,
        )
      },
    )
  }

  @Composable
  private fun railEntry(
    selected: Boolean,
    title: String,
    fraction: Float,
    onClick: () -> Unit,
    icon: @Composable () -> Unit,
  ) {
    val tint = Color(if (selected) selectedColor else unselectedColor)
    Box(
      Modifier
        .padding(start = RAIL_INSET, bottom = 4.dp)
        .height(ITEM_HEIGHT)
        .width(lerp(ITEM_HEIGHT, EXPANDED_RAIL_WIDTH - RAIL_INSET * 2, fraction))
        .clip(CircleShape)
        .background(if (selected) Color(indicatorColor) else Color.Transparent)
        .selectable(selected = selected, role = Role.Tab, onClick = onClick)
        .semantics { contentDescription = title },
    ) {
      Row(
        Modifier.fillMaxHeight().padding(start = (ITEM_HEIGHT - ICON_SIZE) / 2).clipToBounds(),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box(Modifier.size(ICON_SIZE), contentAlignment = Alignment.Center) { icon() }
        Text(
          title,
          Modifier.padding(start = 12.dp).alpha(labelAlpha(fraction)).clearAndSetSemantics {},
          color = tint,
          style = MaterialTheme.typography.labelLarge,
          fontSize = (14 * textScale).sp,
          maxLines = 1,
          softWrap = false,
        )
      }
    }
  }

  private fun labelAlpha(fraction: Float) = ((fraction - 0.35f) / 0.65f).coerceIn(0f, 1f)

  private fun initials(label: String): String = label
    .trim()
    .split(Regex("\\s+"))
    .filter(String::isNotBlank)
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercase() }
    .joinToString("")

  private fun tabTitle(tab: String) = when (tab) {
    "threads" -> "Chats"
    "pullRequests" -> "Pulls"
    "issues" -> "Issues"
    "usage" -> "Usage"
    else -> "Settings"
  }

  private fun expandedTabTitle(tab: String) =
    if (tab == "pullRequests") "Pull Requests" else tabTitle(tab)

  @Composable
  private fun tabIconPainter(tab: String) = painterResource(
    when (tab) {
      "threads" -> R.drawable.t3_chats
      "pullRequests" -> R.drawable.t3_pull_requests
      "issues" -> R.drawable.t3_issues
      "usage" -> R.drawable.t3_usage
      else -> R.drawable.t3_settings
    }
  )

  private companion object {
    // Material's 80dp compact rail, minus 8dp: still a 48dp touch target with 12dp margins.
    val RAIL_WIDTH = 72.dp
    val EXPANDED_RAIL_WIDTH = 240.dp
    val RAIL_INSET = 12.dp
    val ITEM_HEIGHT = 48.dp
    val ICON_SIZE = 24.dp
    val FAB_SIZE = 48.dp
    val RAIL_SHADOW = 8.dp
    val STATUS_GREEN = Color(0xFF22C55E)
    const val MAX_QUICK_THREADS = 3
    const val DISABLED_ALPHA = 0.4f
  }
}
