package expo.modules.t3reactnativeflags

import android.app.Application
import android.content.Context
import com.facebook.react.common.build.ReactBuildConfig
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

/**
 * Turns on React Native's `preventShadowTreeCommitExhaustion`.
 *
 * Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` (apps/mobile/package.json) is only safe with
 * it. Without it, Reanimated commits every animation frame and a React commit that takes longer
 * than a frame is retried forever, so the app stops responding.
 */
class T3ReactNativeFlagsPackage : Package {
  override fun createApplicationLifecycleListeners(
    context: Context?
  ): List<ApplicationLifecycleListener> = listOf(FeatureFlagOverrides)
}

// MainApplication installs the default flags in loadReactNative() before Expo dispatches
// onCreate, so only a forced override can change a flag without building React Native from
// source. In debug builds, expo-dev-launcher creates the React host first, which reads a few
// flags; they keep their values, since the provider only changes one flag, and that one must not
// have been read yet. The React host starts later, with the first activity.
private object FeatureFlagOverrides : ApplicationLifecycleListener {
  override fun onCreate(application: Application?) {
    val accessedFlags = ReactNativeFeatureFlags.dangerouslyForceOverride(T3FeatureFlagsProvider())
    if (ReactBuildConfig.DEBUG) {
      check(accessedFlags?.split(", ")?.contains("preventShadowTreeCommitExhaustion") != true) {
        "React Native read preventShadowTreeCommitExhaustion before T3ReactNativeFlags overrode it"
      }
    }
  }
}

// The stable release level MainApplication loads by default, plus the one flag Reanimated needs.
private class T3FeatureFlagsProvider :
  ReactNativeFeatureFlagsProvider by ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android() {
  override fun preventShadowTreeCommitExhaustion(): Boolean = true
}
