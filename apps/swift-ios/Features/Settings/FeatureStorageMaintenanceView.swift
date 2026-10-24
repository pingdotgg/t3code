import Observation
import SwiftUI
import UIKit

@MainActor
protocol FeatureStorageMaintenance: AnyObject {
    func storageMaintenanceAvailability(environmentID: String) async throws -> FeatureStorageMaintenanceAvailability
    func getDatabaseStorage(environmentID: String) async throws -> AsyncThrowingStream<DatabaseStorageStatus?, Error>
    func getStorageCleanupReport(environmentID: String) async throws -> AsyncThrowingStream<StorageCleanupReport?, Error>
    func runStorageCleanup(environmentID: String) async throws -> StorageCleanupReport
}

struct FeatureStorageMaintenanceAvailability: Equatable, Sendable {
    let databaseStorage: Bool
    let storageCleanupRun: Bool
    let canRead: Bool
    let canRun: Bool
    let hasRules: Bool
}

enum FeatureStorageMaintenanceError: LocalizedError {
    case cleanupInProgress

    var errorDescription: String? { "Storage cleanup is already running on this environment." }
}

@MainActor
@Observable
final class FeatureStorageMaintenanceModel {
    let environmentID: String
    private let client: any FeatureStorageMaintenance
    private var generation = FeatureAsyncGeneration()
    private(set) var availability: FeatureStorageMaintenanceAvailability?
    private(set) var database: DatabaseStorageStatus?
    private(set) var report: StorageCleanupReport?
    private(set) var availabilityError: String?
    private(set) var databaseError: String?
    private(set) var reportError: String?
    private(set) var runError: String?
    private(set) var running = false
    private(set) var reportLoaded = false

    init(environmentID: String, client: any FeatureStorageMaintenance) {
        self.environmentID = environmentID
        self.client = client
    }

    var canRun: Bool {
        availability?.storageCleanupRun == true && availability?.canRun == true
            && availability?.hasRules == true && !running
    }

    func observe() async {
        let revision = generation.begin()
        availability = nil
        database = nil
        report = nil
        reportLoaded = false
        availabilityError = nil
        databaseError = nil
        reportError = nil
        do {
            let value = try await client.storageMaintenanceAvailability(environmentID: environmentID)
            try Task.checkCancellation()
            guard generation.accepts(revision) else { return }
            availability = value
            guard value.canRead else { return }
            async let database: Void = observeDatabase(revision: revision, supported: value.databaseStorage)
            async let report: Void = observeReport(revision: revision, supported: value.storageCleanupRun)
            _ = await (database, report)
        } catch {
            if !Task.isCancelled, generation.accepts(revision) { availabilityError = error.localizedDescription }
        }
    }

    func run() async {
        guard canRun else { return }
        running = true
        runError = nil
        defer { running = false }
        do {
            let result = try await client.runStorageCleanup(environmentID: environmentID)
            receiveReport(result)
        } catch {
            if !Task.isCancelled { runError = error.localizedDescription }
        }
    }

    private func observeDatabase(revision: UInt64, supported: Bool) async {
        guard supported else { return }
        do {
            for try await value in try await client.getDatabaseStorage(environmentID: environmentID) {
                try Task.checkCancellation()
                guard generation.accepts(revision) else { return }
                database = value
                databaseError = nil
            }
        } catch {
            if !Task.isCancelled, generation.accepts(revision) { databaseError = error.localizedDescription }
        }
    }

    private func observeReport(revision: UInt64, supported: Bool) async {
        guard supported else { return }
        do {
            for try await value in try await client.getStorageCleanupReport(environmentID: environmentID) {
                try Task.checkCancellation()
                guard generation.accepts(revision) else { return }
                if let value { receiveReport(value) }
                reportLoaded = true
                reportError = nil
            }
        } catch {
            if !Task.isCancelled, generation.accepts(revision) { reportError = error.localizedDescription }
        }
    }

    private func receiveReport(_ value: StorageCleanupReport) {
        // A queued initial stream value must not replace the result of a newer manual run.
        if let report, let current = NativeTimestampParser.parse(report.finishedAt),
           let incoming = NativeTimestampParser.parse(value.finishedAt), incoming < current { return }
        report = value
        reportLoaded = true
        reportError = nil
    }
}

/// Mount inside the destination environment's Form, outside a settings-write disabled group.
@MainActor
struct FeatureStorageMaintenanceView: View {
    @Bindable var model: FeatureRootModel
    let environmentID: String
    var settings: ServerSettingsSnapshot? = nil

    var body: some View {
        if let storage = model.client as? any FeatureStorageMaintenance {
            FeatureStorageMaintenanceSections(
                storage: storage, environmentID: environmentID,
                environmentLabel: model.snapshot.environments.first { $0.id == environmentID }?.name ?? "this environment",
                settings: settings,
                permissions: model.snapshot.environments.first { $0.id == environmentID }?.permissions
            )
            .id(environmentID)
        }
    }
}

@MainActor
private struct FeatureStorageMaintenanceSections: View {
    let environmentLabel: String
    let settings: ServerSettingsSnapshot?
    let permissions: EnvironmentPermissionState?
    @State private var model: FeatureStorageMaintenanceModel
    @State private var refreshID = 0
    @AppStorage private var databaseNoticeDismissed: Bool

    init(storage: any FeatureStorageMaintenance, environmentID: String, environmentLabel: String,
         settings: ServerSettingsSnapshot?, permissions: EnvironmentPermissionState?) {
        self.environmentLabel = environmentLabel
        self.settings = settings
        self.permissions = permissions
        _model = State(initialValue: .init(environmentID: environmentID, client: storage))
        _databaseNoticeDismissed = AppStorage(wrappedValue: false, "database-storage-notice-dismissed:\(environmentID)")
    }

    var body: some View {
        Group {
            if let availability = model.availability {
                if !availability.databaseStorage && !availability.storageCleanupRun {
                    Section { Text("Update this environment to use storage maintenance.") }
                } else if !availability.canRead {
                    Section { Text("This connection needs the orchestration:read permission to read storage status.") }
                } else {
                    databaseNotice
                    if availability.storageCleanupRun { cleanupSection(availability) }
                }
                if let error = model.databaseError {
                    Section("Database storage") { errorRow(error) }
                }
            } else {
                Section("Storage maintenance") {
                    if let error = model.availabilityError { errorRow(error) }
                    else { Text("Loading storage status…").foregroundStyle(.secondary) }
                }
            }
        }
        .listRowBackground(Color.black)
        .task(id: refreshID) { await model.observe() }
        .onChange(of: settings) { _, _ in if !model.running { refreshID += 1 } }
        .onChange(of: permissions) { _, _ in if !model.running { refreshID += 1 } }
    }

    @ViewBuilder
    private var databaseNotice: some View {
        if !databaseNoticeDismissed, let database = model.database, database.shouldRecommendCompaction {
            Section("Database") {
                Text("Reclaim \((database.reclaimableBytes / 1_073_741_824).formatted(.number.precision(.fractionLength(1)))) GiB on \(environmentLabel)")
                Text("Old history is cleaned up automatically, but this database still holds the freed space. Run this command on \(environmentLabel) to return it to disk. It pauses and restarts the background service. Quit the desktop app first if it hosts this environment.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text(database.compactCommand).font(.footnote.monospaced()).textSelection(.enabled)
                Button("Copy command") { UIPasteboard.general.string = database.compactCommand }
                    .accessibilityIdentifier("storage-database-copy")
                Button("Dismiss") { databaseNoticeDismissed = true }
                    .accessibilityIdentifier("storage-database-dismiss")
            }
        }
    }

    private func cleanupSection(_ availability: FeatureStorageMaintenanceAvailability) -> some View {
        Section("Storage cleanup") {
            Button(model.running ? "Deleting…" : "Delete now", role: .destructive) {
                Task { await model.run() }
            }
            .disabled(!model.canRun)
            .accessibilityIdentifier("storage-cleanup-run")
            if !availability.canRun {
                Text("This connection needs the settings:write permission to run cleanup.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if !availability.hasRules {
                Text("Turn on a cleanup rule to use this.").font(.footnote).foregroundStyle(.secondary)
            }
            if let error = model.runError { Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled) }
            if let error = model.reportError { errorRow(error) }
            if let report = model.report {
                Text("\(bytes(report.bytesFreed)) recovered. \(report.counts.removed.formatted()) removed, \(report.counts.kept.formatted()) kept, \(report.counts.failed.formatted()) failed.")
                    .font(.footnote)
                if let finished = NativeTimestampParser.parse(report.finishedAt) {
                    Text("Last run \(finished.formatted(date: .abbreviated, time: .shortened))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                DisclosureGroup("Last run") {
                    ForEach(Array(report.entries.enumerated()), id: \.offset) { _, entry in
                        reportRow(entry)
                    }
                    if report.omittedCount > 0 { Text("\(report.omittedCount.formatted()) more results.") }
                    if report.entries.isEmpty && report.omittedCount == 0 { Text("Nothing needed cleanup.") }
                }
            } else if model.reportError == nil {
                Text(model.reportLoaded ? "Cleanup hasn't run yet." : "Loading last run…")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Button("Refresh storage status") { refreshID += 1 }
                .disabled(model.running)
                .accessibilityIdentifier("storage-maintenance-refresh")
        }
    }

    private func reportRow(_ entry: StorageCleanupReportEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entryName(entry))
            if let title = entry.threadTitle, title != entryName(entry) { Text(title).font(.footnote) }
            Text("\(entry.outcome.rawValue.capitalized): \(entry.reason)")
                .font(.footnote).foregroundStyle(entry.outcome == .failed ? .red : .secondary)
            if entry.outcome == .removed || (entry.outcome == .kept && entry.bytes != nil) {
                HStack {
                    if entry.kind != .worktree, let files = entry.files {
                        Text("\(files.formatted()) \(files == 1 ? "file" : "files")")
                    }
                    if let size = entry.bytes { Text(bytes(size)) }
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }

    private func errorRow(_ error: String) -> some View {
        Group {
            Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
            Button("Retry") { refreshID += 1 }.disabled(model.running)
        }
    }

    private func entryName(_ entry: StorageCleanupReportEntry) -> String {
        switch entry.kind {
        case .logs: "Rotated logs"
        case .browserArtifacts: "Browser artifacts"
        case .worktree:
            if entry.threadId == nil { entry.path ?? "Worktrees" }
            else { entry.path?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "Worktrees" }
        }
    }

    private func bytes(_ value: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
    }
}
