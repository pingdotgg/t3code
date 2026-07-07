package expo.modules.t3nativecontrols

import android.content.Context
import android.view.KeyEvent
import android.view.View
import android.view.ViewTreeObserver
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher

class T3KeyboardCommandsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  private var enabledCommands = emptySet<String>()
  private val focusListener =
    ViewTreeObserver.OnGlobalFocusChangeListener { _, _ ->
      post { reclaimFocusIfAvailable() }
    }

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    descendantFocusability = FOCUS_AFTER_DESCENDANTS

    setOnKeyListener { _, keyCode, event ->
      if (hasFocusedTextInput()) return@setOnKeyListener false
      val command = HardwareKeyboardShortcutMatcher.match(keyCode, event) ?: return@setOnKeyListener false
      if (!enabledCommands.contains(command)) return@setOnKeyListener false
      onCommand(mapOf("command" to command))
      true
    }
  }

  fun setEnabledCommands(commands: List<String>) {
    enabledCommands = commands.toSet()
    post { reclaimFocusIfAvailable() }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnGlobalFocusChangeListener(focusListener)
    post { reclaimFocusIfAvailable() }
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnGlobalFocusChangeListener(focusListener)
    super.onDetachedFromWindow()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (hasWindowFocus) {
      post { reclaimFocusIfAvailable() }
    }
  }

  private fun reclaimFocusIfAvailable() {
    if (!hasWindowFocus() || hasFocusedTextInput()) return
    if (!isFocused) {
      requestFocus()
    }
  }

  private fun hasFocusedTextInput(): Boolean {
    val focused = rootView?.findFocus() ?: return false
    return focused.isTextInput()
  }
}

private fun View.isTextInput(): Boolean {
  if (this is EditText) return true
  return javaClass.name.contains("EditText", ignoreCase = true)
}