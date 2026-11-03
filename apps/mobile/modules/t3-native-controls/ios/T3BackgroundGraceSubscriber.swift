import ExpoModulesCore
import UIKit

public final class T3BackgroundGraceSubscriber: ExpoAppDelegateSubscriber {
  private var task = UIBackgroundTaskIdentifier.invalid

  public func applicationWillResignActive(_ application: UIApplication) {
    guard task == .invalid else { return }
    task = application.beginBackgroundTask(withName: "T3 connection grace") { [weak self] in
      self?.endTask(application)
    }
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    endTask(application)
  }

  private func endTask(_ application: UIApplication) {
    guard task != .invalid else { return }
    application.endBackgroundTask(task)
    task = .invalid
  }
}
