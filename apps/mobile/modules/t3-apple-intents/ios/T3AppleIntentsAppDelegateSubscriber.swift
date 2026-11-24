import CoreSpotlight
import ExpoModulesCore
import UIKit

public final class T3AppleIntentsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    T3IntentsRuntime.shared.onOpenURL = { url in
      UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }
    T3IntentsRuntime.shared.bootstrap()
    return true
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    if userActivity.activityType == CSSearchableItemActionType,
       let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
       let url = T3IntentsRuntime.shared.resolveDeepLink(forSpotlightIdentifier: identifier) {
      UIApplication.shared.open(url, options: [:], completionHandler: nil)
      return true
    }

    let isT3Activity =
      userActivity.activityType == T3IntentsConfig.threadActivityType
      || userActivity.activityType == T3IntentsConfig.projectActivityType
    if isT3Activity,
       let urlString = userActivity.userInfo?["deepLinkUrl"] as? String,
       let url = URL(string: urlString) {
      UIApplication.shared.open(url, options: [:], completionHandler: nil)
      return true
    }

    return false
  }
}
