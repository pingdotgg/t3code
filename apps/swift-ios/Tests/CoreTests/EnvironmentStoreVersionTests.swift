import Foundation
import Testing
@testable import T3Code

@Suite("Environment store format compatibility")
struct EnvironmentStoreVersionTests {
    @Test(arguments: [0, 2])
    func unsupportedFormatIsNotCachedOrOverwritten(_ version: Int) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-environment-format-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("environments.json")
        let original = try JSONSerialization.data(withJSONObject: [
            "version": version,
            "environments": [],
            "unrecognizedState": "preserve this",
        ])
        try original.write(to: file)
        let store = EnvironmentStore(fileURL: file)

        await #expect(throws: CocoaError.self) { try await store.load() }
        await #expect(throws: CocoaError.self) { try await store.setActiveEnvironment(id: nil) }
        #expect(try Data(contentsOf: file) == original)

        let supported = Data(#"{"version":1,"environments":[]}"#.utf8)
        try supported.write(to: file, options: .atomic)
        #expect(try await store.load().isEmpty)
        try await store.setActiveEnvironment(id: nil)
        #expect(try await store.activeEnvironmentID() == nil)
    }
}
