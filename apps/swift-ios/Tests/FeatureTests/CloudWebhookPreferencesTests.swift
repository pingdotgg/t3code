import XCTest
@testable import T3Code

@MainActor
final class CloudWebhookPreferencesTests: XCTestCase {
    func testFailedSaveKeepsServerValueAndSuccessfulRetryUsesSameEnvironment() async {
        let client = CloudPreferenceFeatureClient()
        let model = FeatureCloudWebhookPreferencesModel(environmentID: "remote", client: client)
        await model.load()
        XCTAssertEqual(model.state?.holdWebhooksWhileOffline, false)
        client.failWrite = true
        await model.setEnabled(true)
        XCTAssertEqual(model.state?.holdWebhooksWhileOffline, false)
        XCTAssertNotNil(model.error)
        XCTAssertFalse(model.saving)
        client.failWrite = false
        await model.setEnabled(true)
        XCTAssertEqual(model.state?.holdWebhooksWhileOffline, true)
        XCTAssertNil(model.error)
        XCTAssertEqual(client.environmentIDs, ["remote", "remote", "remote"])
    }

    func testUnsupportedFieldDoesNotExposeMutation() async {
        let client = CloudPreferenceFeatureClient()
        client.hold = nil
        let model = FeatureCloudWebhookPreferencesModel(environmentID: "old", client: client)
        await model.load()
        XCTAssertNil(model.state?.holdWebhooksWhileOffline)
        await model.setEnabled(true)
        XCTAssertEqual(client.environmentIDs, ["old"])
    }
}

@MainActor
private final class CloudPreferenceFeatureClient: FeatureCloudPreferencesManaging {
    var environmentIDs: [String] = []
    var hold: Bool? = false
    var failWrite = false

    func cloudLinkState(environmentID: String) async throws -> EnvironmentCloudLinkState {
        environmentIDs.append(environmentID)
        return state
    }

    func setHoldWebhooksWhileOffline(environmentID: String, enabled: Bool) async throws -> EnvironmentCloudLinkState {
        environmentIDs.append(environmentID)
        if failWrite { throw RPCError.disconnected }
        hold = enabled
        return state
    }

    private var state: EnvironmentCloudLinkState {
        .init(linked: true, cloudUserId: nil, relayUrl: nil, relayIssuer: nil,
              managedTunnelActive: true, publishAgentActivity: true, holdWebhooksWhileOffline: hold)
    }
}
