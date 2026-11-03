package expo.modules.t3composereditor

import android.text.InputType
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.InputDeviceBuilder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class ComposerSubmitTest {
  private val sends = mutableListOf<Boolean>()
  private val editor = SelectionAwareEditText(RuntimeEnvironment.getApplication()).apply {
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    submitEnabled = true
    submitListener = { alternate -> sends += alternate }
  }

  private fun keyboard(id: Int, type: Int = InputDevice.KEYBOARD_TYPE_ALPHABETIC): InputDevice =
    InputDeviceBuilder.newBuilder()
      .setId(id)
      .setSources(InputDevice.SOURCE_KEYBOARD)
      .setKeyboardType(type)
      .build()

  private fun pressReturn(
    metaState: Int = 0,
    device: InputDevice = keyboard(1),
    repeatCount: Int = 0,
    flags: Int = 0
  ) {
    val event = KeyEvent(
      0,
      0,
      KeyEvent.ACTION_DOWN,
      KeyEvent.KEYCODE_ENTER,
      repeatCount,
      metaState,
      device.id,
      0,
      flags,
    )
    // Robolectric's getDevice() reads the event's shadow, not the InputManager device list.
    shadowOf(event).setDevice(device)
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, event)
  }

  @Test
  fun sendBehaviorSendsOnReturnAndInsertsANewlineOnShiftReturn() {
    pressReturn()
    pressReturn(KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)
    pressReturn(KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON)

    assertEquals(listOf(false, true), sends)
    assertEquals("\n", editor.text.toString())
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
  fun onScreenKeyboardReturnInsertsANewline() {
    pressReturn(device = keyboard(KeyCharacterMap.VIRTUAL_KEYBOARD), flags = KeyEvent.FLAG_SOFT_KEYBOARD)
    // Some IMEs send device 0, the phone's key-only built-in "keyboard", without FLAG_SOFT_KEYBOARD.
    pressReturn(device = keyboard(0, InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC))

    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("\n\n", editor.text.toString())
  }

  @Test
  fun heldReturnSendsOnce() {
    pressReturn()
    pressReturn(repeatCount = 1)
    pressReturn(repeatCount = 2)

    assertEquals(listOf(false), sends)
    assertEquals("", editor.text.toString())
  }

  @Test
  fun returnNeverSendsFromAComposerThatCannotSubmit() {
    editor.submitEnabled = false
    pressReturn()
    editor.submitEnabled = true

    editor.readOnly = true
    pressReturn()

    assertEquals(emptyList<Boolean>(), sends)
  }
}
