import XCTest
@testable import T3Code

@MainActor
final class CloudWebhookRevocationTests: XCTestCase {
    func testRevokedLinkCannotChangeWebhookPreferencesUntilHostIsRelinked() async {
        let client = RevokedCloudPreferenceClient()
        let model = FeatureCloudWebhookPreferencesModel(environmentID: "paired-host", client: client)
        await model.load()
        XCTAssertEqual(model.state?.linkRevoked, true)
        XCTAssertEqual(model.state?.isLinked, false)
        XCTAssertEqual(model.state?.isManagedTunnelActive, false)
        XCTAssertNil(model.error)

        await model.setEnabled(true)
        XCTAssertTrue(client.writes.isEmpty)
        XCTAssertEqual(model.state?.holdWebhooksWhileOffline, false)

        client.linkRevoked = false
        await model.load()
        XCTAssertEqual(model.state?.isLinked, true)
        await model.setEnabled(true)
        XCTAssertEqual(client.writes, [true])
        XCTAssertEqual(model.state?.holdWebhooksWhileOffline, true)
        XCTAssertEqual(client.environmentIDs, ["paired-host", "paired-host", "paired-host"])
        XCTAssertNil(model.error)
        XCTAssertFalse(model.saving)
    }

    func testUnlinkedHostCannotChangeSavedWebhookPreference() async {
        let client = RevokedCloudPreferenceClient()
        client.linked = false
        client.linkRevoked = nil
        let model = FeatureCloudWebhookPreferencesModel(environmentID: "unlinked", client: client)
        await model.load()
        await model.setEnabled(true)
        XCTAssertTrue(client.writes.isEmpty)
        XCTAssertFalse(model.saving)
    }
}

@MainActor
private final class RevokedCloudPreferenceClient: FeatureCloudPreferencesManaging {
    var linked = true
    var linkRevoked: Bool? = true
    var hold = false
    var writes: [Bool] = []
    var environmentIDs: [String] = []

    func cloudLinkState(environmentID: String) async throws -> EnvironmentCloudLinkState {
        environmentIDs.append(environmentID)
        return state
    }

    func setHoldWebhooksWhileOffline(environmentID: String, enabled: Bool) async throws -> EnvironmentCloudLinkState {
        environmentIDs.append(environmentID)
        writes.append(enabled)
        hold = enabled
        return state
    }

    private var state: EnvironmentCloudLinkState {
        .init(linked: linked, cloudUserId: nil, relayUrl: nil, relayIssuer: nil,
              managedTunnelActive: true, publishAgentActivity: true,
              holdWebhooksWhileOffline: hold, linkRevoked: linkRevoked)
    }
}
