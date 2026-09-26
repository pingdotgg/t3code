package expo.modules.t3subscriptionwidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class T3SubscriptionWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3SubscriptionWidget")
    Function("updateSnapshot") { snapshot: String ->
      val context = appContext.reactContext ?: return@Function
      JSONObject(snapshot) // Reject malformed writes before replacing the saved snapshot.
      context.getSharedPreferences(SubscriptionUsageWidget.PREFERENCES, 0)
        .edit().putString("snapshot", snapshot).apply()
      SubscriptionUsageWidget.updateAll(context)
    }
  }
}
