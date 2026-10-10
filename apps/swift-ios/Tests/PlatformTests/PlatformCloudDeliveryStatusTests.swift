import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Remote registration state")
struct PlatformCloudDeliveryStatusTests {
    @Test
    func relayFailureRemainsVisibleUntilRetrySucceeds() async throws {
        let suite = "CloudDeliveryStatus.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = RegistrationController()
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: .init(defaults: defaults), deviceID: "phone",
            registrationController: relay
        )
        coordinator.synchronize(settings: FeatureSettings())
        await coordinator.retryRegistration()
        #expect(coordinator.registrationStatus == .failed("Relay unavailable"))
        #expect(relay.registrations == 1)

        relay.shouldFail = false
        await coordinator.retryRegistration()
        #expect(coordinator.registrationStatus == .registered)
        #expect(relay.registrations == 2)
        #expect(relay.rememberedDeviceID == "phone")
    }

    @Test
    func signedOutDeviceDoesNotReportSuccessfulRemoteRegistration() async throws {
        let suite = "CloudDeliverySignedOut.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let relay = RegistrationController()
        relay.cloudDeliveryAccountID = nil
        let coordinator = PlatformCloudDeliveryCoordinator(
            defaults: defaults, tokenSink: .init(defaults: defaults), deviceID: "phone",
            registrationController: relay
        )
        coordinator.synchronize(settings: FeatureSettings())
        await coordinator.retryRegistration()
        #expect(coordinator.registrationStatus == .signedOut)
        #expect(relay.registrations == 0)
    }
}

@MainActor
private final class RegistrationController: PlatformCloudDeliveryRegistering {
    var cloudDeliveryAccountID: String? = "account"
    let unavailableReason: String? = nil
    var shouldFail = true
    var registrations = 0
    var rememberedDeviceID: String?

    func rememberRegisteredDevice(id: String) { rememberedDeviceID = id }
    func registerDevice(_ registration: T3ConnectDeviceRegistration) async throws {
        registrations += 1
        if shouldFail { throw RegistrationFailure() }
    }
    func registerLiveActivity(_ registration: T3ConnectLiveActivityRegistration) async throws {}
}

private struct RegistrationFailure: LocalizedError {
    var errorDescription: String? { "Relay unavailable" }
}
