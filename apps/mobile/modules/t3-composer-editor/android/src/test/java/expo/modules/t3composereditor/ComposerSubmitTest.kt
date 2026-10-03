package expo.modules.t3composereditor

import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class ComposerSubmitTest {
  private val sends = mutableListOf<Boolean>()
  private val editor = SelectionAwareEditText(RuntimeEnvironment.getApplication()).apply {
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    submitEnabled = true
    submitListener = { alternate -> sends += alternate }
  }

  private fun pressReturn(
    metaState: Int = 0,
    deviceId: Int = HARDWARE_KEYBOARD,
    repeatCount: Int = 0
  ) {
    val event = KeyEvent(
      0,
      0,
      KeyEvent.ACTION_DOWN,
      KeyEvent.KEYCODE_ENTER,
      repeatCount,
      metaState,
      deviceId,
      0,
    )
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, event)
  }

  @Test
  fun returnSendsAndCtrlReturnSendsTheAlternateWay() {
    pressReturn()
    pressReturn(KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)

    assertEquals(listOf(false, true), sends)
    assertEquals("", editor.text.toString())
  }

  @Test
  fun shiftReturnAndSoftKeyboardReturnInsertNewlines() {
    pressReturn(KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON)
    pressReturn(deviceId = KeyCharacterMap.VIRTUAL_KEYBOARD)

    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("\n\n", editor.text.toString())
  }

  @Test
  fun newlineBehaviorSendsOnlyWithCtrl() {
    editor.returnSends = false

    pressReturn()
    pressReturn(KeyEvent.META_CTRL_ON)
    pressReturn(KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)

    assertEquals(listOf(false, true), sends)
    assertEquals("\n", editor.text.toString())
  }

  @Test
  fun returnInsertsANewlineWhenSubmissionIsUnavailable() {
    editor.submitEnabled = false

    pressReturn()

    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("\n", editor.text.toString())
  }

  @Test
  fun returnInsertsANewlineWithoutASubmitListener() {
    editor.submitListener = null

    pressReturn()

    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("\n", editor.text.toString())
  }

  @Test
  fun heldReturnSendsOnce() {
    pressReturn()
    pressReturn(repeatCount = 1)
    pressReturn(repeatCount = 2)

    assertEquals(listOf(false), sends)
    assertEquals("", editor.text.toString())
  }

  private companion object {
    const val HARDWARE_KEYBOARD = 1
  }
}
