import SwiftUI

@MainActor
struct FeatureClientStorageView: View {
    let storage: any FeatureClientStorageManaging
    @State private var summary: FeatureClientStorageSummary?
    @State private var isBusy = false
    @State private var errorMessage: String?
    @State private var pendingClear: ClearTarget?
    @State private var failedClear: ClearTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Previously loaded lists and history are available offline. Older, unloaded history is not saved.")
                    .font(T3Typography.supporting)
                Text("Clearing removes saved copies and icons. Drafts, queued messages, connections, and server history stay intact. Online use can save new copies.")
                    .font(T3Typography.supporting)

                if isBusy {
                    Text("Updating storage…")
                        .font(T3Typography.supporting)
                        .accessibilityIdentifier("client-storage-busy")
                }

                if let errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(errorMessage)
                            .font(T3Typography.supporting)
                            .textSelection(.enabled)
                        Button(failedClear == nil ? "Retry" : "Retry clear") {
                            if let failedClear {
                                pendingClear = failedClear
                            } else {
                                Task { await refresh() }
                            }
                        }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .disabled(isBusy)
                        .accessibilityIdentifier("client-storage-retry")
                    }
                }

                if let summary {
                    LabeledContent("Total saved", value: ByteCountFormatter.string(
                        fromByteCount: summary.totalBytes, countStyle: .file
                    ))
                    .font(T3Typography.control)

                    if summary.environments.isEmpty {
                        Text("No saved history or icons on this device.")
                            .font(T3Typography.supporting)
                    }
                    ForEach(summary.environments) { environment in
                        Divider().overlay(.white.opacity(0.15))
                        environmentRow(environment)
                    }
                    if !summary.environments.isEmpty {
                        Divider().overlay(.white.opacity(0.15))
                        Button("Clear all saved copies", role: .destructive) {
                            pendingClear = .all
                        }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .disabled(isBusy)
                        .accessibilityIdentifier("client-storage-clear-all")
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(.white)
        .tint(.white)
        .background(.black)
        .environment(\.colorScheme, .dark)
        .navigationTitle("Client Storage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.black, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh") { Task { await refresh() } }
                    .disabled(isBusy)
                    .accessibilityIdentifier("client-storage-refresh")
            }
        }
        .task { await refresh() }
        .confirmationDialog(
            pendingClear?.title ?? "Clear saved copies?",
            isPresented: Binding(
                get: { pendingClear != nil },
                set: { if !$0 { pendingClear = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingClear
        ) { target in
            Button("Clear saved copies", role: .destructive) {
                Task { await clear(target) }
            }
            Button("Cancel", role: .cancel) { }
        } message: { _ in
            Text("Remove saved lists, history, and icons from this device? Drafts, queued messages, connections, and server history stay intact.")
        }
    }

    private func environmentRow(_ environment: FeatureEnvironmentStorageSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(environment.label)
                .font(T3Typography.control)
            Text(ByteCountFormatter.string(fromByteCount: environment.totalBytes, countStyle: .file))
                .font(T3Typography.supporting)
            Text("Saved lists: \(environment.shellCount) · Thread histories: \(environment.threadCount) · Icons: \(environment.faviconCount)")
                .font(T3Typography.supporting)
            Button("Clear saved copies", role: .destructive) {
                pendingClear = .environment(environment)
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .disabled(isBusy)
            .accessibilityLabel("Clear saved copies for \(environment.label)")
            .accessibilityIdentifier("client-storage-clear-\(environment.environmentID)")
        }
    }

    private func refresh() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        failedClear = nil
        defer { isBusy = false }
        do {
            summary = try await storage.clientStorageSummary()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = "Couldn't read client storage: \(error.localizedDescription)"
        }
    }

    private func clear(_ target: ClearTarget) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        failedClear = nil
        // A failed clear can still remove some files. Do not retain stale counts.
        summary = nil
        defer { isBusy = false }
        do {
            try await storage.clearClientStorage(environmentID: target.environmentID)
        } catch {
            errorMessage = "Couldn't clear saved copies: \(error.localizedDescription)"
            failedClear = target
            return
        }
        // Once clearing succeeds, retry only the summary read if it fails.
        do {
            summary = try await storage.clientStorageSummary()
        } catch {
            errorMessage = "Saved copies cleared. Couldn't refresh storage: \(error.localizedDescription)"
        }
    }

    private enum ClearTarget {
        case all
        case environment(FeatureEnvironmentStorageSummary)

        var environmentID: String? {
            switch self {
            case .all: nil
            case .environment(let environment): environment.environmentID
            }
        }

        var title: String {
            switch self {
            case .all: "Clear saved copies for all environments?"
            case .environment(let environment): "Clear saved copies for \(environment.label)?"
            }
        }
    }
}
