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
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let appWindow = appDelegate.window
    else {
      return
    }

    window = appWindow
    appWindow.windowScene = windowScene
    appWindow.makeKeyAndVisible()

    if let url = connectionOptions.urlContexts.first?.url {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
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

    if (!nextConfig.modResults.contents.includes("class SceneDelegate:")) {
      nextConfig.modResults.contents += SCENE_DELEGATE;
    }

    return nextConfig;
  });
};
