package expo.modules.t3terminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText

private const val MAX_REMOTE_DELETE_KEYS = 1024

internal class TerminalInputView(
  context: Context,
  private val onInput: (String) -> Unit
) : EditText(context) {
  private var editingFromInputConnection = false

  init {
    configureInput()
  }

  private fun configureInput() {
    setSingleLine(true)
    setTextColor(Color.TRANSPARENT)
    setHintTextColor(Color.TRANSPARENT)
    setBackgroundColor(Color.TRANSPARENT)
    typeface = Typeface.MONOSPACE
    textSize = 13f
    alpha = 0.01f
    isFocusableInTouchMode = true
    imeOptions = EditorInfo.IME_ACTION_SEND or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      EditorInfo.IME_FLAG_NO_FULLSCREEN or
      EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    setPadding(0, 0, 0, 0)
    setOnEditorActionListener { _, actionId, event ->
      val isKeyUp = event?.action == KeyEvent.ACTION_UP
      val isImeSend = actionId == EditorInfo.IME_ACTION_SEND && !isKeyUp
      val isHardwareEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER &&
        event.action == KeyEvent.ACTION_DOWN
      val isEnter = isImeSend || isHardwareEnter
      if (isEnter) {
        commitPendingText()
        // Enter must send CR: raw-mode TUIs treat LF as Ctrl+J (insert newline).
        onInput("\r")
        true
      } else {
        false
      }
    }
    setOnKeyListener { _, keyCode, event -> handleKeyDown(keyCode, event) }
    addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

        override fun afterTextChanged(editable: Editable?) {
          if (!editingFromInputConnection) flushCommittedText()
        }
      },
    )
  }

  private fun handleKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN) return false
    return when {
      keyCode == KeyEvent.KEYCODE_DEL && text.isNotEmpty() -> false
      keyCode == KeyEvent.KEYCODE_DEL -> {
        onInput(
          when {
            event.isCtrlPressed -> "\u0017"
            event.isAltPressed -> "\u001b\u007f"
            else -> "\u007f"
          },
        )
        true
      }
      keyCode == KeyEvent.KEYCODE_ENTER && event.isShiftPressed -> {
        commitPendingText()
        onInput("\u001b[13;2u")
        true
      }
      // Hardware keyboard Ctrl+A..Z -> control bytes 0x01..0x1A (Ctrl+C, Ctrl+Z, ...).
      event.isCtrlPressed && keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> {
        onInput(
          (keyCode - KeyEvent.KEYCODE_A + 1).toChar().toString(),
        )
        true
      }
      else -> false
    }
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val target = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(target, false) {
      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        val accepted = editFromInputConnection { super.commitText(text, newCursorPosition) }
        if (accepted) flushCommittedText()
        return accepted
      }

      override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean =
        editFromInputConnection { super.setComposingText(text, newCursorPosition) }

      override fun finishComposingText(): Boolean {
        val accepted = editFromInputConnection { super.finishComposingText() }
        if (accepted) flushCommittedText()
        return accepted
      }

      override fun closeConnection() {
        // Target cleanup can finish composition without calling this wrapper.
        editFromInputConnection { super.closeConnection() }
        flushCommittedText()
      }

      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (this@TerminalInputView.text.isNotEmpty()) {
          return editFromInputConnection { super.deleteSurroundingText(beforeLength, afterLength) }
        }
        return sendRemoteDelete(beforeLength, afterLength)
      }

      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (this@TerminalInputView.text.isNotEmpty()) {
          return editFromInputConnection {
            super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
          }
        }
        return sendRemoteDelete(beforeLength, afterLength)
      }
    }
  }

  private fun commitPendingText() {
    // Some IMEs submit without finishing composition first.
    BaseInputConnection.removeComposingSpans(text)
    flushCommittedText()
  }

  private fun flushCommittedText() {
    val editable = text
    if (editable.isEmpty() || BaseInputConnection.getComposingSpanStart(editable) >= 0) return
    onInput(editable.toString())
    editFromInputConnection { editable.clear() }
  }

  private fun <T> editFromInputConnection(edit: () -> T): T {
    val previous = editingFromInputConnection
    editingFromInputConnection = true
    return try {
      edit()
    } finally {
      editingFromInputConnection = previous
    }
  }

  private fun sendRemoteDelete(beforeLength: Int, afterLength: Int): Boolean {
    // The empty editable cannot bound IME requests. Reject oversized key
    // expansions rather than allocating on the UI thread or deleting partially.
    if (
      beforeLength < 0 || afterLength < 0 ||
      beforeLength.toLong() + afterLength.toLong() > MAX_REMOTE_DELETE_KEYS
    ) {
      return false
    }
    // The committed text lives in the remote PTY, so Android's empty local
    // editable cannot implement deletion for software keyboards.
    val data = "\u007f".repeat(beforeLength) + "\u001b[3~".repeat(afterLength)
    if (data.isNotEmpty()) onInput(data)
    return true
  }
}
