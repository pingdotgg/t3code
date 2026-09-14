import Foundation
import Testing
import UserNotifications
@testable import T3Code

@MainActor
@Suite("Notification preferences", .serialized)
struct PlatformNotificationPreferenceTests {
    @Test
    func disablingNotificationsIgnoresAnOlderPermissionResult() async {
        let permission = NotificationPreferenceGate<Bool>()
        let recorder = NotificationPreferenceRecorder()
        let service = PlatformNotificationService(
            tokenSink: recorder,
            authorizationStatus: { .notDetermined },
            authorizationRequest: { await permission.enter() },
            updateRemoteRegistration: { recorder.registrations.append($0) }
        )
        let previousDelegate = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = previousDelegate }

        let request = Task { await service.requestAuthorization() }
        await permission.waitUntilEntered()
        #expect(await service.synchronize(enabled: false) == false)
        permission.release(true)

        #expect(await request.value == nil)
        #expect(!service.enabled)
        #expect(recorder.registrations == [false])
        #expect(recorder.invalidations == 1)
        service.didRegisterForRemoteNotifications(deviceToken: Data([1, 2]))
        #expect(recorder.tokens.isEmpty)
    }

    @Test
    func disablingNotificationsBeforeStatusLoadsDoesNotPrompt() async {
        let status = NotificationPreferenceGate<UNAuthorizationStatus>()
        let recorder = NotificationPreferenceRecorder()
        var permissionRequests = 0
        let service = PlatformNotificationService(
            tokenSink: recorder,
            authorizationStatus: { await status.enter() },
            authorizationRequest: {
                permissionRequests += 1
                return true
            },
            updateRemoteRegistration: { recorder.registrations.append($0) }
        )
        let previousDelegate = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = previousDelegate }

        let request = Task { await service.requestAuthorization() }
        await status.waitUntilEntered()
        #expect(await service.synchronize(enabled: false) == false)
        status.release(.notDetermined)

        #expect(await request.value == nil)
        #expect(permissionRequests == 0)
        #expect(!service.enabled)
        #expect(recorder.registrations == [false])
    }

    @Test
    func oldStatusDenialDoesNotReplaceNewerAuthorization() async {
        let status = NotificationPreferenceGate<UNAuthorizationStatus>()
        let recorder = NotificationPreferenceRecorder()
        var statusRequests = 0
        let service = PlatformNotificationService(
            tokenSink: recorder,
            authorizationStatus: {
                statusRequests += 1
                if statusRequests == 1 { return await status.enter() }
                return .authorized
            },
            authorizationRequest: { false },
            updateRemoteRegistration: { recorder.registrations.append($0) }
        )
        let previousDelegate = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = previousDelegate }

        let staleCheck = Task { await service.synchronize(enabled: true) }
        await status.waitUntilEntered()
        #expect(await service.requestAuthorization() == true)
        status.release(.denied)

        #expect(await staleCheck.value == nil)
        #expect(service.enabled)
        #expect(recorder.registrations == [true])
        service.didRegisterForRemoteNotifications(deviceToken: Data([1, 2]))
        #expect(recorder.tokens == ["0102"])
    }

    @Test
    func oldPermissionDenialDoesNotReplaceNewerAuthorization() async {
        let permission = NotificationPreferenceGate<Bool>()
        let recorder = NotificationPreferenceRecorder()
        var statusRequests = 0
        let service = PlatformNotificationService(
            tokenSink: recorder,
            authorizationStatus: {
                statusRequests += 1
                return statusRequests == 1 ? .notDetermined : .authorized
            },
            authorizationRequest: { await permission.enter() },
            updateRemoteRegistration: { recorder.registrations.append($0) }
        )
        let previousDelegate = UNUserNotificationCenter.current().delegate
        defer { UNUserNotificationCenter.current().delegate = previousDelegate }

        let staleRequest = Task { await service.requestAuthorization() }
        await permission.waitUntilEntered()
        #expect(await service.requestAuthorization() == true)
        permission.release(false)

        #expect(await staleRequest.value == nil)
        #expect(service.enabled)
        #expect(recorder.registrations == [true])
    }
}

@MainActor
private final class NotificationPreferenceRecorder: PlatformDeviceTokenSink {
    var registrations: [Bool] = []
    var tokens: [String] = []
    var invalidations = 0

    func registered(token: String) { tokens.append(token) }
    func registrationFailed(_ error: any Error) {}
    func invalidated() { invalidations += 1 }
}

@MainActor
private final class NotificationPreferenceGate<Value: Sendable> {
    private var result: CheckedContinuation<Value, Never>?
    private var entered: CheckedContinuation<Void, Never>?

    func enter() async -> Value {
        await withCheckedContinuation { continuation in
            result = continuation
            entered?.resume()
            entered = nil
        }
    }

    func waitUntilEntered() async {
        guard result == nil else { return }
        await withCheckedContinuation { entered = $0 }
    }

    func release(_ value: Value) {
        result?.resume(returning: value)
        result = nil
    }
}
