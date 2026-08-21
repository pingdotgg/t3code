import Foundation
import XCTest
@testable import T3Code

final class WireFixtureContractTests: XCTestCase {
    func testGeneratedContractFixturesDecodeInSwift() throws {
        let shell = try decodeFixture(
            "shell-snapshot",
            as: OrchestrationShellSnapshot.self
        )
        XCTAssertEqual(shell.snapshotSequence, 42)
        XCTAssertEqual(shell.projects.map(\.id), ["project-fixture"])
        XCTAssertEqual(shell.threads.map(\.id), ["thread-fixture"])
        XCTAssertEqual(shell.threads.first?.modelSelection.instanceId, "codex")

        let detail = try decodeFixture(
            "thread-detail-snapshot",
            as: OrchestrationThreadDetailSnapshot.self
        )
        XCTAssertEqual(detail.thread.messages.map(\.id), ["message-fixture"])
        XCTAssertEqual(detail.page?.beforeCursor, "fixture-cursor")
        XCTAssertEqual(detail.page?.threadSequence, 40)

        let shellItem = try decodeFixture(
            "shell-stream-snapshot",
            as: ShellStreamItem.self
        )
        guard case let .snapshot(streamShell) = shellItem else {
            return XCTFail("Expected a shell snapshot stream item")
        }
        XCTAssertEqual(streamShell.snapshotSequence, shell.snapshotSequence)

        let threadItem = try decodeFixture(
            "thread-stream-snapshot",
            as: ThreadStreamItem.self
        )
        guard case let .snapshot(streamDetail) = threadItem else {
            return XCTFail("Expected a thread snapshot stream item")
        }
        XCTAssertEqual(streamDetail.thread.id, detail.thread.id)
    }

    func testSnapshotsDropOnlyUnknownArrayElements() throws {
        let known = try fixtureObject("shell-snapshot")
        var payload = try XCTUnwrap(known as? [String: Any])
        payload["projects"] = [
            ["id": "future-project", "kind": "not-yet-supported"],
            try XCTUnwrap((payload["projects"] as? [Any])?.first),
        ]
        payload["threads"] = [
            ["id": "future-thread", "runtimeMode": "future-mode"],
            try XCTUnwrap((payload["threads"] as? [Any])?.first),
        ]

        let snapshot = try JSONDecoder.t3.decode(
            OrchestrationShellSnapshot.self,
            from: JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        )

        XCTAssertEqual(snapshot.projects.map(\.id), ["project-fixture"])
        XCTAssertEqual(snapshot.threads.map(\.id), ["thread-fixture"])
    }

    func testUnknownStreamItemsRequestRefreshWithoutEndingDecoding() throws {
        let shell = try JSONDecoder.t3.decode(
            ShellStreamItem.self,
            from: Data(#"{"kind":"future-shell-delta","sequence":43}"#.utf8)
        )
        guard case .refreshRequired = shell else {
            return XCTFail("Expected an authoritative shell refresh")
        }

        let malformedKnownShell = try JSONDecoder.t3.decode(
            ShellStreamItem.self,
            from: Data(#"{"kind":"thread-upserted","sequence":43,"thread":{"id":"future"}}"#.utf8)
        )
        guard case .refreshRequired = malformedKnownShell else {
            return XCTFail("Expected malformed known deltas to refresh")
        }

        let thread = try JSONDecoder.t3.decode(
            ThreadStreamItem.self,
            from: Data(#"{"kind":"future-thread-delta","sequence":43}"#.utf8)
        )
        guard case let .event(event) = thread else {
            return XCTFail("Expected the detail reducer compatibility path")
        }
        XCTAssertEqual(event, .null)
    }

    private func decodeFixture<Value: Decodable>(
        _ name: String,
        as type: Value.Type
    ) throws -> Value {
        try JSONDecoder.t3.decode(type, from: fixtureData(name))
    }

    private func fixtureObject(_ name: String) throws -> Any {
        try JSONSerialization.jsonObject(with: fixtureData(name))
    }

    private func fixtureData(_ name: String) throws -> Data {
        let testsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(
            contentsOf: testsDirectory
                .appendingPathComponent("Fixtures/Wire/\(name).json")
        )
    }
}
