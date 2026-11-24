package expo.modules.t3nativecontrols

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

// Starts App Lock with the process, before any activity draws.
class T3AppLockPackage : Package {
  override fun createApplicationLifecycleListeners(
    context: Context
  ): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          T3AppLock.start(application)
        }
      }
    )
}
