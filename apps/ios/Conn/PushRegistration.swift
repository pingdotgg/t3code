import Foundation
import Observation
import OSLog
import UIKit
import UserNotifications

/// Registers this iPhone for push with the Orbit Gateway (design: nckrtl/conn #229, section 4).
///
/// - Runs only once the Gateway knows this phone as an Orbit Node (`OrbitCore.me()` answers).
/// - Asks for permission at the first thread start or send, after a short explainer, never at
///   launch.
/// - Sends `PUT /api/v1/conn/me/push-device` on every launch and token change, and
///   `DELETE /api/v1/conn/me/push-device/{device_id}` on sign-out.
/// - The Gateway routes land behind a flag, so a 404 (and any network failure) is logged and
///   otherwise ignored.
@MainActor
@Observable
final class PushRegistration {
    static let shared = PushRegistration()

    /// The explainer sheet ("Get told when an agent needs you") is on screen.
    var showsExplainer = false

    @ObservationIgnored private var apnsTokenHex: String?
    @ObservationIgnored private var isOrbitNode = false
    @ObservationIgnored private var started = false
    @ObservationIgnored private let log = Logger(subsystem: "com.nckrtl.conn.ios", category: "push")

    private static let askedKey = "push.permissionAsked"
    private static let gatewayBase = URL(string: "https://gateway.orbit/api/v1/conn")!

    private init() {}

    /// Called once at launch. Re-registers with APNs when permission was given before, which
    /// hands back the current token and so sends the registration again.
    func start() async {
        guard !started else { return }
        started = true
        isOrbitNode = await Self.gatewayKnowsThisNode()
        guard isOrbitNode else {
            log.info("push: the Orbit Gateway does not know this phone as a Node; not registering")
            return
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    /// A thread was started or a message sent. The first time, after Orbit sign-in, this shows
    /// the explainer before the system permission prompt.
    func noteThreadActivity() {
        guard isOrbitNode, !UserDefaults.standard.bool(forKey: Self.askedKey) else { return }
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard settings.authorizationStatus == .notDetermined else {
                UserDefaults.standard.set(true, forKey: Self.askedKey)
                return
            }
            showsExplainer = true
        }
    }

    /// The user tapped "Turn on notifications" in the explainer.
    func acceptExplainer() {
        UserDefaults.standard.set(true, forKey: Self.askedKey)
        showsExplainer = false
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            } catch {
                log.error("push: permission request failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// The user tapped "Not now". Settings can turn push on later.
    func declineExplainer() {
        UserDefaults.standard.set(true, forKey: Self.askedKey)
        showsExplainer = false
    }

    /// APNs handed us a token (every launch, and again whenever it changes).
    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        apnsTokenHex = hex
        Task { await upload(token: hex) }
    }

    func didFailToRegister(_ error: Error) {
        log.error("push: APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// Sign-out: remove this device from the Gateway's registry.
    func unregister() async {
        guard isOrbitNode else { return }
        let deviceId = KeychainStore.pushDeviceId()
        var request = URLRequest(url: Self.gatewayBase.appending(path: "me/push-device/\(deviceId)"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        await send(request, what: "unregister")
    }

    // MARK: - Gateway calls

    private func upload(token: String) async {
        guard isOrbitNode else { return }
        let body = PushDeviceBody(
            deviceId: KeychainStore.pushDeviceId(),
            apnsToken: token,
            apnsEnvironment: Self.apnsEnvironment(),
            bundleId: Bundle.main.bundleIdentifier ?? "com.nckrtl.conn.ios",
            appVersion: Self.appVersion(),
            iosVersion: UIDevice.current.systemVersion,
            locale: Locale.current.identifier(.bcp47),
            preferences: PushPreferences.stored()
        )
        var request = URLRequest(url: Self.gatewayBase.appending(path: "me/push-device"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(body)
        } catch {
            log.error("push: could not encode the registration: \(error.localizedDescription, privacy: .public)")
            return
        }
        await send(request, what: "register")
    }

    private func send(_ request: URLRequest, what: String) async {
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200..<300:
                log.info("push: \(what, privacy: .public) ok (\(status))")
            case 404:
                // The Gateway's push routes are behind a flag and may not exist yet.
                log.info("push: \(what, privacy: .public): the Gateway has no push routes yet (404)")
            default:
                log.error("push: \(what, privacy: .public) answered \(status)")
            }
        } catch {
            log.error("push: \(what, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// True when the Orbit Gateway answers `me` for this phone, i.e. it is an Orbit Node.
    private static func gatewayKnowsThisNode() async -> Bool {
        do {
            let orbit = try OrbitCore(gatewayUrl: nil)
            _ = try await orbit.me()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Build facts

    /// `sandbox` or `production`, from the `aps-environment` entitlement in the embedded
    /// provisioning profile. Builds without a profile (the simulator) use sandbox.
    static func apnsEnvironment() -> String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plistData = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String
        else {
            return "sandbox"
        }
        return environment == "production" ? "production" : "sandbox"
    }

    private static func appVersion() -> String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}

/// The body of `PUT /api/v1/conn/me/push-device` (snake_case on the wire).
private struct PushDeviceBody: Encodable {
    let deviceId: String
    let apnsToken: String
    let apnsEnvironment: String
    let bundleId: String
    let appVersion: String
    let iosVersion: String
    let locale: String
    let preferences: PushPreferences
}

/// Which kinds this device wants, and whether to hide thread titles. All kinds are on by default
/// (#229, section 1). Settings › Notifications edits them in a follow-up.
struct PushPreferences: Codable, Equatable {
    var approval = true
    var input = true
    var turnFinished = true
    var turnFailed = true
    var hideTitles = false

    private static let key = "push.preferences"

    static func stored() -> PushPreferences {
        guard let data = UserDefaults.standard.data(forKey: key),
              let decoded = try? JSONDecoder().decode(PushPreferences.self, from: data)
        else {
            return PushPreferences()
        }
        return decoded
    }
}
