import CryptoKit
import Foundation
import MetricKit
import Observation

struct NativeDiagnosticReport: Codable, Identifiable, Sendable {
    static let maximumReportBytes = 256 * 1024

    let id: String
    let periodStart: Date
    let periodEnd: Date
    let crashCount: Int
    let launchCount: Int
    let json: String?

    init(data: Data, periodStart: Date, periodEnd: Date, crashCount: Int, launchCount: Int) {
        id = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        self.periodStart = periodStart
        self.periodEnd = periodEnd
        self.crashCount = crashCount
        self.launchCount = launchCount
        json = data.count <= Self.maximumReportBytes ? String(data: data, encoding: .utf8) : nil
    }

    var title: String {
        if crashCount > 0, launchCount > 0 { return "Crash and launch report" }
        return crashCount > 0 ? "Crash report" : "Launch report"
    }
}

/// MetricKit delivers these reports during normal execution, sometimes on a later launch.
/// Do not infer crashes from app lifecycle events or install crash handlers here.
@MainActor
@Observable
final class NativeDiagnostics: NSObject, MXMetricManagerSubscriber {
    private struct Archive: Codable {
        let reports: [NativeDiagnosticReport]
        let clearedThrough: Date?
    }

    static let shared = NativeDiagnostics(
        fileURL: URL.applicationSupportDirectory.appending(path: "Diagnostics/reports.json")
    )
    static let maximumReports = 5
    static let maximumStorageBytes = 2 * 1024 * 1024

    private(set) var reports: [NativeDiagnosticReport] = []
    private(set) var storageError: String?
    private let fileURL: URL
    private var started = false
    private var clearedThrough: Date?

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init()
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let file = try FileHandle(forReadingFrom: fileURL)
            defer { try? file.close() }
            let data = try file.read(upToCount: Self.maximumStorageBytes + 1) ?? Data()
            guard data.count <= Self.maximumStorageBytes else {
                storageError = "Saved reports exceed the size limit."
                return
            }
            let archive = try JSONDecoder().decode(Archive.self, from: data)
            reports = Array(archive.reports.prefix(Self.maximumReports))
            clearedThrough = archive.clearedThrough
        } catch {
            storageError = "Could not read saved reports."
        }
    }

    func start() {
        guard !started else { return }
        started = true
        let manager = MXMetricManager.shared
        manager.add(self)
        didReceive(manager.pastDiagnosticPayloads)
    }

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        // Convert on MetricKit's callback queue. Only Sendable values cross to the UI.
        let reports = payloads.compactMap { payload -> NativeDiagnosticReport? in
            let crashes = payload.crashDiagnostics?.count ?? 0
            let launches = payload.appLaunchDiagnostics?.count ?? 0
            guard crashes > 0 || launches > 0 else { return nil }
            return NativeDiagnosticReport(
                data: payload.jsonRepresentation(),
                periodStart: payload.timeStampBegin,
                periodEnd: payload.timeStampEnd,
                crashCount: crashes,
                launchCount: launches
            )
        }
        Task { @MainActor [weak self] in
            self?.receive(reports)
        }
    }

    func receive(_ incoming: [NativeDiagnosticReport]) {
        guard !incoming.isEmpty else { return }
        var byID = Dictionary(reports.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for report in incoming where clearedThrough.map({ report.periodEnd > $0 }) ?? true {
            byID[report.id] = report
        }
        var updatedReports = Array(byID.values.sorted {
            if $0.periodEnd != $1.periodEnd { return $0.periodEnd > $1.periodEnd }
            return $0.id < $1.id
        }.prefix(Self.maximumReports))
        do {
            var data = try JSONEncoder().encode(Archive(reports: updatedReports, clearedThrough: clearedThrough))
            // Encoding JSON as a string escapes it again. Drop older reports to
            // fit the stored byte limit, as well as the report count limit.
            while data.count > Self.maximumStorageBytes, !updatedReports.isEmpty {
                updatedReports.removeLast()
                data = try JSONEncoder().encode(Archive(reports: updatedReports, clearedThrough: clearedThrough))
            }
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            reports = updatedReports
            storageError = nil
        } catch {
            storageError = "Could not save reports."
        }
    }

    func clear(at date: Date = .now) {
        do {
            // MetricKit can redeliver old payloads. Keep one timestamp after deletion
            // so reports for cleared periods do not return on the next launch.
            let cutoff = max(date, reports.map(\.periodEnd).max() ?? date, clearedThrough ?? date)
            let data = try JSONEncoder().encode(Archive(reports: [], clearedThrough: cutoff))
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            reports = []
            clearedThrough = cutoff
            storageError = nil
        } catch {
            storageError = "Could not clear saved reports."
        }
    }
}
