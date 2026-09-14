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
    static let shared = NativeDiagnostics(
        fileURL: URL.applicationSupportDirectory.appending(path: "Diagnostics/reports.json")
    )
    static let maximumReports = 5
    static let maximumStorageBytes = 2 * 1024 * 1024

    private(set) var reports: [NativeDiagnosticReport] = []
    private(set) var storageError: String?
    private let fileURL: URL
    private var started = false

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
            reports = Array(try JSONDecoder().decode([NativeDiagnosticReport].self, from: data)
                .prefix(Self.maximumReports))
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
        for report in incoming { byID[report.id] = report }
        reports = Array(byID.values.sorted {
            if $0.periodEnd != $1.periodEnd { return $0.periodEnd > $1.periodEnd }
            return $0.id < $1.id
        }.prefix(Self.maximumReports))
        do {
            let data = try JSONEncoder().encode(reports)
            guard data.count <= Self.maximumStorageBytes else {
                storageError = "Reports exceed the size limit."
                return
            }
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            storageError = nil
        } catch {
            storageError = "Could not save reports."
        }
    }

    func clear() {
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
            reports = []
            storageError = nil
        } catch {
            storageError = "Could not clear saved reports."
        }
    }
}
