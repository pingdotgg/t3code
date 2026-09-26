package expo.modules.t3composereditor

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class ComposerPasteTest {
  private val context = RuntimeEnvironment.getApplication()
  private val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  private val editor = SelectionAwareEditText(context).apply {
    textPasteThresholdBytes = 32 * 1024
    maxInputChars = 120_000
  }

  private fun pasteAsText(): Boolean = editor.onKeyShortcut(
    KeyEvent.KEYCODE_V,
    KeyEvent(
      0,
      0,
      KeyEvent.ACTION_DOWN,
      KeyEvent.KEYCODE_V,
      0,
      KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    )
  )

  @Test
  fun shortcutKeepsLargeTextInlineAndUndoable() {
    val pasted = "x".repeat(32 * 1024)
    clipboard.setPrimaryClip(ClipData.newPlainText("test", pasted))
    editor.setText("before old after")
    editor.setSelection(10, 7)
    editor.pasteTextListener = { _, _, _ -> error("Inline paste must stay native") }

    assertTrue(pasteAsText())
    assertEquals("before $pasted after", editor.text.toString())
    assertTrue(editor.onTextContextMenuItem(android.R.id.undo))
    assertEquals("before old after", editor.text.toString())
  }

  @Test
  fun shortcutInterceptsInputLimitOverflowWithoutChangingTheSelection() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "hello"))
    editor.setText("x".repeat(119_999))
    editor.setSelection(10, 7)
    var intercepted: Triple<String, Int, Int>? = null
    editor.pasteTextListener = { text, start, end -> intercepted = Triple(text, start, end) }

    assertTrue(pasteAsText())
    assertEquals(Triple("hello", 7, 10), intercepted)
    assertEquals(119_999, editor.length())
    assertEquals(10, editor.selectionStart)
    assertEquals(7, editor.selectionEnd)
  }

  @Test
  fun shortcutAllowsReplacementAtTheInputLimit() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "hello"))
    editor.setText("x".repeat(120_000))
    editor.setSelection(12, 7)
    editor.pasteTextListener = { _, _, _ -> error("Replacement fits the input limit") }

    assertTrue(pasteAsText())
    assertEquals("hello", editor.text.substring(7, 12))
    assertEquals(120_000, editor.length())
  }

  @Test
  fun regularPasteStillFoldsAtTheUtf8Threshold() {
    val pasted = "é".repeat(16 * 1024)
    clipboard.setPrimaryClip(ClipData.newPlainText("test", pasted))
    editor.setText("old")
    editor.setSelection(0, 3)
    var intercepted: String? = null
    editor.pasteTextListener = { text, _, _ -> intercepted = text }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals(pasted, intercepted)
    assertEquals("old", editor.text.toString())
  }

  @Test
  fun shortcutPastesStructuredClipboardAsText() {
    clipboard.setPrimaryClip(
      ClipData.newHtmlText(
        "test",
        "plain text",
        "<pre data-t3-context-fragment=\"x\">plain text</pre>"
      )
    )
    editor.setSelection(0)
    editor.pasteContextListener = { error("Paste as Text must not import structured context") }

    assertTrue(pasteAsText())
    assertEquals("plain text", editor.text.toString())
  }

  @Test
  fun readOnlyShortcutDoesNotPasteOrEmitAnEvent() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "x".repeat(120_001)))
    editor.setText("unchanged")
    editor.setSelection(editor.length())
    editor.readOnly = true
    var intercepted: String? = null
    editor.pasteTextListener = { text, _, _ -> intercepted = text }

    assertFalse(pasteAsText())
    assertEquals("unchanged", editor.text.toString())
    assertNull(intercepted)
  }
}
