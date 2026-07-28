import Testing

@testable import SergeCodeMac

@Suite("New session target policy")
struct NewSessionTargetPolicyTests {
    @Test("the local Mac remains an explicit valid target")
    func localTarget() {
        #expect(NewSessionTargetPolicy.permitsCreation(on: .local, connection: nil))
    }

    @Test("a remote must exist and be ready")
    func remoteTarget() {
        let remote = DeviceID(rawValue: "build-mac")

        #expect(!NewSessionTargetPolicy.permitsCreation(on: remote, connection: nil))
        #expect(
            !NewSessionTargetPolicy.permitsCreation(
                on: remote, connection: .reconnecting(attempt: 2)))
        #expect(NewSessionTargetPolicy.permitsCreation(on: remote, connection: .ready))
    }
}
