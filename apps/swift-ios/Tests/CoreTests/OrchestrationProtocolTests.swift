import XCTest
@testable import T3Code

final class OrchestrationProtocolTests: XCTestCase {
    func testOldSavedEnvironmentDefaultsToAuto() throws {
        let environment = try JSONDecoder.t3.decode(Environment.self, from: Data("""
        {
          "id": "old-server",
          "label": "Studio",
          "httpBaseURL": "https://studio.example",
          "webSocketBaseURL": "wss://studio.example/ws"
        }
        """.utf8))

        XCTAssertEqual(environment.orchestrationProtocolPreference, .auto)
        XCTAssertEqual(environment.kind, .bearer)
        XCTAssertTrue(environment.isEnabled)
    }

    func testMissingDescriptorVersionUsesV1() throws {
        let descriptor = try descriptor()
        XCTAssertNil(descriptor.orchestrationProtocolVersion)
        XCTAssertEqual(try OrchestrationProtocolSelection(descriptor: descriptor).version, .v1)
        XCTAssertEqual(
            try OrchestrationProtocolSelection(descriptor: descriptor, preference: .v1).version,
            .v1
        )
    }

    func testAutoAndMatchingPreferencesUseAdvertisedVersion() throws {
        for (rawVersion, preference, expected) in [
            (1, OrchestrationProtocolPreference.v1, OrchestrationProtocolVersion.v1),
            (2, .v2, .v2),
        ] {
            let descriptor = try descriptor(version: rawVersion)
            XCTAssertEqual(try OrchestrationProtocolSelection(descriptor: descriptor).version, expected)
            XCTAssertEqual(
                try OrchestrationProtocolSelection(descriptor: descriptor, preference: preference).version,
                expected
            )
        }
    }

    func testUnknownVersionBlocksEveryPreference() throws {
        for rawVersion in [-1, 0, 3, 100] {
            let descriptor = try descriptor(version: rawVersion)
            // Keep the advertised value so Settings can show the incompatible version.
            XCTAssertEqual(descriptor.orchestrationProtocolVersion, rawVersion)
            for preference in OrchestrationProtocolPreference.allCases {
                XCTAssertThrowsError(try OrchestrationProtocolSelection(
                    descriptor: descriptor,
                    preference: preference,
                    previousVersion: .v1
                )) { error in
                    XCTAssertEqual(
                        error as? OrchestrationProtocolError,
                        .unsupportedServerVersion(rawVersion)
                    )
                    XCTAssertTrue(error.localizedDescription.contains("V\(rawVersion)"))
                }
            }
        }
    }

    func testMalformedDescriptorVersionCannotBecomeV1() {
        for version in ["null", "\"2\"", "2.5", "true"] {
            XCTAssertThrowsError(try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: Data("""
            {
              "environmentId": "server",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "orchestrationProtocolVersion": \(version),
              "capabilities": {}
            }
            """.utf8)))
        }
    }

    func testForcedPreferenceRejectsBothMismatchDirections() throws {
        for (rawVersion, preference, expectedVersion) in [
            (1, OrchestrationProtocolPreference.v2, OrchestrationProtocolVersion.v1),
            (2, .v1, .v2),
        ] {
            XCTAssertThrowsError(try OrchestrationProtocolSelection(
                descriptor: descriptor(version: rawVersion),
                preference: preference
            )) { error in
                XCTAssertEqual(
                    error as? OrchestrationProtocolError,
                    .preferenceMismatch(preference: preference, serverVersion: expectedVersion)
                )
                XCTAssertTrue(error.localizedDescription.contains("Select Auto"))
            }
        }
        XCTAssertThrowsError(try OrchestrationProtocolSelection(
            descriptor: descriptor(),
            preference: .v2
        ))
    }

    func testFreshDescriptorControlsReconnectAndStateInvalidation() throws {
        let v1 = try descriptor()
        let v2 = try descriptor(version: 2)
        let initial = try OrchestrationProtocolSelection(descriptor: v1)
        XCTAssertEqual(initial.version, .v1)
        XCTAssertFalse(initial.requiresStateReset)

        let upgraded = try OrchestrationProtocolSelection(descriptor: v2, previousVersion: initial.version)
        XCTAssertEqual(upgraded.version, .v2)
        XCTAssertTrue(upgraded.requiresStateReset)

        let reconnect = try OrchestrationProtocolSelection(descriptor: v2, previousVersion: upgraded.version)
        XCTAssertEqual(reconnect.version, .v2)
        XCTAssertFalse(reconnect.requiresStateReset)

        let reverted = try OrchestrationProtocolSelection(descriptor: v1, previousVersion: reconnect.version)
        XCTAssertEqual(reverted.version, .v1)
        XCTAssertTrue(reverted.requiresStateReset)
    }

    func testPreferenceIsSavedPerEnvironmentAndSurvivesStoreReload() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-protocol-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("environments.json")
        let store = EnvironmentStore(fileURL: fileURL)
        let first = Environment(
            id: "first",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example/ws")!,
            descriptor: try descriptor(version: 2),
            isEnabled: false
        )
        let second = Environment(
            id: "second",
            label: "Laptop",
            httpBaseURL: URL(string: "https://laptop.example")!,
            webSocketBaseURL: URL(string: "wss://laptop.example/ws")!
        )
        try await store.save([first, second])
        try await store.setActiveEnvironment(id: second.id)

        for preference in OrchestrationProtocolPreference.allCases {
            try await store.setOrchestrationProtocolPreference(id: first.id, preference: preference)
            let reloadedStore = EnvironmentStore(fileURL: fileURL)
            let reloaded = try await reloadedStore.load()
            var expected = first
            expected.orchestrationProtocolPreference = preference
            XCTAssertEqual(reloaded, [expected, second])
            let activeID = try await reloadedStore.activeEnvironmentID()
            XCTAssertEqual(activeID, second.id)
        }
    }

    private func descriptor(version: Int? = nil) throws -> EnvironmentDescriptor {
        var fields: [String: JSONValue] = [
            "environmentId": .string("server"),
            "label": .string("Studio"),
            "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
            "serverVersion": .string("1.0.0"),
            "capabilities": .object([:]),
        ]
        if let version {
            fields["orchestrationProtocolVersion"] = .number(Double(version))
        }
        return try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: JSONEncoder.t3.encode(fields))
    }
}
