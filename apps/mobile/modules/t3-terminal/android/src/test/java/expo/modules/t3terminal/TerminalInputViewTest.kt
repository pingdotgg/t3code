package expo.modules.t3terminal

import android.view.inputmethod.EditorInfo
import android.view.inputmethod.TextAttribute
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class TerminalInputViewTest {
  @Test
  fun softwareBackspaceDeletesOnTheFirstPress() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    assertTrue(input.commitText("hello", 1))
    assertTrue(input.deleteSurroundingText(1, 0))

    assertEquals(listOf("hello", "\u007f"), output)
  }

  @Test
  fun codePointBackspaceDeletesEveryTime() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    input.commitText("hello", 1)
    repeat(3) { assertTrue(input.deleteSurroundingTextInCodePoints(1, 0)) }

    assertEquals(listOf("hello", "\u007f", "\u007f", "\u007f"), output)
  }

  @Test
  fun softwareEnterSendsOneCarriageReturn() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    assertTrue(input.performEditorAction(EditorInfo.IME_ACTION_SEND))

    assertEquals(listOf("\r"), output)
  }

  @Test
  fun composingTextIsSentOnceWhenCommitted() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    input.setComposingText("h", 1)
    input.setComposingText("hé", 1)
    assertEquals(emptyList<String>(), output)
    input.commitText("hé", 1)
    input.finishComposingText()

    assertEquals(listOf("hé"), output)
  }

  @Test
  fun correctingAnUncommittedCandidateDoesNotDeleteRemoteText() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    input.setComposingText("hello", 1)
    input.setComposingText("hell", 1)
    assertEquals(emptyList<String>(), output)
    input.finishComposingText()

    assertEquals(listOf("hell"), output)
  }

  @Test
  fun hardwareEditingShortcutsReachThePty() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    fun press(key: Int, modifiers: Int = 0) {
      editor.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_DOWN, key, 0, modifiers))
      editor.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_UP, key, 0, modifiers))
    }

    press(KeyEvent.KEYCODE_DEL, KeyEvent.META_CTRL_ON)
    press(KeyEvent.KEYCODE_DEL, KeyEvent.META_ALT_ON)
    press(KeyEvent.KEYCODE_U, KeyEvent.META_CTRL_ON)
    press(KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON)
    press(KeyEvent.KEYCODE_ENTER)

    assertEquals(listOf("\u0017", "\u001b\u007f", "\u0015", "\u001b[13;2u", "\r"), output)
  }

  @Test
  fun modernImeCompositionAlsoCommitsOnce() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)
    val input = requireNotNull(editor.onCreateInputConnection(EditorInfo()))
    val attributes = TextAttribute.Builder().build()

    input.setComposingText("hel", 1, attributes)
    assertEquals(emptyList<String>(), output)
    input.commitText("hello", 1, attributes)
    input.finishComposingText()

    assertEquals(listOf("hello"), output)
  }

  @Test
  fun directPasteStillReachesThePty() {
    val output = mutableListOf<String>()
    val editor = TerminalInputView(RuntimeEnvironment.getApplication(), output::add)

    editor.text.insert(0, "hello world")

    assertEquals(listOf("hello world"), output)
    assertEquals("", editor.text.toString())
  }
}
