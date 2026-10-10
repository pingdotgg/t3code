import Foundation
import Testing
import UserNotifications
@testable import T3Code

@MainActor
@Suite("Foreground notification routing")
struct PlatformForegroundNotificationTests {
    @Test
    func foregroundDeliveryIncludesNotificationCenterExceptForTheVisibleThread() async {
        let service = PlatformNotificationService(
            tokenSink: ForegroundNotificationTokenSink(),
            authorizationStatus: { .authorized }, updateRemoteRegistration: { _ in }
        )
        let prior = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = prior }
        let tracker = PlatformVisibleThreadTracker()
        tracker.setVisibleThread(environmentID: "env-a", wireID: "thread")
        _ = await service.synchronize(enabled: true)
        #expect(service.foregroundPresentationOptions(
            for: .thread(environmentID: "env-b", threadID: "thread"), tracker: tracker
        ) == [.banner, .list, .sound])
        #expect(service.foregroundPresentationOptions(
            for: .thread(environmentID: "env-a", threadID: "thread"), tracker: tracker
        ).isEmpty)
        _ = await service.synchronize(enabled: false)
        #expect(service.foregroundPresentationOptions(for: nil, tracker: tracker).isEmpty)
    }

    @Test
    func suppressesOnlyTheVisibleEnvironmentAndWireThread() {
        let tracker = PlatformVisibleThreadTracker()
        tracker.setVisibleThread(environmentID: "env-a", wireID: "shared-thread")
        #expect(tracker.suppresses(.thread(environmentID: "env-a", threadID: "shared-thread")))
        #expect(tracker.suppresses(.threadDestination(environmentID: "env-a", threadID: "shared-thread",
                                                    destination: .files(path: nil, line: nil))))
        #expect(!tracker.suppresses(.thread(environmentID: "env-b", threadID: "shared-thread")))
        #expect(!tracker.suppresses(.thread(environmentID: nil, threadID: "shared-thread")))
        #expect(!tracker.suppresses(.thread(environmentID: "env-a", threadID: "other")))
        #expect(!tracker.suppresses(nil))
        tracker.clear(environmentID: "env-b", wireID: "shared-thread")
        #expect(tracker.visibleThread != nil)
        tracker.clear(environmentID: "env-a", wireID: "shared-thread")
        #expect(!tracker.suppresses(.thread(environmentID: "env-a", threadID: "shared-thread")))
    }

    @Test
    func relativeRemotePayloadCarriesDecodedEnvironmentAndThread() {
        let route = PlatformNotificationPayload.route(from: ["deepLink": "/threads/env%20a/thread%2F1"])
        #expect(route == .thread(environmentID: "env a", threadID: "thread/1"))
        #expect(PlatformNotificationPayload.route(from: ["deepLink": "//evil.example/thread"]) == nil)
    }

    @Test
    func APNsFailureIsVisibleAndSuccessfulRegistrationClearsIt() async {
        let sink = ForegroundNotificationTokenSink()
        let service = PlatformNotificationService(
            tokenSink: sink, authorizationStatus: { .authorized }, updateRemoteRegistration: { _ in }
        )
        let prior = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = prior }
        _ = await service.synchronize(enabled: true)
        service.didFailToRegisterForRemoteNotifications(URLError(.notConnectedToInternet))
        #expect(service.remoteRegistrationError != nil)
        service.didRegisterForRemoteNotifications(deviceToken: Data([12, 34]))
        #expect(service.remoteRegistrationError == nil)
        #expect(service.hasRemoteToken)
        #expect(sink.token == "0c22")
        _ = await service.synchronize(enabled: false)
        #expect(!service.hasRemoteToken)
    }
}

@MainActor
private final class ForegroundNotificationTokenSink: PlatformDeviceTokenSink {
    var token: String?
    func registered(token: String) { self.token = token }
    func registrationFailed(_ error: any Error) {}
    func invalidated() { token = nil }
}
