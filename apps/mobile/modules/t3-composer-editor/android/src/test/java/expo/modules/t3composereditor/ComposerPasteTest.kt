package expo.modules.t3composereditor

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
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
  fun regularPasteInterceptsEveryTextItemJoinedWithNewlines() {
    val first = "x".repeat(32 * 1024)
    val clip = ClipData.newPlainText("test", first).apply {
      addItem(ClipData.Item("ITEM_2"))
      addItem(ClipData.Item("ITEM_3"))
    }
    clipboard.setPrimaryClip(clip)
    editor.setText("before old after")
    editor.setSelection(10, 7)
    val intercepted = mutableListOf<Triple<String, Int, Int>>()
    editor.pasteTextListener = { text, start, end -> intercepted.add(Triple(text, start, end)) }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals(1, intercepted.size)
    assertEquals("$first\nITEM_2\nITEM_3", intercepted.single().first)
    assertEquals(7, intercepted.single().second)
    assertEquals(10, intercepted.single().third)
    assertEquals("before old after", editor.text.toString())
    assertEquals(10, editor.selectionStart)
    assertEquals(7, editor.selectionEnd)
  }

  @Test
  fun regularPasteKeepsClipsWithAnyUriItemNative() {
    editor.textPasteThresholdBytes = 1
    editor.pasteTextListener = { _, _, _ -> error("URI-backed clips must stay native") }
    for (uriIndex in 0..2) {
      val items = (0..2).map { index ->
        if (index == uriIndex) {
          ClipData.Item("ITEM_$index", null, Uri.parse("content://test/item/$index"))
        } else {
          ClipData.Item("ITEM_$index")
        }
      }
      val clip = ClipData("test", arrayOf(ClipDescription.MIMETYPE_TEXT_PLAIN), items[0]).apply {
        addItem(items[1])
        addItem(items[2])
      }
      clipboard.setPrimaryClip(clip)
      editor.setText("before old after")
      editor.setSelection(10, 7)

      assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
      assertEquals("before ITEM_0\nITEM_1\nITEM_2 after", editor.text.toString())
    }
  }

  @Test
  fun regularPasteKeepsAnEmptyTextClipNative() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", ""))
    editor.setText("unchanged")
    editor.setSelection(editor.length())
    editor.textPasteThresholdBytes = 1
    editor.pasteTextListener = { _, _, _ -> error("Empty clips must stay native") }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals("unchanged", editor.text.toString())
  }

  @Test
  fun pasteAsTextKeepsAZeroItemClipNative() {
    val clip = ClipData.newPlainText("test", "")
    // Android's public constructors require an item; construct the empty edge case explicitly.
    val items = ClipData::class.java.getDeclaredField("mItems").apply {
      isAccessible = true
    }.get(clip) as MutableList<*>
    items.clear()
    assertEquals(0, clip.itemCount)
    clipboard.setPrimaryClip(clip)
    editor.setText("unchanged")
    editor.setSelection(editor.length())
    editor.textPasteThresholdBytes = 1
    editor.pasteTextListener = { _, _, _ -> error("Zero-item clips must stay native") }

    assertTrue(pasteAsText())
    assertEquals("unchanged", editor.text.toString())
  }

  @Test
  fun regularPasteKeepsSingleItemTextNativeAndUndoable() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "hello"))
    editor.setText("before old after")
    editor.setSelection(10, 7)
    editor.pasteTextListener = { _, _, _ -> error("Small single-item paste must stay native") }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals("before hello after", editor.text.toString())
    assertTrue(editor.onTextContextMenuItem(android.R.id.undo))
    assertEquals("before old after", editor.text.toString())
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
