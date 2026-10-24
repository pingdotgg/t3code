import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Local Live Activity preferences and remote setup")
struct PlatformLiveActivityPreferenceTests {
    @Test(arguments: ["signed-out", "no-relay", "ios17", "no-matching-account", "no-capability"])
    func localChoiceSavesWhenRemoteSetupIsUnavailable(reason: String) async throws {
        let suite = "LiveActivityPreference.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = LiveActivitySetupController()
        if reason == "signed-out" { relay.cloudDeliveryAccountID = nil }
        if reason == "no-relay" { relay.unavailableReason = "No relay configured." }
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: .init(defaults: defaults), deviceID: "phone",
            registrationController: relay,
            systemVersion: .init(majorVersion: reason == "ios17" ? 17 : 18, minorVersion: 0, patchVersion: 0),
            liveActivitiesAllowed: { true }
        )
        var saved = FeatureSettings()
        for enabled in [false, true] {
            let previous = saved.liveActivitiesEnabled
            let remoteSetup: (@MainActor () async throws -> Void)?
            if reason == "no-capability" {
                remoteSetup = nil
            } else {
                remoteSetup = {
                    try await coordinator.setUpLiveActivityUpdates(
                        controller: reason == "no-matching-account" ? nil : relay,
                        environments: {
                            Issue.record("Unavailable remote setup must not load host credentials")
                            return []
                        }, settings: saved, enabled: enabled, previousEnabled: previous
                    )
                }
            }
            await coordinator.applyLiveActivityPreference(savePreference: {
                saved.liveActivitiesEnabled = enabled
                defaults.set(enabled, forKey: "saved-choice")
                return saved
            }, setUpRemote: remoteSetup)
            #expect(defaults.bool(forKey: "saved-choice") == enabled)
            #expect(saved.liveActivitiesEnabled == enabled)
            #expect(!coordinator.isSettingUpLiveActivities)
            if reason == "signed-out" {
                #expect(coordinator.liveActivitySetupStatus == .signedOut)
            } else {
                guard case .unavailable = coordinator.liveActivitySetupStatus else {
                    Issue.record("Missing remote unavailability status")
                    return
                }
            }
        }
        #expect(relay.setupCalls == 0)
    }

    @Test
    func remoteDisableFailureKeepsLocalOffAndRemainsVisibleAfterDeviceRegistration() async throws {
        let suite = "LiveActivityDisableFailure.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = LiveActivitySetupController()
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: .init(defaults: defaults), deviceID: "phone",
            registrationController: relay,
            systemVersion: .init(majorVersion: 18, minorVersion: 0, patchVersion: 0),
            liveActivitiesAllowed: { true }
        )
        let gate = LiveActivitySetupGate()
        var saved = FeatureSettings()
        relay.setup = { enabled in
            #expect(!enabled)
            await gate.enter()
            throw LiveActivityPreferenceFailure()
        }
        coordinator.selectedLiveActivityEnvironmentIDs = ["studio"]
        let operation = Task { @MainActor in
            await coordinator.applyLiveActivityPreference(savePreference: {
                saved.liveActivitiesEnabled = false
                return saved
            }, setUpRemote: {
                try await coordinator.setUpLiveActivityUpdates(
                    controller: relay, environments: { [] }, settings: saved,
                    enabled: false, previousEnabled: true
                )
            })
        }
        await gate.waitUntilEntered()
        #expect(!saved.liveActivitiesEnabled)
        #expect(coordinator.isSettingUpLiveActivities)
        gate.release()
        await operation.value
        await coordinator.retryRegistration()
        #expect(!saved.liveActivitiesEnabled)
        #expect(relay.registrations.allSatisfy { !$0.preferences.liveActivitiesEnabled })
        #expect(coordinator.registrationStatus == .registered)
        #expect(coordinator.liveActivitySetupStatus == .failed("Host offline"))
        #expect(coordinator.selectedLiveActivityEnvironmentIDs == ["studio"])
        #expect(relay.setupCalls == 1)

        relay.setup = nil
        await coordinator.applyLiveActivityPreference(savePreference: { saved }, setUpRemote: {
            try await coordinator.setUpLiveActivityUpdates(
                controller: relay, environments: { [] }, settings: saved,
                enabled: false, previousEnabled: false
            )
        })
        #expect(coordinator.liveActivitySetupStatus == .registered)
        #expect(!saved.liveActivitiesEnabled)
        #expect(relay.setupCalls == 2)
    }

    @Test
    func localSaveFailureDoesNotStartRemoteEnrollment() async throws {
        let suite = "LiveActivityLocalFailure.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = PlatformCloudDeliveryCoordinator(defaults: defaults, deviceID: "phone")
        await coordinator.applyLiveActivityPreference(savePreference: {
            throw LiveActivityPreferenceFailure()
        }, setUpRemote: { Issue.record("Enrolled before saving the local preference") })
        #expect(coordinator.liveActivitySetupStatus == .failed("Host offline"))
        #expect(!coordinator.isSettingUpLiveActivities)
    }

    @Test(arguments: [false, true])
    func tokenReceivedDuringSetupRegistersAsSoonAsSetupEnds(setupFails: Bool) async throws {
        let suite = "LiveActivityPendingToken.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = LiveActivitySetupController()
        let tokenSink = PlatformPersistedDeviceTokenSink(defaults: defaults)
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: tokenSink, deviceID: "phone",
            registrationController: relay,
            systemVersion: .init(majorVersion: 18, minorVersion: 0, patchVersion: 0),
            liveActivitiesAllowed: { true }
        )
        let gate = LiveActivitySetupGate()
        let settings = FeatureSettings()
        relay.setup = { _ in
            await gate.enter()
            if setupFails { throw LiveActivityPreferenceFailure() }
        }
        let operation = Task { @MainActor in
            await coordinator.applyLiveActivityPreference(savePreference: { settings }, setUpRemote: {
                try await coordinator.setUpLiveActivityUpdates(
                    controller: relay, environments: { [] }, settings: settings,
                    enabled: true, previousEnabled: false
                )
            })
        }
        await gate.waitUntilEntered()
        tokenSink.registered(token: "new-apns-token")
        coordinator.synchronize(settings: settings)
        #expect(relay.registrations.isEmpty)
        gate.release()
        await operation.value
        // Apply drains the queued registration without a retry action or timer.
        let registration = try #require(relay.registrations.last)
        #expect(registration.pushToken == "new-apns-token")
        #expect(relay.setupCalls == 1)
        #expect(coordinator.liveActivitySetupStatus == (setupFails ? .failed("Host offline") : .registered))
    }

    @Test
    func signingInOnlyRegistersTheDevice() async throws {
        let suite = "LiveActivitySignIn.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = LiveActivitySetupController()
        relay.cloudDeliveryAccountID = nil
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: .init(defaults: defaults), deviceID: "phone",
            registrationController: relay,
            systemVersion: .init(majorVersion: 18, minorVersion: 0, patchVersion: 0)
        )
        coordinator.selectedLiveActivityEnvironmentIDs = ["studio"]
        coordinator.synchronize(settings: FeatureSettings())
        await coordinator.retryRegistration()
        relay.cloudDeliveryAccountID = "account"
        await coordinator.retryRegistration()
        #expect(relay.registrations.count == 1)
        #expect(relay.setupCalls == 0)
        #expect(coordinator.liveActivitySetupStatus == nil)
    }
}

@MainActor
private final class LiveActivitySetupController: PlatformLiveActivitySettingUp {
    var cloudDeliveryAccountID: String? = "account"
    var unavailableReason: String?
    var setup: (@MainActor (Bool) async throws -> Void)?
    private(set) var setupCalls = 0
    private(set) var registrations: [T3ConnectDeviceRegistration] = []

    func rememberRegisteredDevice(id: String) {}
    func registerDevice(_ registration: T3ConnectDeviceRegistration) async throws {
        registrations.append(registration)
    }
    func registerLiveActivity(_ registration: T3ConnectLiveActivityRegistration) async throws {}
    func setUpLiveActivityUpdates(
        environments: [T3ConnectLocalEnvironment], enabled: Bool, previousEnabled: Bool,
        deviceID: String,
        makeDeviceRegistration: @escaping @MainActor (Bool) -> T3ConnectDeviceRegistration
    ) async throws {
        setupCalls += 1
        try await setup?(enabled)
    }
}

@MainActor
private final class LiveActivitySetupGate {
    private var pending: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?

    func enter() async {
        await withCheckedContinuation { continuation in
            pending = continuation
            entered?.resume()
            entered = nil
        }
    }
    func waitUntilEntered() async {
        guard pending == nil else { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() {
        pending?.resume()
        pending = nil
    }
}

private struct LiveActivityPreferenceFailure: LocalizedError {
    var errorDescription: String? { "Host offline" }
}
