@preconcurrency import UserNotifications
import UIKit

extension Notification.Name {
    static let platformRouteReceived = Notification.Name("T3PlatformRouteReceived")
    static let platformDeviceTokenChanged = Notification.Name("T3PlatformDeviceTokenChanged")
}

enum PlatformNotificationPayload {
    private static let routeKeys = ["t3_route", "route", "url", "deep_link", "deeplink"]

    static func route(from userInfo: [AnyHashable: Any]) -> PlatformRoute? {
        for key in routeKeys {
            if let value = value(named: key, in: userInfo),
               let route = try? PlatformDeepLinkParser.parse(value) {
                return route
            }
        }

        let environmentID = value(named: "environment_id", in: userInfo)
            ?? value(named: "environmentId", in: userInfo)
        if let threadID = value(named: "thread_id", in: userInfo)
            ?? value(named: "threadId", in: userInfo) {
            return .thread(environmentID: environmentID, threadID: threadID)
        }
        if let projectID = value(named: "project_id", in: userInfo)
            ?? value(named: "projectId", in: userInfo) {
            return .project(environmentID: environmentID, projectID: projectID)
        }
        return nil
    }

    private static func value(named name: String, in userInfo: [AnyHashable: Any]) -> String? {
        userInfo.first { key, _ in
            String(describing: key).caseInsensitiveCompare(name) == .orderedSame
        }.flatMap { _, value in
            let string = value as? String
            return string?.isEmpty == false ? string : nil
        }
    }
}

@MainActor
protocol PlatformDeviceTokenSink: AnyObject {
    func registered(token: String)
    func registrationFailed(_ error: Error)
    func invalidated()
}

/// Persists the APNs identity and publishes a seam for server registration.
/// The environment client can subscribe without coupling UIApplicationDelegate to transport code.
@MainActor
final class PlatformPersistedDeviceTokenSink: PlatformDeviceTokenSink {
    static let shared = PlatformPersistedDeviceTokenSink()

    private let defaults: UserDefaults
    private let key = "swift-ios.apns-device-token.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var currentToken: String? {
        defaults.string(forKey: key)
    }

    func registered(token: String) {
        defaults.set(token, forKey: key)
        NotificationCenter.default.post(
            name: .platformDeviceTokenChanged,
            object: nil,
            userInfo: ["token": token]
        )
    }

    func registrationFailed(_ error: Error) {
        NotificationCenter.default.post(
            name: .platformDeviceTokenChanged,
            object: nil,
            userInfo: ["error": error.localizedDescription]
        )
    }

    func invalidated() {
        defaults.removeObject(forKey: key)
        NotificationCenter.default.post(name: .platformDeviceTokenChanged, object: nil)
    }
}

@MainActor
final class PlatformNotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PlatformNotificationService()

    private let center: UNUserNotificationCenter
    private let tokenSink: any PlatformDeviceTokenSink
    private(set) var enabled = false

    init(
        center: UNUserNotificationCenter = .current(),
        tokenSink: (any PlatformDeviceTokenSink)? = nil
    ) {
        self.center = center
        self.tokenSink = tokenSink ?? PlatformPersistedDeviceTokenSink.shared
        super.init()
    }

    func installDelegate() {
        center.delegate = self
    }

    @discardableResult
    func synchronize(enabled: Bool) async -> Bool {
        installDelegate()

        guard enabled else {
            self.enabled = false
            UIApplication.shared.unregisterForRemoteNotifications()
            center.removeAllPendingNotificationRequests()
            center.removeAllDeliveredNotifications()
            tokenSink.invalidated()
            return false
        }

        let settings = await center.notificationSettings()
        let authorized = isAuthorized(settings.authorizationStatus)
        self.enabled = authorized
        if authorized {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return authorized
    }

    /// Call only in response to an explicit user action such as saving the
    /// Notifications toggle. Startup synchronization never presents a prompt.
    @discardableResult
    func requestAuthorization() async -> Bool {
        installDelegate()
        let settings = await center.notificationSettings()
        let authorized: Bool
        switch settings.authorizationStatus {
        case .notDetermined:
            authorized = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        case .authorized, .provisional, .ephemeral:
            authorized = true
        case .denied:
            authorized = false
        @unknown default:
            authorized = false
        }

        enabled = authorized
        if authorized {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return authorized
    }

    func schedule(_ signal: PlatformThreadSignal) async {
        guard enabled else { return }
        let settings = await center.notificationSettings()
        guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
            return
        }

        let content = UNMutableNotificationContent()
        content.title = notificationTitle(for: signal.kind)
        content.body = signal.thread.title
        content.sound = .default
        content.threadIdentifier = signal.thread.id
        if let url = PlatformRoute.thread(
            environmentID: signal.thread.environmentID,
            threadID: signal.thread.wireID ?? signal.thread.id
        ).url {
            content.userInfo = ["t3_route": url.absoluteString]
        }

        let request = UNNotificationRequest(
            identifier: "thread:\(signal.thread.id):\(signal.thread.state.rawValue)",
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        tokenSink.registered(token: deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func didFailToRegisterForRemoteNotifications(_ error: Error) {
        tokenSink.registrationFailed(error)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let route = PlatformNotificationPayload.route(
            from: response.notification.request.content.userInfo
        )
        DispatchQueue.main.async {
            defer { completionHandler() }
            guard let route else { return }
            PlatformRouteMailbox.shared.put(route)
            NotificationCenter.default.post(
                name: .platformRouteReceived,
                object: nil,
                userInfo: ["route": route]
            )
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run { enabled ? [.banner, .sound] : [] }
    }

    private func notificationTitle(for kind: PlatformFeedbackKind) -> String {
        switch kind {
        case .success:
            "Task completed"
        case .warning:
            "T3 Code needs you"
        case .error:
            "Task failed"
        }
    }

    private func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral:
            true
        case .notDetermined, .denied:
            false
        @unknown default:
            false
        }
    }
}

@MainActor
final class T3PlatformAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PlatformBackgroundRefreshCoordinator.shared.register()
        PlatformNotificationService.shared.installDelegate()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PlatformNotificationService.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PlatformNotificationService.shared.didFailToRegisterForRemoteNotifications(error)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        completionHandler(
            PlatformNotificationPayload.route(from: userInfo) == nil ? .noData : .newData
        )
    }
}
