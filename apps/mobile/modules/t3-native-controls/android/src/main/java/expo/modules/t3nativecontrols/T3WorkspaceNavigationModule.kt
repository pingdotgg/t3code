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
      Events("onTabSelected", "onNewThread", "onOverlayChange")
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
  private val onOverlayChange by EventDispatcher()
  var tabs by mutableStateOf(listOf("threads", "pullRequests", "usage", "settings"))
  var selectedTab by mutableStateOf("threads")
  var rail by mutableStateOf(false)
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
        setViewCompositionStrategy(
          ViewCompositionStrategy.DisposeOnDetachedFromWindowOrReleasedFromPool
        )
        setContent {
          MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
            if (rail) {
              rail()
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
  private fun rail() {
    // One rail surface widens in place over the list. Material's ModalWideNavigationRail
    // instead moves its destinations into a dialog window copy, which blanks them for a few
    // frames while the window attaches and lays them out at a different height.
    var expanded by remember { mutableStateOf(false) }
    // React Native sizes this view to the rail. While the rail is open it spans the workspace,
    // and it only widens once the host has made room, so the surface is never clipped.
    var roomy by remember { mutableStateOf(false) }
    val progress by animateFloatAsState(
      targetValue = if (expanded && roomy) 1f else 0f,
      animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
    )
    val overlay = expanded || progress != 0f
    LaunchedEffect(overlay) { onOverlayChange(mapOf("overlay" to overlay)) }
    // The activity handles Back before React Native, so an open rail closes first.
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
          .width(lerp(RAIL_WIDTH, EXPANDED_RAIL_WIDTH, progress.coerceAtLeast(0f)))
          .shadow(RAIL_SHADOW * fraction, RAIL_EXPANDED_SHAPE, clip = false)
          .background(Color(containerColor), RAIL_EXPANDED_SHAPE)
          .padding(top = safeAreaTop.dp, bottom = safeAreaBottom.dp + 12.dp)
          .selectableGroup(),
      ) {
        // As tall as the list toolbar so the menu lines up with the toolbar's actions.
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
        if (selectedTab == "threads") {
          newThreadButton(fraction) {
            expanded = false
            onNewThread(emptyMap<String, Any>())
          }
        }
        Spacer(Modifier.weight(1f))
        tabs.forEach { tab ->
          railItem(tab, fraction) {
            expanded = false
            onTabSelected(mapOf("tab" to tab))
          }
        }
        Spacer(Modifier.weight(1f))
      }
    }
  }

  /** The collapsed FAB widens with the rail and reveals its label as it goes. */
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

  /**
   * A destination whose indicator stretches from a circle around the icon into a pill around
   * the icon and label. The icon never moves, so the collapsed and expanded rails share it.
   */
  @Composable
  private fun railItem(tab: String, fraction: Float, onClick: () -> Unit) {
    val selected = selectedTab == tab
    val title = expandedTabTitle(tab)
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
        Icon(tabIconPainter(tab), contentDescription = null, tint = tint)
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

  private fun tabTitle(tab: String) = when (tab) {
    "threads" -> "Chats"
    "pullRequests" -> "Pulls"
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
    val FAB_SIZE = 48.dp
    val ICON_SIZE = 24.dp
    val RAIL_SHADOW = 6.dp
    val RAIL_EXPANDED_SHAPE = RoundedCornerShape(topEnd = 16.dp, bottomEnd = 16.dp)
    const val DISABLED_ALPHA = 0.4f

    // Labels fade in over the second half of the widening, once there is room for them, and
    // fade out over the first half of the narrowing, before the surface clips them.
    fun labelAlpha(fraction: Float) = ((fraction - 0.5f) / 0.5f).coerceIn(0f, 1f)
  }
}
