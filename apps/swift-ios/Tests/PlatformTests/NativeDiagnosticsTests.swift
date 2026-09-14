import Foundation
import Testing
@testable import T3Code

@MainActor
struct NativeDiagnosticsTests {
    @Test func retainsNewestReportsAndDeduplicatesRedelivery() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "reports.json")
        let diagnostics = NativeDiagnostics(fileURL: file)
        let reports = (0..<7).map { index in
            report(json: "{\"index\":\(index)}", date: Double(index))
        }
        diagnostics.receive(reports)
        diagnostics.receive([reports[6]])
        let restored = NativeDiagnostics(fileURL: file)
        #expect(restored.reports.count == 5)
        #expect(restored.reports.first?.id == reports[6].id)
        #expect(restored.reports.last?.id == reports[2].id)
        #expect(restored.reports.first?.json == reports[6].json)
        #expect(try Data(contentsOf: file).count < NativeDiagnostics.maximumStorageBytes)
    }

    @Test func oversizedReportKeepsMetadataWithoutTruncatingJSON() {
        let data = Data(repeating: 32, count: NativeDiagnosticReport.maximumReportBytes + 1)
        let report = NativeDiagnosticReport(
            data: data, periodStart: .distantPast, periodEnd: .distantFuture,
            crashCount: 1, launchCount: 0
        )
        #expect(report.json == nil)
        #expect(report.crashCount == 1)
        #expect(report.periodEnd == .distantFuture)
    }

    @Test func clearSurvivesRestartAndRedeliveryWithoutDiscardingNewReports() {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "reports.json")
        let diagnostics = NativeDiagnostics(fileURL: file)
        let oldReport = report(json: "{\"old\":true}", date: 1)
        diagnostics.receive([oldReport])
        diagnostics.clear(at: Date(timeIntervalSince1970: 1))
        #expect(diagnostics.reports.isEmpty)
        let restored = NativeDiagnostics(fileURL: file)
        #expect(restored.reports.isEmpty)
        restored.receive([oldReport])
        #expect(restored.reports.isEmpty)
        let newReport = report(json: "{\"new\":true}", date: 2)
        restored.receive([oldReport, newReport])
        #expect(restored.reports.map(\.id) == [newReport.id])
    }

    @Test func rejectsOversizedSavedData() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "reports.json")
        try Data(repeating: 0, count: NativeDiagnostics.maximumStorageBytes + 1).write(to: file)
        let diagnostics = NativeDiagnostics(fileURL: file)
        #expect(diagnostics.reports.isEmpty)
        #expect(diagnostics.storageError != nil)
    }

    private func report(json: String, date: TimeInterval) -> NativeDiagnosticReport {
        NativeDiagnosticReport(
            data: Data(json.utf8), periodStart: Date(timeIntervalSince1970: date),
            periodEnd: Date(timeIntervalSince1970: date), crashCount: 1, launchCount: 0
        )
    }
}
