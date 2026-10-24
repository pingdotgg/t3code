import Foundation
import XCTest
@testable import T3Code

@MainActor
final class FeatureStorageMaintenanceTests: XCTestCase {
    func testReadOnlyConnectionReceivesBothStreamsWithoutRunningCleanup() async throws {
        let client = StorageMaintenanceFeatureStub()
        client.availability = .init(databaseStorage: true, storageCleanupRun: true,
                                    canRead: true, canRun: false, hasRules: true)
        let model = FeatureStorageMaintenanceModel(environmentID: "remote", client: client)
        await model.observe()
        XCTAssertEqual(model.database?.compactCommand, "t3 doctor --home-dir /srv/t3")
        XCTAssertEqual(model.report?.counts.failed, 1)
        XCTAssertEqual(Set(client.readTargets), ["database:remote", "report:remote"])
        await model.run()
        XCTAssertTrue(client.runTargets.isEmpty)
    }

    func testUnsupportedAndDeniedReadsDoNotSubscribe() async {
        for availability in [
            FeatureStorageMaintenanceAvailability(databaseStorage: false, storageCleanupRun: false,
                                                  canRead: true, canRun: true, hasRules: true),
            FeatureStorageMaintenanceAvailability(databaseStorage: true, storageCleanupRun: true,
                                                  canRead: false, canRun: false, hasRules: true),
        ] {
            let client = StorageMaintenanceFeatureStub()
            client.availability = availability
            await FeatureStorageMaintenanceModel(environmentID: "remote", client: client).observe()
            XCTAssertTrue(client.readTargets.isEmpty)
        }
    }

    func testDatabaseFailureDoesNotHideReportAndRunPreservesFailedItems() async throws {
        let client = StorageMaintenanceFeatureStub()
        client.failDatabase = true
        let model = FeatureStorageMaintenanceModel(environmentID: "remote", client: client)
        await model.observe()
        XCTAssertNotNil(model.databaseError)
        XCTAssertNotNil(model.report)
        await model.run()
        XCTAssertEqual(client.runTargets, ["remote"])
        XCTAssertEqual(model.report?.entries.first?.reason, "Local changes")
        XCTAssertNil(model.runError)
        XCTAssertFalse(model.running)
    }

    func testCleanupRequiresConfiguredRulesAndFailedRunCanBeRetriedExplicitly() async {
        let client = StorageMaintenanceFeatureStub()
        client.availability = .init(databaseStorage: true, storageCleanupRun: true,
                                    canRead: true, canRun: true, hasRules: false)
        let model = FeatureStorageMaintenanceModel(environmentID: "remote", client: client)
        await model.observe()
        await model.run()
        XCTAssertTrue(client.runTargets.isEmpty)
        client.availability = .init(databaseStorage: true, storageCleanupRun: true,
                                    canRead: true, canRun: true, hasRules: true)
        await model.observe()
        client.failRun = true
        await model.run()
        XCTAssertNotNil(model.runError)
        XCTAssertFalse(model.running)
        XCTAssertEqual(client.runTargets, ["remote"])
        client.failRun = false
        await model.run()
        XCTAssertNil(model.runError)
        XCTAssertEqual(client.runTargets, ["remote", "remote"])
    }
}

@MainActor
private final class StorageMaintenanceFeatureStub: FeatureStorageMaintenance {
    var availability = FeatureStorageMaintenanceAvailability(databaseStorage: true, storageCleanupRun: true,
        canRead: true, canRun: true, hasRules: true)
    var readTargets: [String] = []
    var runTargets: [String] = []
    var failDatabase = false
    var failRun = false

    func storageMaintenanceAvailability(environmentID: String) async throws -> FeatureStorageMaintenanceAvailability {
        availability
    }

    func getDatabaseStorage(environmentID: String) async throws -> AsyncThrowingStream<DatabaseStorageStatus?, Error> {
        readTargets.append("database:\(environmentID)")
        if failDatabase { throw RPCError.disconnected }
        return AsyncThrowingStream {
            $0.yield(DatabaseStorageStatus(databaseBytes: 3_000_000_000, reclaimableBytes: 2_000_000_000,
                incrementalVacuumEnabled: false, compactCommand: "t3 doctor --home-dir /srv/t3"))
            $0.finish()
        }
    }

    func getStorageCleanupReport(environmentID: String) async throws -> AsyncThrowingStream<StorageCleanupReport?, Error> {
        readTargets.append("report:\(environmentID)")
        let report = Self.report
        return AsyncThrowingStream { $0.yield(nil); $0.yield(report); $0.finish() }
    }

    func runStorageCleanup(environmentID: String) async throws -> StorageCleanupReport {
        runTargets.append(environmentID)
        if failRun { throw RPCError.remote("Cleanup failed") }
        return Self.report
    }

    static var report: StorageCleanupReport {
        .init(trigger: .manual, startedAt: "2026-10-16T12:00:00.000Z", finishedAt: "2026-10-16T12:01:00.000Z",
              entries: [.init(kind: .worktree, outcome: .failed, reason: "Local changes", path: "/work/tree",
                              threadId: "thread", threadTitle: "Keep work", bytes: nil, files: nil)],
              counts: .init(removed: 0, kept: 0, failed: 1), omittedCount: 0, bytesFreed: 0)
    }
}
