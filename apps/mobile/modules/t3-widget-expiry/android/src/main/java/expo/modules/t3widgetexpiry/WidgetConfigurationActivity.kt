package expo.modules.t3widgetexpiry

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle

/** The launcher's Edit action opens the same per-widget settings as the app. */
class WidgetConfigurationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val id = intent.getIntExtra(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID
    )
    if (id == AppWidgetManager.INVALID_APPWIDGET_ID) {
      setResult(RESULT_CANCELED)
      finish()
      return
    }
    val metadata = packageManager.getActivityInfo(
      ComponentName(this, javaClass),
      PackageManager.GET_META_DATA
    ).metaData
    val url = metadata?.getString("t3code.widgetConfigurationUrl") ?: run {
      setResult(RESULT_CANCELED)
      finish()
      return
    }
    startActivity(
      Intent(
        Intent.ACTION_VIEW,
        Uri.parse(url).buildUpon().appendQueryParameter("widgetId", id.toString()).build()
      )
        .setClassName(packageName, "$packageName.MainActivity")
    )
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
    finish()
  }
}
