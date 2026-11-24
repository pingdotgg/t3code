import UIKit
import UserNotifications

/// A thread to open: from a `conn://thread/<environment>/<thread>` URL or a push tap.
struct ThreadLink: Equatable, Sendable {
    let environmentId: String
    let threadId: String

    init(environmentId: String, threadId: String) {
        self.environmentId = environmentId
        self.threadId = threadId
    }

    /// `conn://thread/<environment>/<thread>`.
    init?(url: URL) {
        guard url.scheme == "conn", url.host() == "thread" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        environmentId = parts[0]
        threadId = parts[1]
    }

    /// A push payload's `environment_id` and `thread_id`.
    init?(userInfo: [AnyHashable: Any]) {
        guard let environmentId = userInfo["environment_id"] as? String,
              let threadId = userInfo["thread_id"] as? String,
              !environmentId.isEmpty, !threadId.isEmpty
        else { return nil }
        self.environmentId = environmentId
        self.threadId = threadId
    }
}

/// APNs callbacks and notification presentation. The store routes taps and decides
/// suppression; this class only forwards.
final class ConnAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by `ConnApp` once its store exists.
    @MainActor static weak var store: CoreStore?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistration.shared.didFailToRegister(error)
    }

    /// No banner while the app shows that thread, or the inbox, of the environment it is
    /// connected to (#229, section 4). Other threads still get one.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let link = ThreadLink(userInfo: notification.request.content.userInfo)
        let suppress = await MainActor.run { () -> Bool in
            guard let link, let store = Self.store else { return false }
            return UIApplication.shared.applicationState == .active && store.isShowing(link)
        }
        return suppress ? [] : [.banner, .list, .sound, .badge]
    }

    /// Tap-to-open: the same route as a `conn://thread/<environment>/<thread>` URL.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = ThreadLink(userInfo: response.notification.request.content.userInfo)
        else { return }
        await MainActor.run {
            Self.store?.open(link)
        }
    }
}
