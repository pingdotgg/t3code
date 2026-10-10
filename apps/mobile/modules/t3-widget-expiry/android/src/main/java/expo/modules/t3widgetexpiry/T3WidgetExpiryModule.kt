package expo.modules.t3widgetexpiry

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3WidgetExpiryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3WidgetExpiry")
    Function("getWidgetIds") {
      val context = appContext.reactContext ?: return@Function emptyList<Int>()
      AppWidgetManager.getInstance(context).getAppWidgetIds(
        ComponentName(context.packageName, "${context.packageName}.SubscriptionUsageProvider")
      ).toList()
    }
    Function("pinWidget") {
      val context = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
      val manager = AppWidgetManager.getInstance(context)
      manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(
        ComponentName(context.packageName, "${context.packageName}.SubscriptionUsageProvider"),
        null,
        null
      )
    }
    Function("schedule") { name: String, deadlines: List<Double> ->
      val context = appContext.reactContext ?: return@Function
      WidgetExpiryReceiver.schedule(context, name, deadlines.map { it.toLong() }.toLongArray())
    }
  }
}
