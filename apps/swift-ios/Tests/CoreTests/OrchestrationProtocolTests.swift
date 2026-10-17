import XCTest
@testable import T3Code

final class OrchestrationProtocolTests: XCTestCase {
    func testOnlyV2DescriptorsAreAccepted() throws {
        XCTAssertEqual(try OrchestrationProtocolSelection(descriptor: descriptor(version: 2)).version, .v2)
        for version in [nil, -1, 0, 1, 3, 100] as [Int?] {
            XCTAssertThrowsError(try OrchestrationProtocolSelection(descriptor: descriptor(version: version))) { error in
                let expected: OrchestrationProtocolError = (version ?? 0) < 2
                    ? .hostUpdateRequired : .unsupportedServerVersion(version!)
                XCTAssertEqual(error as? OrchestrationProtocolError, expected)
            }
        }
    }

    func testMalformedDescriptorVersionIsRejected() {
        for version in ["null", "\"2\"", "2.5", "true"] {
            XCTAssertThrowsError(try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: Data("""
            {
              "environmentId": "server", "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0", "orchestrationProtocolVersion": \(version), "capabilities": {}
            }
            """.utf8)))
        }
    }

    private func descriptor(version: Int?) throws -> EnvironmentDescriptor {
        var fields: [String: JSONValue] = [
            "environmentId": .string("server"), "label": .string("Studio"),
            "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
            "serverVersion": .string("1.0.0"), "capabilities": .object([:]),
        ]
        if let version { fields["orchestrationProtocolVersion"] = .number(Double(version)) }
        return try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: JSONEncoder.t3.encode(fields))
    }
}
