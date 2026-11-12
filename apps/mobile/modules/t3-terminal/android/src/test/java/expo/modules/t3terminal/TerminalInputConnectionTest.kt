package expo.modules.t3terminal

import android.view.inputmethod.EditorInfo
import android.widget.EditText
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class TerminalInputConnectionTest {
  private val input = EditText(RuntimeEnvironment.getApplication())
  private val sentText = TerminalSentText()
  private val deletes = mutableListOf<Int>()
  private var writable = true
  private val connection = TerminalInputConnection(
    input.onCreateInputConnection(EditorInfo())!!,
    sentText,
    { writable },
  ) { if (writable) deletes += it }

  private fun type(text: String) {
    connection.commitText(text, 1)
    sentText.append(input.text)
    input.text.clear()
  }

  @Test
  fun imeDeletionReachesTheTerminalAfterTheInputClears() {
    type("abc")
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingTextInCodePoints(2, 0)
    connection.deleteSurroundingText(Int.MAX_VALUE, 0)

    assertEquals(listOf(1, 2, 1024), deletes)
  }

  @Test
  fun utf16DeletionOfAnEmojiSendsOneDelete() {
    type("a😀")
    connection.deleteSurroundingText(2, 0)
    connection.deleteSurroundingText(1, 0)

    assertEquals(listOf(1, 1), deletes)

    for (codePoints in listOf(false, true)) {
      deletes.clear()
      type("a😀")
      writable = false
      if (codePoints) {
        connection.deleteSurroundingTextInCodePoints(1, 0)
      } else {
        connection.deleteSurroundingText(2, 0)
      }
      writable = true
      connection.deleteSurroundingText(2, 0)
      connection.deleteSurroundingText(1, 0)

      assertEquals(listOf(1, 1), deletes)
    }

    deletes.clear()
    type("a😀")
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingText(1, 0)

    assertEquals(listOf(1, 0, 1), deletes)

    deletes.clear()
    type("a😀")
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingTextInCodePoints(1, 0)

    assertEquals(listOf(1, 1), deletes)

    deletes.clear()
    type("a😀")
    connection.deleteSurroundingText(1, 0)
    type("b")
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingText(1, 0)

    assertEquals(listOf(1, 1, 1), deletes)

    deletes.clear()
    type("x😀a")
    sentText.removeCodePoints(1)
    connection.deleteSurroundingText(2, 0)
    connection.deleteSurroundingText(1, 0)

    assertEquals(listOf(1, 1), deletes)
  }
}
