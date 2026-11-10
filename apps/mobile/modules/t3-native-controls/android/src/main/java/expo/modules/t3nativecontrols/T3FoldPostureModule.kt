package expo.modules.t3nativecontrols

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class T3FoldPostureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3FoldPosture")

    View(T3FoldPostureView::class) {
      Events("onHingeChange")
    }
  }
}

/**
 * Reports a vertical hinge, in this view's dp coordinates, while the device is bent like a book.
 * The hinge sensor is only registered while a vertical fold is on screen.
 */
class T3FoldPostureView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext), SensorEventListener {
  private val onHingeChange by EventDispatcher()
  private val sensorManager = context.getSystemService(SensorManager::class.java)
  private val hingeSensor =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      sensorManager?.getDefaultSensor(Sensor.TYPE_HINGE_ANGLE)
    } else {
      null
    }
  private var scope: CoroutineScope? = null
  private var fold: FoldingFeature? = null
  private var listening = false
  private var bent = false
  private var reported: Map<String, Any>? = null

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    observeFold()
  }

  // The activity can be missing when the view first attaches, so layout passes retry.
  private fun observeFold() {
    if (scope != null || !isAttachedToWindow) return
    val activity = appContext.currentActivity ?: return
    scope = MainScope().also { scope ->
      scope.launch {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
          fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull {
            it.orientation == FoldingFeature.Orientation.VERTICAL
          }
          listen(fold != null)
          report()
        }
      }
    }
  }

  override fun onDetachedFromWindow() {
    scope?.cancel()
    scope = null
    listen(false)
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    observeFold()
    if (changed) report()
  }

  override fun onSensorChanged(event: SensorEvent) {
    // Pixel foldables report the hinge in 5° steps and rest at 175° when nearly flat. Snapping at
    // 170° and releasing at 175° keeps a resting hinge from flapping the layout.
    val angle = event.values[0]
    bent = if (bent) angle < 175f else angle <= 170f
    report()
  }

  override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

  private fun listen(enabled: Boolean) {
    if (enabled == listening || hingeSensor == null) return
    listening = enabled
    if (enabled) {
      sensorManager.registerListener(this, hingeSensor, SensorManager.SENSOR_DELAY_UI)
    } else {
      sensorManager.unregisterListener(this)
      bent = false
    }
  }

  private fun report() {
    val feature = fold
    // Without a hinge sensor, the platform's half-opened posture is the closest signal.
    val aligned = feature != null &&
      if (hingeSensor != null) bent else feature.state == FoldingFeature.State.HALF_OPENED
    val hinge = if (aligned && feature != null) {
      val origin = IntArray(2).also { getLocationInWindow(it) }
      val density = resources.displayMetrics.density
      mapOf(
        "x" to (feature.bounds.left - origin[0]) / density,
        "windowX" to feature.bounds.left / density,
        "width" to feature.bounds.width() / density
      )
    } else {
      emptyMap()
    }
    if (hinge == reported) return
    reported = hinge
    onHingeChange(hinge)
  }
}
