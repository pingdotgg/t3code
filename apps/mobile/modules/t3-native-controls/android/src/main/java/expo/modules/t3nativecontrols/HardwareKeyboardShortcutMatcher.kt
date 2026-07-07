package expo.modules.t3nativecontrols

import android.view.KeyEvent

/**
 * Mirrors the shortcuts registered in iOS `T3KeyboardCommandsModule.swift` and
 * `hardwareKeyboardShortcutBindings.ts`.
 */
object HardwareKeyboardShortcutMatcher {
  fun match(keyCode: Int, event: KeyEvent): String? {
    if (event.action != KeyEvent.ACTION_DOWN || !event.isCtrlPressed) return null

    val shift = event.isShiftPressed
    return when (keyCode) {
      KeyEvent.KEYCODE_N -> if (!shift) "newTask" else null
      KeyEvent.KEYCODE_F -> if (shift) "files" else "focusSearch"
      KeyEvent.KEYCODE_K -> if (!shift) "focusSearch" else null
      KeyEvent.KEYCODE_LEFT_BRACKET -> if (!shift) "back" else null
      KeyEvent.KEYCODE_T -> if (shift) "terminal" else null
      KeyEvent.KEYCODE_R -> if (shift) "review" else null
      KeyEvent.KEYCODE_BACKSLASH -> if (!shift) "toggleSidebar" else null
      else -> null
    }
  }
}