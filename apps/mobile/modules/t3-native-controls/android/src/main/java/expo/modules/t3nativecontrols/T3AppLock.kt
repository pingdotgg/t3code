package expo.modules.t3nativecontrols

import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.app.KeyguardManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.WeakHashMap

/**
 * App Lock lives in native code so it covers the app before React loads, sits above React Native
 * modals (each is its own dialog window), and keeps app content out of the Recents thumbnail.
 */
object T3AppLock : Application.ActivityLifecycleCallbacks {
  const val DEFAULT_TIMEOUT_SECONDS = 60
  private const val CREDENTIAL_REQUEST = 7344

  private lateinit var app: Application
  private val prefs get() = app.getSharedPreferences("t3.appLock", Context.MODE_PRIVATE)
  private var locked = false
  private var authenticating = false

  /** The user dismissed the prompt; wait for a tap instead of prompting again. */
  private var promptDismissed = false
  private var startedActivities = 0
  private var credentialResult: ((Boolean) -> Unit)? = null
  private val activities = WeakHashMap<Activity, Unit>()
  private val covers = WeakHashMap<Activity, Dialog>()

  val enabled get() = prefs.getBoolean("enabled", false)
  val timeoutSeconds get() = prefs.getInt("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)

  fun start(application: Application) {
    if (::app.isInitialized) return
    app = application
    application.registerActivityLifecycleCallbacks(this)
    // The background record stays until the app comes forward: a background start must not
    // erase the time it was last closed.
    locked = enabled && !resumesWithinTimeout()
  }

  // Lifecycle

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
    activities[activity] = Unit
    applyRecentsPrivacy(activity)
  }

  override fun onActivityStarted(activity: Activity) {
    startedActivities += 1
    if (startedActivities == 1 && !authenticating) evaluateTimeout()
    if (locked) showCover(activity)
  }

  override fun onActivityResumed(activity: Activity) {
    if (credentialResult != null) {
      // The result never reached us (React was not ready to forward it): treat it as dismissed.
      finishCredential(false)
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && !locked) {
      activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    if (locked && !authenticating && !promptDismissed) authenticate(activity)
  }

  override fun onActivityPaused(activity: Activity) {
    // Before Android 13 there is no way to hide only the Recents thumbnail.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && enabled && !authenticating) {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  override fun onActivityStopped(activity: Activity) {
    startedActivities = maxOf(0, startedActivities - 1)
    val leftApp = startedActivities == 0 && !activity.isChangingConfigurations
    if (!leftApp || authenticating || !enabled) return
    if (!locked) {
      prefs.edit()
        .putLong("backgroundedAt", SystemClock.elapsedRealtime())
        .putInt("bootCount", bootCount())
        .apply()
    }
    promptDismissed = false
  }

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  override fun onActivityDestroyed(activity: Activity) {
    activities.remove(activity)
    covers.remove(activity)?.dismiss()
  }

  private fun evaluateTimeout() {
    if (!enabled) {
      locked = false
      clearBackgroundedAt()
      return
    }
    if (prefs.contains("backgroundedAt") && !resumesWithinTimeout()) {
      locked = true
      promptDismissed = false
    }
    clearBackgroundedAt()
  }

  /**
   * Times the background with elapsedRealtime, which counts deep sleep and which the user cannot
   * change. A reboot or a missing record counts as expired.
   */
  private fun resumesWithinTimeout(): Boolean {
    if (!prefs.contains("backgroundedAt") ||
      prefs.getInt("bootCount", -1) != bootCount()
    ) {
      return false
    }
    val elapsed = SystemClock.elapsedRealtime() - prefs.getLong("backgroundedAt", 0)
    return elapsed >= 0 && elapsed / 1000 < maxOf(0, timeoutSeconds)
  }

  private fun clearBackgroundedAt() {
    prefs.edit().remove("backgroundedAt").remove("bootCount").apply()
  }

  private fun bootCount() = Settings.Global.getInt(
    app.contentResolver,
    Settings.Global.BOOT_COUNT,
    -1
  )

  private fun unlock() {
    locked = false
    promptDismissed = false
    for (cover in covers.values) cover.dismiss()
    covers.clear()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      for (activity in activities.keys) {
        activity.window.clearFlags(
          WindowManager.LayoutParams.FLAG_SECURE
        )
      }
    }
  }

  private fun applyRecentsPrivacy(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.setRecentsScreenshotEnabled(!enabled)
    }
  }

  // Authentication

  private fun isDeviceSecure(context: Context) =
    context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

  private fun authenticate(activity: Activity) {
    if (!locked || authenticating) return
    if (!isDeviceSecure(activity)) {
      // Removing the screen lock takes the screen lock, so only the owner can reach this.
      prefs.edit().putBoolean("enabled", false).apply()
      unlock()
      return
    }
    requestCredential(activity) { success, dismissed ->
      if (success) {
        unlock()
      } else if (dismissed) {
        promptDismissed = true
      }
      updateCovers()
    }
    updateCovers()
  }

  /** Settings changes that weaken the lock need the owner; tightening it does not. */
  fun configure(
    activity: Activity,
    enable: Boolean,
    timeout: Int,
    onResult: (Boolean) -> Unit,
    onUnavailable: () -> Unit
  ) {
    val tightensOnly = enabled && enable && timeout <= timeoutSeconds
    val apply = {
      prefs.edit()
        .putBoolean("enabled", enable)
        .putInt("timeoutSeconds", maxOf(0, timeout))
        .apply()
      if (!enable) {
        clearBackgroundedAt()
        unlock()
      }
      for (each in activities.keys) applyRecentsPrivacy(each)
      onResult(true)
    }
    when {
      tightensOnly -> apply()
      // Without a screen lock the app lock protects nothing, so turning it off needs no prompt.
      !isDeviceSecure(activity) -> if (enable) onUnavailable() else apply()
      else -> requestCredential(activity) { success, _ ->
        if (success) apply() else onResult(false)
      }
    }
  }

  private fun requestCredential(
    activity: Activity,
    done: (success: Boolean, dismissed: Boolean) -> Unit
  ) {
    authenticating = true
    val finish = { success: Boolean, dismissed: Boolean ->
      authenticating = false
      done(success, dismissed)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val builder = BiometricPrompt.Builder(activity).setTitle(reason)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setAllowedAuthenticators(
          BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )
      } else {
        @Suppress("DEPRECATION")
        builder.setDeviceCredentialAllowed(true)
      }
      builder.build().authenticate(
        CancellationSignal(),
        activity.mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            finish(true, false)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            // The system cancels the prompt when the app leaves the screen; prompt again on return.
            finish(false, errorCode != BiometricPrompt.BIOMETRIC_ERROR_CANCELED)
          }
        }
      )
    } else {
      @Suppress("DEPRECATION")
      val intent = activity.getSystemService(KeyguardManager::class.java)
        ?.createConfirmDeviceCredentialIntent(reason, null)
      if (intent == null) {
        finish(false, true)
        return
      }
      credentialResult = { success -> finish(success, !success) }
      @Suppress("DEPRECATION")
      activity.startActivityForResult(intent, CREDENTIAL_REQUEST)
    }
  }

  fun onActivityResult(requestCode: Int, resultCode: Int) {
    if (requestCode == CREDENTIAL_REQUEST) finishCredential(resultCode == Activity.RESULT_OK)
  }

  private fun finishCredential(success: Boolean) {
    val result = credentialResult ?: return
    credentialResult = null
    result(success)
  }

  fun status(context: Context): Map<String, Any> {
    val biometric = when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
        context.getSystemService(BiometricManager::class.java)
          ?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
          BiometricManager.BIOMETRIC_SUCCESS
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
        @Suppress("DEPRECATION")
        context.getSystemService(BiometricManager::class.java)?.canAuthenticate() ==
          BiometricManager.BIOMETRIC_SUCCESS
      else -> false
    }
    return mapOf(
      "enabled" to enabled,
      "timeoutSeconds" to timeoutSeconds,
      "available" to isDeviceSecure(context),
      "biometry" to if (biometric) "biometric" else "none"
    )
  }

  fun setStrings(unlockLabel: String, reason: String) {
    prefs.edit().putString("unlockLabel", unlockLabel).putString("reason", reason).apply()
    updateCovers()
  }

  private val appName get() = app.applicationInfo.loadLabel(app.packageManager).toString()
  private val reason get() = prefs.getString("reason", null) ?: "Unlock $appName"
  private val unlockLabel get() = prefs.getString("unlockLabel", null) ?: "Unlock"

  // Cover

  private fun showCover(activity: Activity) {
    val existing = covers[activity]
    if (existing != null) {
      if (!existing.isShowing) existing.show()
      updateCovers()
      return
    }
    if (activity.isFinishing || activity.isDestroyed) return
    val night = activity.resources.configuration.uiMode and
      Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    val background = if (night) Color.BLACK else Color.WHITE
    val foreground = if (night) Color.WHITE else Color.BLACK
    val theme = if (night) {
      android.R.style.Theme_DeviceDefault_NoActionBar
    } else {
      android.R.style.Theme_DeviceDefault_Light_NoActionBar
    }
    val dialog = Dialog(activity, theme)
    dialog.setCancelable(false)
    dialog.setContentView(coverContent(activity, foreground))
    dialog.window?.apply {
      setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      setBackgroundDrawable(ColorDrawable(background))
      setWindowAnimations(0)
    }
    dialog.setOnKeyListener { _, keyCode, event ->
      if (keyCode != KeyEvent.KEYCODE_BACK) return@setOnKeyListener false
      if (event.action == KeyEvent.ACTION_UP) activity.moveTaskToBack(true)
      true
    }
    covers[activity] = dialog
    dialog.show()
    updateCovers()
  }

  private fun coverContent(activity: Activity, foreground: Int): View {
    fun dp(value: Float) =
      TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        value,
        activity.resources.displayMetrics
      ).toInt()
    val icon = ImageView(activity).apply {
      setImageDrawable(activity.packageManager.getApplicationIcon(activity.applicationInfo))
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val name = TextView(activity).apply {
      text = appName
      setTextColor(foreground)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
      gravity = Gravity.CENTER
    }
    val button = Button(activity).apply {
      tag = "unlock"
      visibility = View.GONE
      setOnClickListener {
        promptDismissed = false
        authenticate(activity)
      }
    }
    return LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      addView(icon, LinearLayout.LayoutParams(dp(72f), dp(72f)))
      addView(
        name,
        LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT
        )
          .apply { topMargin = dp(16f) }
      )
      addView(
        button,
        LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT
        )
          .apply { topMargin = dp(32f) }
      )
    }
  }

  private fun updateCovers() {
    for (cover in covers.values) {
      val button = cover.window?.decorView?.findViewWithTag<Button>("unlock") ?: continue
      button.text = unlockLabel
      button.visibility = if (locked && !authenticating) View.VISIBLE else View.GONE
    }
  }
}
