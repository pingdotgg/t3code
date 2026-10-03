package expo.modules.t3nativecontrols

import android.content.Context
import android.os.Build
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

// Android's tablet breakpoint. Large screens get the iPad-only commands.
private const val LARGE_SCREEN_MIN_WIDTH_DP = 600

class T3KeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3KeyboardCommands")

    View(T3KeyboardCommandsView::class) {
      Prop("enabledCommands") { view: T3KeyboardCommandsView, commands: List<String> ->
        view.enabledCommands = commands.toSet()
      }
      Events("onCommand")
    }
  }
}

class T3KeyboardCommandsView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  var enabledCommands = emptySet<String>()

  init {
    // A key reaches dispatchKeyEvent only while focus is inside this view. With nothing focused,
    // Android offers it to unhandled-key listeners instead. That listener needs API 28, so on
    // API 24-27 shortcuts work only while something inside this view has focus.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      addOnUnhandledKeyEventListener { _, event ->
        val command = enabledCommandFor(event)
        if (command != null) onCommand(mapOf("command" to command))
        command != null
      }
    }
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val command = enabledCommandFor(event) ?: return super.dispatchKeyEvent(event)
    // Unmodified keys (palette arrows and Escape) win over the focused search field. Ctrl chords
    // go to the focused view first, so the terminal keeps the control keys it sends to the shell.
    val focusedViewHandled = !event.hasNoModifiers() && super.dispatchKeyEvent(event)
    if (!focusedViewHandled) onCommand(mapOf("command" to command))
    return true
  }

  private fun enabledCommandFor(event: KeyEvent): String? {
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return null
    val largeScreen = resources.configuration.smallestScreenWidthDp >= LARGE_SCREEN_MIN_WIDTH_DP
    return hardwareKeyboardCommand(event, largeScreen)?.takeIf(enabledCommands::contains)
  }
}

private val UNMODIFIED_COMMANDS = mapOf(
  KeyEvent.KEYCODE_DPAD_DOWN to "paletteNext",
  KeyEvent.KEYCODE_DPAD_UP to "palettePrevious",
  KeyEvent.KEYCODE_ESCAPE to "paletteDismiss",
)

private val CTRL_COMMANDS = mapOf(
  KeyEvent.KEYCODE_N to "newTask",
  KeyEvent.KEYCODE_F to "focusSearch",
  KeyEvent.KEYCODE_LEFT_BRACKET to "back",
  KeyEvent.KEYCODE_BACKSLASH to "toggleSidebar",
)

private val CTRL_SHIFT_COMMANDS = mapOf(
  KeyEvent.KEYCODE_F to "files",
  KeyEvent.KEYCODE_T to "terminal",
  KeyEvent.KEYCODE_R to "review",
  KeyEvent.KEYCODE_C to "copyThreadReference",
)

/**
 * The command for a hardware-keyboard chord. Matches the iOS module with Ctrl in place of
 * Command. Like iPad, large screens get the command palette and thread jumps; on phones Ctrl-K
 * focuses search.
 */
private fun hardwareKeyboardCommand(event: KeyEvent, largeScreen: Boolean): String? {
  val keyCode = event.keyCode
  return when {
    event.hasNoModifiers() -> UNMODIFIED_COMMANDS[keyCode]
    event.hasModifiers(KeyEvent.META_CTRL_ON) -> when {
      keyCode == KeyEvent.KEYCODE_K -> if (largeScreen) "commandPalette" else "focusSearch"
      largeScreen && keyCode in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 ->
        "thread.jump.${keyCode - KeyEvent.KEYCODE_0}"
      else -> CTRL_COMMANDS[keyCode]
    }
    event.hasModifiers(KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON) ->
      CTRL_SHIFT_COMMANDS[keyCode]
    else -> null
  }
}
