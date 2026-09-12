import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeShellProjectionTests: XCTestCase {
    func testOneChangedThreadMapsOnlyOneOfOneThousandRows() throws {
        var projection = NativeShellRowProjection<OrchestrationThreadShell, String>()
        var sources = (0..<1_000).map { thread(id: "thread-\($0)") }
        var mappedCount = 0
        let map: (OrchestrationThreadShell) -> String = {
            mappedCount += 1
            return $0.title
        }
        _ = projection.map(sources, transform: map)
        XCTAssertEqual(mappedCount, 1_000)

        // An HTTP refresh has a new allocation but equal records.
        let refreshed = try JSONDecoder.t3.decode(
            [OrchestrationThreadShell].self,
            from: JSONEncoder.t3.encode(sources)
        )
        _ = projection.map(refreshed, transform: map)
        XCTAssertEqual(mappedCount, 1_000)

        sources[500] = thread(id: "thread-500", title: "New title")
        let rows = projection.map(sources, transform: map)
        XCTAssertEqual(mappedCount, 1_001)
        XCTAssertEqual(rows.count, 1_000)
        XCTAssertEqual(rows[500], "New title")
        XCTAssertEqual(rows[499], "Original title")
    }

    func testReorderRemovalAndInsertionKeepRowsMatchedToTheirSource() {
        var projection = NativeShellRowProjection<OrchestrationThreadShell, String>()
        let first = thread(id: "first", title: "First")
        let second = thread(id: "second", title: "Second")
        let third = thread(id: "third", title: "Third")
        var mappedCount = 0
        let map: (OrchestrationThreadShell) -> String = {
            mappedCount += 1
            return $0.title
        }
        XCTAssertEqual(projection.map([first, second, third], transform: map), ["First", "Second", "Third"])
        XCTAssertEqual(projection.map([third, first], transform: map), ["Third", "First"])
        XCTAssertEqual(mappedCount, 3)

        let added = thread(id: "added", title: "Added")
        XCTAssertEqual(projection.map([added, third, first], transform: map), ["Added", "Third", "First"])
        XCTAssertEqual(mappedCount, 4)
        XCTAssertEqual(projection.map([], transform: map), [])
        XCTAssertEqual(projection.map([first], transform: map), ["First"])
        XCTAssertEqual(mappedCount, 5, "Removed rows must not remain retained in the cache.")
    }

    func testSettlementAndBackgroundWorkChangesDoNotNeedANewUpdatedAt() {
        var projection = NativeShellRowProjection<OrchestrationThreadShell, String>()
        let initial = thread(id: "first")
        let settled = multiEnvironmentShell(
            projectID: "project", threadID: "first", title: initial.title,
            backgroundLiveness: .monitoring,
            settledOverride: "settled", settledAt: "2026-07-31T12:01:00.000Z"
        ).threads[0]
        XCTAssertEqual(initial.updatedAt, settled.updatedAt)
        var mappedCount = 0
        let map: (OrchestrationThreadShell) -> String = {
            mappedCount += 1
            return "\($0.settledOverride ?? "active"):\($0.backgroundLiveness?.rawValue ?? "idle")"
        }
        XCTAssertEqual(projection.map([initial], transform: map), ["active:idle"])
        XCTAssertEqual(projection.map([settled], transform: map), ["settled:monitoring"])
        XCTAssertEqual(mappedCount, 2)
    }

    func testEnvironmentAndProviderNamesInvalidateOnlyTheirEnvironment() {
        var one = NativeShellProjection()
        var two = NativeShellProjection()
        var firstEnvironment = environment(id: "one")
        let otherEnvironment = environment(id: "two")
        let source = [thread(id: "shared-wire-id")]
        var names = ["codex": "Codex work"]
        var mappedCount = 0
        let map: (OrchestrationThreadShell) -> FeatureThread = {
            mappedCount += 1
            return FeatureThread(
                id: $0.id, projectID: $0.projectId,
                environmentName: firstEnvironment.label, title: $0.title,
                providerName: names[$0.modelSelection.instanceId]
            )
        }
        _ = one.mapThreads(source, environment: firstEnvironment, providerNames: names, transform: map)
        _ = two.mapThreads(source, environment: otherEnvironment, providerNames: names, transform: map)
        XCTAssertEqual(mappedCount, 2)

        names["codex"] = "Codex personal"
        let renamedProvider = one.mapThreads(source, environment: firstEnvironment, providerNames: names, transform: map)
        XCTAssertEqual(renamedProvider[0].providerName, "Codex personal")
        XCTAssertEqual(mappedCount, 3)

        firstEnvironment.label = "Renamed computer"
        let renamedEnvironment = one.mapThreads(source, environment: firstEnvironment, providerNames: names, transform: map)
        XCTAssertEqual(renamedEnvironment[0].environmentName, "Renamed computer")
        XCTAssertEqual(mappedCount, 4)

        _ = two.mapThreads(source, environment: otherEnvironment, providerNames: ["codex": "Codex work"], transform: map)
        XCTAssertEqual(mappedCount, 4, "Another environment's unchanged rows must stay cached.")
    }

    private func thread(id: String, title: String = "Original title") -> OrchestrationThreadShell {
        multiEnvironmentShell(projectID: "project", threadID: id, title: title).threads[0]
    }

    private func environment(id: String) -> Environment {
        Environment(
            id: id, label: "Computer \(id)",
            httpBaseURL: URL(string: "https://\(id).example")!,
            webSocketBaseURL: URL(string: "wss://\(id).example")!
        )
    }
}
