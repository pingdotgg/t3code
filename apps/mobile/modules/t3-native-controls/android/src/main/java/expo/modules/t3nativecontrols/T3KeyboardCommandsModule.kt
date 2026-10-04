package expo.modules.t3nativecontrols

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

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

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val command = commandFor(event)?.takeIf { enabledCommands.contains(it) }
    if (command != null) onCommand(mapOf("command" to command))
    return command != null || super.dispatchKeyEvent(event)
  }

  private fun commandFor(event: KeyEvent): String? {
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0 || !event.isCtrlPressed) {
      return null
    }
    return when {
      event.keyCode == KeyEvent.KEYCODE_C && event.isShiftPressed && !event.isAltPressed ->
        "copyThreadReference"
      event.keyCode == KeyEvent.KEYCODE_H && event.isShiftPressed && !event.isAltPressed ->
        "cycleHost"
      else -> null
    }
  }
}
