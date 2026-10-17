import Foundation
import XCTest
@testable import T3Code

final class StorageMaintenanceContractTests: XCTestCase {
    func testCompactionNoticeUsesTheContractThresholdAndVacuumFlag() throws {
        for (reclaimable, incremental, expected) in [
            (1_073_741_823.0, false, false), (1_073_741_824.0, false, true),
            (1_073_741_825.0, true, false),
        ] {
            let status = try JSONValue.object([
                "databaseBytes": .number(2_147_483_648), "reclaimableBytes": .number(reclaimable),
                "incrementalVacuumEnabled": .bool(incremental), "compactCommand": .string("t3 doctor"),
            ]).decode(DatabaseStorageStatus.self)
            XCTAssertEqual(status.shouldRecommendCompaction, expected)
        }
    }

    func testReportsDecodeOlderOptionalAccountingAndPreserveFailedEntries() throws {
        let report = try JSONValue.object([
            "trigger": .string("manual"), "startedAt": .string("2026-10-16T12:00:00.000Z"),
            "finishedAt": .string("2026-10-16T12:01:00.000Z"),
            "entries": .array([.object([
                "kind": .string("worktree"), "outcome": .string("failed"),
                "reason": .string("Permission denied"), "path": .string("/work/tree"),
                "threadId": .null, "threadTitle": .null,
            ])]),
            "counts": .object(["removed": .number(0), "kept": .number(0), "failed": .number(1)]),
            "omittedCount": .number(3),
        ]).decode(StorageCleanupReport.self)
        XCTAssertEqual(report.bytesFreed, 0)
        XCTAssertEqual(report.omittedCount, 3)
        XCTAssertNil(report.entries.first?.bytes)
        XCTAssertNil(report.entries.first?.files)
        XCTAssertEqual(report.entries.first?.outcome, .failed)
        XCTAssertEqual(report.entries.first?.reason, "Permission denied")
        XCTAssertEqual(try JSONValue.encode(report).decode(StorageCleanupReport.self), report)
    }

    func testRulesIncludeProjectCustomAndImmediateSettledRetention() throws {
        var settings = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertFalse(settings.hasEnabledStorageCleanupRules)
        settings.storageCleanup = ["worktreeSettledAfterDays": .number(0)]
        XCTAssertTrue(settings.hasEnabledStorageCleanupRules)
        settings.worktreeCleanup = .object(["mode": .string("off")])
        XCTAssertFalse(settings.hasEnabledStorageCleanupRules)
        settings.worktreeCleanup = .object(["mode": .string("custom"), "rules": .object([:])])
        XCTAssertFalse(settings.hasEnabledStorageCleanupRules)
        settings.projectSettingsOverrides = ["project": ["worktreeCleanup": .object([
            "mode": .string("custom"), "rules": .object(["worktreeOnMerge": .bool(true)]),
        ])]]
        XCTAssertTrue(settings.hasEnabledStorageCleanupRules)
        settings.projectSettingsOverrides = [:]
        settings.storageCleanup?["logsAfterDays"] = .number(8)
        XCTAssertTrue(settings.hasEnabledStorageCleanupRules)
    }
}
