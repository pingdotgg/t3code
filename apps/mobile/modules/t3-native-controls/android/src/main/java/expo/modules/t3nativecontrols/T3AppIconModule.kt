package expo.modules.t3nativecontrols

import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AppIconModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AppIcon")

    AsyncFunction("getState") {
      synchronized(this@T3AppIconModule) { iconState() }
    }

    AsyncFunction("setIcon") { id: String ->
      synchronized(this@T3AppIconModule) {
        val context = appContext.reactContext ?: throw CodedException("App context unavailable.")
        val manager = context.packageManager
        val aliases = iconActivities()
        val target = aliases.find { it.metaData.getString("t3.appIcon") == id }
          ?: throw CodedException("This app icon is unavailable in this build.")
        val changes = aliases.filter { isEnabled(it) != (it.name == target.name) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          if (changes.isNotEmpty()) {
            manager.setComponentEnabledSettings(
              changes.map {
                PackageManager.ComponentEnabledSetting(
                  ComponentName(context, it.name),
                  if (it.name == target.name) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                  } else {
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                  },
                  PackageManager.DONT_KILL_APP,
                )
              }
            )
          }
        } else {
          // Always enable the destination before removing the previous launcher entry.
          // MainActivity stays enabled, including for existing shortcuts and deep links.
          val previous = changes.associateWith {
            manager.getComponentEnabledSetting(ComponentName(context, it.name))
          }
          runCatching {
            for (activity in changes.sortedBy { it.name != target.name }) {
              manager.setComponentEnabledSetting(
                ComponentName(context, activity.name),
                if (activity.name == target.name) {
                  PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                } else {
                  PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                },
                PackageManager.DONT_KILL_APP,
              )
            }
          }.onFailure {
            // Restore previously enabled entries first, so a partial failure cannot hide the app.
            for (activity in changes.sortedBy { it.name == target.name }) {
              runCatching {
                manager.setComponentEnabledSetting(
                  ComponentName(context, activity.name),
                  previous.getValue(activity),
                  PackageManager.DONT_KILL_APP
                )
              }
            }
          }.getOrThrow()
        }
        iconState()
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun iconActivities(): List<ActivityInfo> {
    val context = appContext.reactContext ?: throw CodedException("App context unavailable.")
    return context.packageManager.getPackageInfo(
      context.packageName,
      PackageManager.GET_ACTIVITIES or PackageManager.GET_META_DATA or
        PackageManager.MATCH_DISABLED_COMPONENTS,
    ).activities.orEmpty().filter {
      it.targetActivity != null &&
        it.metaData?.containsKey("t3.appIcon") == true
    }
  }

  private fun isEnabled(activity: ActivityInfo): Boolean {
    val context = appContext.reactContext ?: throw CodedException("App context unavailable.")
    return when (
      context.packageManager.getComponentEnabledSetting(
        ComponentName(context, activity.name)
      )
    ) {
      PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> activity.enabled
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
      else -> false
    }
  }

  private fun iconState(): Map<String, Any> {
    val aliases = iconActivities()
    return mapOf(
      "icons" to aliases.map { it.metaData.getString("t3.appIcon")!! },
      "selected" to
        (aliases.singleOrNull { isEnabled(it) }?.metaData?.getString("t3.appIcon") ?: ""),
    )
  }
}
