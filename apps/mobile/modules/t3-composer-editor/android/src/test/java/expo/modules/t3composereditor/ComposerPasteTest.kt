package expo.modules.t3composereditor

import android.app.Activity
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ProviderInfo
import android.net.Uri
import android.view.DragEvent
import android.view.View
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.shadows.DragEventBuilder
import org.robolectric.shadows.ShadowContentResolver
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
  fun regularPasteMeasuresAndInterceptsEveryTextItemJoinedWithNewlines() {
    // Only the complete UTF-8 payload, including both newlines, reaches 32 KiB.
    val first = "é".repeat(8191)
    val last = "x".repeat(16 * 1024)
    val clip = ClipData.newPlainText("test", first).apply {
      addItem(ClipData.Item(""))
      addItem(ClipData.Item(last))
    }
    clipboard.setPrimaryClip(clip)
    editor.setText("before old after")
    editor.setSelection(10, 7)
    val intercepted = mutableListOf<Triple<String, Int, Int>>()
    editor.pasteTextListener = { text, start, end -> intercepted.add(Triple(text, start, end)) }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals(listOf(Triple("$first\n\n$last", 7, 10)), intercepted)
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

  private fun dropEditor(): SelectionAwareEditText {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    return SelectionAwareEditText(activity).apply {
      activity.setContentView(this)
      isFocusableInTouchMode = true
      setText("before")
      setSelection(length())
      measure(
        View.MeasureSpec.makeMeasureSpec(500, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY),
      )
      layout(0, 0, 500, 200)
      requestFocus()
    }
  }

  private fun imageClip(vararg names: String): ClipData {
    val provider = DropImageProvider().apply {
      attachInfo(this@ComposerPasteTest.context, ProviderInfo().apply { authority = "images" })
    }
    ShadowContentResolver.registerProviderInternal("images", provider)
    return ClipData(
      "images",
      arrayOf("image/png", "image/jpeg"),
      ClipData.Item(Uri.parse("content://images/${names.first()}")),
    ).apply {
      names.drop(1).forEach { addItem(ClipData.Item(Uri.parse("content://images/$it"))) }
    }
  }

  private fun dragEvent(clip: ClipData, action: Int = DragEvent.ACTION_DROP): DragEvent =
    DragEventBuilder.newBuilder()
      .setAction(action)
      .setX(400f)
      .setY(10f)
      .setClipDescription(clip.description)
      .setClipData(if (action == DragEvent.ACTION_DROP) clip else null)
      .build()

  @Test
  @Config(sdk = [24, 36])
  fun imageDropAttachesEveryImageOnceWithoutInsertingUriText() {
    val target = dropEditor()
    val received = mutableListOf<List<String>>()
    target.pasteImagesListener = { received.add(it) }
    val clip = imageClip("screenshot.png", "photo.jpg")

    assertTrue(target.onDragEvent(dragEvent(clip, DragEvent.ACTION_DRAG_STARTED)))
    assertTrue(target.onDragEvent(dragEvent(clip)))
    assertEquals(
      listOf(listOf("content://images/screenshot.png", "content://images/photo.jpg")),
      received
    )
    assertEquals("before", target.text.toString())
  }

  @Test
  @Config(sdk = [24, 36])
  fun imageDropIsRejectedWhenTheComposerLocksDuringTheDrag() {
    val target = dropEditor()
    target.pasteImagesListener = { error("A locked composer must not receive images") }
    val clip = imageClip("screenshot.png")
    assertTrue(target.onDragEvent(dragEvent(clip, DragEvent.ACTION_DRAG_STARTED)))
    target.readOnly = true

    assertFalse(target.onDragEvent(dragEvent(clip)))
    assertEquals("before", target.text.toString())
  }

  @Test
  @Config(sdk = [24, 36])
  fun disabledComposerRejectsImageDrags() {
    val target = dropEditor()
    target.isEnabled = false
    target.pasteImagesListener = { error("A disabled composer must not receive images") }
    val clip = imageClip("screenshot.png")

    assertFalse(target.onDragEvent(dragEvent(clip, DragEvent.ACTION_DRAG_STARTED)))
    assertFalse(target.onDragEvent(dragEvent(clip)))
    assertEquals("before", target.text.toString())
  }

  @Test
  @Config(sdk = [24, 36])
  fun mixedImageAndTextDropDoesNotSilentlyDiscardItems() {
    val target = dropEditor()
    target.pasteImagesListener = { error("Mixed drops must not partially attach") }
    val clip = imageClip("screenshot.png").apply { addItem(ClipData.Item("hello")) }

    assertFalse(target.onDragEvent(dragEvent(clip)))
    assertEquals("before", target.text.toString())
  }

  @Test
  @Config(sdk = [24, 36])
  fun unreadableImageDropDoesNotCrashOrInsertUriText() {
    val target = dropEditor()
    target.pasteImagesListener = { error("Unreadable images must not attach") }

    assertFalse(target.onDragEvent(dragEvent(imageClip("denied.png"))))
    assertEquals("before", target.text.toString())
  }

  @Test
  @Config(sdk = [24, 36])
  fun ordinaryTextDropsKeepNativeInsertion() {
    val target = dropEditor()
    target.pasteImagesListener = { error("Text drops must stay native") }

    assertTrue(target.onDragEvent(dragEvent(ClipData.newPlainText("text", "hello"))))
    assertEquals("beforehello", target.text.toString())
  }

  private class DropImageProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri): String {
      if (uri.lastPathSegment == "denied.png") throw SecurityException("No image read grant")
      return if (uri.lastPathSegment?.endsWith(".jpg") == true) "image/jpeg" else "image/png"
    }
    override fun query(
      uri: Uri,
      projection: Array<out String>?,
      selection: String?,
      selectionArgs: Array<out String>?,
      sortOrder: String?
    ): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(
      uri: Uri,
      values: ContentValues?,
      selection: String?,
      selectionArgs: Array<out String>?
    ) = 0
  }
}
