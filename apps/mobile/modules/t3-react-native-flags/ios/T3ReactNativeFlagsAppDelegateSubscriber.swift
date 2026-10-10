import ExpoModulesCore

// AppDelegate creates the React Native factory, which installs the default
// feature flags, before it forwards didFinishLaunching to subscribers. React
// Native starts later, when the scene connects.
public class T3ReactNativeFlagsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    T3ReactNativeFeatureFlags.applyOverrides()
    return true
  }
}
