package expo.modules.t3widgetexpiry

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 36], manifest = Config.NONE)
class WidgetConfigurationActivityTest {
  private fun registerActivity(url: String?) {
    val application = RuntimeEnvironment.getApplication()
    shadowOf(application.packageManager).addOrUpdateActivity(
      ActivityInfo().apply {
        name = WidgetConfigurationActivity::class.java.name
        packageName = application.packageName
        if (url != null) {
          metaData = Bundle().apply {
            putString("t3code.widgetConfigurationUrl", url)
          }
        }
      }
    )
  }

  @Test
  fun launcherEditOpensSettingsForItsOwnWidgetAndReturnsTheId() {
    registerActivity("t3code-dev://settings/usage-widget")
    val activity = Robolectric.buildActivity(
      WidgetConfigurationActivity::class.java,
      Intent(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 42)
    ).create().get()
    val shadow = shadowOf(activity)
    val started = shadow.nextStartedActivity

    assertEquals("t3code-dev://settings/usage-widget?widgetId=42", started.data.toString())
    assertEquals("${activity.packageName}.MainActivity", started.component?.className)
    assertEquals(Activity.RESULT_OK, shadow.resultCode)
    assertEquals(42, shadow.resultIntent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1))
    assertTrue(activity.isFinishing)
  }

  @Test
  fun missingWidgetIdDoesNotOpenTheApp() {
    val activity = Robolectric.buildActivity(WidgetConfigurationActivity::class.java).create().get()

    assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
    assertNull(shadowOf(activity).nextStartedActivity)
    assertTrue(activity.isFinishing)
  }

  @Test
  fun missingRouteCancelsConfiguration() {
    registerActivity(null)
    val activity = Robolectric.buildActivity(
      WidgetConfigurationActivity::class.java,
      Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 42)
    ).create().get()

    assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
    assertNull(shadowOf(activity).nextStartedActivity)
    assertTrue(activity.isFinishing)
  }
}
