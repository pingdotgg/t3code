import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Live Activity setup transaction")
struct PlatformLiveActivitySetupTests {
    @Test
    func disablingContinuesAfterFailuresWithoutRestoringEnabledPreferences() async {
        var calls: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a", "b", "c"], enabled: false, previousEnabled: true,
                validateAccount: {},
                updateDevice: { value in
                    calls.append("device:\(value)")
                    throw SetupTestError.failed
                },
                linkEnvironment: { id, value in
                    calls.append("\(id):\(value)")
                    if id == "b" { throw SetupTestError.failed }
                }
            )
            Issue.record("Disable hid remote failures")
        } catch {
            let failure = error as? PlatformLiveActivitySetupError
            #expect(failure?.rollbackFailures.isEmpty == true)
            #expect(failure?.operation.contains("device:") == true)
            #expect(failure?.operation.contains("b:") == true)
        }
        #expect(calls == ["device:false", "a:false", "b:false", "c:false"])
    }

    @Test
    func disablingStopsWritesAfterAccountChanges() async {
        var currentAccount = "original"
        var calls: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a", "b"], enabled: false, previousEnabled: true,
                validateAccount: {
                    guard currentAccount == "original" else { throw SetupTestError.accountChanged }
                },
                updateDevice: { value in calls.append("device:\(value)") },
                linkEnvironment: { id, value in
                    calls.append("\(id):\(value)")
                    currentAccount = "new-account"
                }
            )
            Issue.record("Disable accepted an account change")
        } catch {}
        #expect(calls == ["device:false", "a:false"])
    }

    @Test
    func failedHostRestoresDeviceAndEveryAttemptedHost() async {
        var calls: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a", "b", "c"], enabled: true, previousEnabled: false,
                validateAccount: {},
                updateDevice: { value in calls.append("device:\(value)") },
                linkEnvironment: { id, value in
                    calls.append("\(id):\(value)")
                    if id == "b", value { throw SetupTestError.failed }
                }
            )
            Issue.record("Setup accepted a failed host")
        } catch {
            #expect((error as? PlatformLiveActivitySetupError)?.rollbackFailures.isEmpty == true)
        }
        #expect(calls == ["device:true", "a:true", "b:true", "device:false", "b:false", "a:false"])
    }

    @Test
    func deviceFailureDoesNotStartLinkingHosts() async {
        var calls: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a"], enabled: true, previousEnabled: false,
                validateAccount: {},
                updateDevice: { value in
                    calls.append("device:\(value)")
                    if value { throw SetupTestError.failed }
                },
                linkEnvironment: { id, _ in calls.append(id) }
            )
            Issue.record("Setup accepted a failed device registration")
        } catch {}
        #expect(calls == ["device:true", "device:false"])
    }

    @Test
    func accountChangeStopsForwardAndCompensatingWrites() async {
        var currentAccount = "original"
        var calls: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a", "b"], enabled: true, previousEnabled: false,
                validateAccount: {
                    guard currentAccount == "original" else { throw SetupTestError.accountChanged }
                },
                updateDevice: { value in calls.append("device:\(value)") },
                linkEnvironment: { id, value in
                    calls.append("\(id):\(value)")
                    currentAccount = "new-account"
                }
            )
            Issue.record("Setup continued after account change")
        } catch {
            #expect((error as? PlatformLiveActivitySetupError)?.rollbackFailures.count == 2)
        }
        #expect(calls == ["device:true", "a:true"])
    }

    @Test
    func rollbackFailureDoesNotPreventOtherHostsFromBeingRestored() async {
        var restored: [String] = []
        do {
            try await PlatformLiveActivitySetupTransaction.run(
                environmentIDs: ["a", "b"], enabled: true, previousEnabled: false,
                validateAccount: {}, updateDevice: { _ in },
                linkEnvironment: { id, value in
                    if id == "b" { throw SetupTestError.failed }
                    if !value { restored.append(id) }
                }
            )
            Issue.record("Setup accepted a failed host")
        } catch {
            let failure = error as? PlatformLiveActivitySetupError
            #expect(failure?.rollbackFailures.count == 1)
            #expect(failure?.errorDescription?.contains("restore") == true)
        }
        #expect(restored == ["a"])
    }
}

private enum SetupTestError: Error { case failed, accountChanged }
