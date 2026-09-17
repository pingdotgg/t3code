const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE = `

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }

    let appWindow: UIWindow
    if let existingWindow = appDelegate.window {
      appWindow = existingWindow
    } else {
      appWindow = UIWindow(windowScene: windowScene)
      appDelegate.window = appWindow
      appDelegate.reactNativeFactory?.startReactNative(
        withModuleName: "main",
        in: appWindow,
        launchOptions: appDelegate.sceneLaunchOptions)
      appDelegate.sceneLaunchOptions = nil
    }

    window = appWindow
    appWindow.windowScene = windowScene
    appWindow.makeKeyAndVisible()

    if let url = connectionOptions.urlContexts.first?.url {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    }

    if let userActivity = connectionOptions.userActivities.first {
      _ = appDelegate.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard
      let url = URLContexts.first?.url,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }

    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    _ = appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }
}`;

module.exports = function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };

    return nextConfig;
  });

  return withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "swift") {
      throw new Error("The iOS scene lifecycle plugin requires a Swift AppDelegate.");
    }

    // Creating the window before a scene exists leaves iOS share scenes with
    // incorrect geometry, even if windowScene is assigned afterward.
    const startup =
      /window = UIWindow\(frame: UIScreen\.main\.bounds\)\s+factory\.startReactNative\(\s+withModuleName: "main",\s+in: window,\s+launchOptions: launchOptions\)/;
    if (startup.test(nextConfig.modResults.contents)) {
      nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
        startup,
        "sceneLaunchOptions = launchOptions",
      );
    } else if (!nextConfig.modResults.contents.includes("sceneLaunchOptions = launchOptions")) {
      throw new Error("Could not move React Native startup into the iOS scene lifecycle.");
    }
    if (!nextConfig.modResults.contents.includes("var sceneLaunchOptions:")) {
      nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
        "var window: UIWindow?",
        "var window: UIWindow?\n  var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?",
      );
    }
    if (!nextConfig.modResults.contents.includes("class SceneDelegate:")) {
      nextConfig.modResults.contents += SCENE_DELEGATE;
    } else {
      nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
        "in: appWindow,\n        launchOptions: nil)",
        "in: appWindow,\n        launchOptions: appDelegate.sceneLaunchOptions)\n      appDelegate.sceneLaunchOptions = nil",
      );
    }

    return nextConfig;
  });
};
