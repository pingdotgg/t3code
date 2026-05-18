import SwiftUI

struct MobileDiagnosticsView: View {
    let snapshot: MobileDiagnosticsSnapshot

    var body: some View {
        NavigationStack {
            List {
                Section("State") {
                    LabeledContent("Connection", value: snapshot.connectionState)
                    LabeledContent("Thread detail", value: snapshot.threadDetailState)
                    LabeledContent("Selected thread", value: snapshot.selectedThreadID ?? "None")
                    LabeledContent("Shell sequence", value: String(snapshot.shellSnapshotSequence))
                    LabeledContent(
                        "Thread sequence",
                        value: snapshot.selectedThreadSnapshotSequence.map(String.init) ?? "None"
                    )
                }

                Section("Counts") {
                    LabeledContent("Environments", value: String(snapshot.environmentCount))
                    LabeledContent("Projects", value: String(snapshot.projectCount))
                    LabeledContent("Threads", value: String(snapshot.threadCount))
                    LabeledContent("Pending responses", value: String(snapshot.pendingResponseCount))
                    LabeledContent("Responded requests", value: String(snapshot.respondedRequestCount))
                }

                Section("Recent events") {
                    if snapshot.recentEvents.isEmpty {
                        Text("No diagnostic events yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(snapshot.recentEvents) { event in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.message)
                                    .font(.body)
                                Text("\(event.createdAt) · \(event.level.rawValue)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }

                Section("Export") {
                    Text(snapshot.exportText)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityLabel("Diagnostics export text")
                }
            }
            .navigationTitle("Diagnostics")
        }
    }
}

#Preview {
    MobileDiagnosticsView(
        snapshot: MobileDiagnosticsSnapshot(
            connectionState: "Connected",
            threadDetailState: "Connected",
            environmentCount: 1,
            projectCount: 1,
            threadCount: 1,
            selectedThreadID: "thread-fixture",
            shellSnapshotSequence: 5,
            selectedThreadSnapshotSequence: 7,
            pendingResponseCount: 0,
            respondedRequestCount: 1,
            isSendingMessage: false,
            isInterrupting: false,
            recentEvents: [
                MobileDiagnosticsEntry(level: .info, message: "Loaded initial shell."),
            ]
        )
    )
}
