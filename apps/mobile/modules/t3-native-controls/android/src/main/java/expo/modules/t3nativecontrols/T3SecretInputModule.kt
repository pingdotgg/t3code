package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.PasswordTransformationMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3SecretInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3SecretInput")

    View(T3SecretInputView::class) {
      Prop("value") { view: T3SecretInputView, value: String -> view.setValue(value) }
      Prop("placeholder") { view: T3SecretInputView, value: String ->
        view.input.hint = value
      }
      // Not "accessibilityLabel": React Native applies that to the outer view, not the EditText.
      Prop("inputLabel") { view: T3SecretInputView, value: String ->
        view.input.contentDescription = value
      }
      Prop("textColor") { view: T3SecretInputView, value: Int -> view.input.setTextColor(value) }
      Prop("placeholderColor") { view: T3SecretInputView, value: Int ->
        view.input.setHintTextColor(value)
      }
      Prop("cursorColor") { view: T3SecretInputView, value: Int -> view.setCursorColor(value) }
      Prop("fontSize") { view: T3SecretInputView, value: Float ->
        view.input.setTextSize(TypedValue.COMPLEX_UNIT_DIP, value)
      }
      Prop("editable") { view: T3SecretInputView, value: Boolean -> view.input.isEnabled = value }
      Prop("revealed") { view: T3SecretInputView, value: Boolean -> view.setRevealed(value) }
      Events("onChangeText", "onSubmit")
    }
  }
}

/**
 * Masked single-line input for secret requests. React Native's own TextInput cannot opt out of
 * credential autofill, so password managers offer logins above the keyboard; this view owns the
 * EditText so it can.
 */
class T3SecretInputView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Yoga sizes this view; the EditText inside is laid out by Android.
  override val shouldUseAndroidLayout = true

  // Newer Android can request autofill even with importantForAutofill=no.
  // Reporting no autofill type keeps this input out of credential autofill.
  val input = object : EditText(context) {
    override fun getAutofillType(): Int = View.AUTOFILL_TYPE_NONE
  }
  private val onChangeText by EventDispatcher()
  private val onSubmit by EventDispatcher()
  private var applyingValue = false

  // Values sent to JS that its state has not echoed back yet. An echo of an older value would
  // otherwise overwrite characters typed in the meantime.
  private val unechoed = ArrayDeque<String>()

  init {
    input.background = null
    input.setPadding(0, 0, 0, 0)
    input.gravity = Gravity.CENTER_VERTICAL or Gravity.START
    // The autofill APIs arrive with API 26; minSdk is 24.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      input.importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
    }
    input.imeOptions = EditorInfo.IME_ACTION_DONE
    // Not setSingleLine(): that swaps out the password transformation. The password variation is
    // already single line, and the keyboard keeps typed text out of suggestions.
    input.inputType =
      InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    // The password variation switches the typeface to monospace.
    input.typeface = Typeface.DEFAULT
    input.setTextColor(Color.BLACK)
    input.setHintTextColor(Color.GRAY)
    input.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(s: Editable?) {
          if (applyingValue) return
          val value = s?.toString() ?: ""
          unechoed.addLast(value)
          onChangeText(mapOf("value" to value))
        }
      }
    )
    input.setOnEditorActionListener { _, actionId, event ->
      if (actionId == EditorInfo.IME_ACTION_DONE || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
        // Hardware Enter reports IME_NULL on Android 13 and earlier, and both key down and key up.
        if (event == null || event.action == KeyEvent.ACTION_DOWN) {
          onSubmit(mapOf("value" to input.text.toString()))
        }
        true
      } else {
        false
      }
    }
    addView(
      input,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
  }

  /** Applies JS state without echoing it back, and without moving the caret on equal values. */
  fun setValue(value: String) {
    val echoed = unechoed.indexOf(value)
    if (echoed >= 0) {
      repeat(echoed + 1) { unechoed.removeFirst() }
      return
    }
    // A value JS chose itself, such as clearing after a save.
    unechoed.clear()
    if (input.text.toString() == value) return
    applyingValue = true
    input.setText(value)
    input.setSelection(input.text.length)
    applyingValue = false
  }

  /** Swapping the transformation re-sets the text, so it neither echoes to JS nor moves the caret. */
  fun setRevealed(revealed: Boolean) {
    val method = if (revealed) null else PasswordTransformationMethod.getInstance()
    if (input.transformationMethod == method) return
    val start = input.selectionStart
    val end = input.selectionEnd
    applyingValue = true
    input.transformationMethod = method
    if (start >= 0 && end >= 0) input.setSelection(start, end)
    applyingValue = false
  }

  fun setCursorColor(color: Int) {
    input.highlightColor = Color.argb(0x52, Color.red(color), Color.green(color), Color.blue(color))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

    input.textCursorDrawable = input.textCursorDrawable?.mutate()?.apply { setTint(color) }
    input.textSelectHandle?.mutate()?.setTint(color)
    input.textSelectHandleLeft?.mutate()?.setTint(color)
    input.textSelectHandleRight?.mutate()?.setTint(color)
  }
}
