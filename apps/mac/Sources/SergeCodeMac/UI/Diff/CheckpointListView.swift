import SwiftUI

// Checkpoint list for a thread: restore any prior checkpoint after a
// confirmation dialog. Content stays opaque; only the header bar is glass.

public struct CheckpointListView: View {
    private let model: AppModel
    private let threadID: String

    @UIState private var pendingRestore: Checkpoint?
    @UIState private var isConfirmingRestore = false

    public init(model: AppModel, threadID: String) {
        self.model = model
        self.threadID = threadID
    }

    private var checkpoints: [Checkpoint] {
        model.threadState(threadID)?.checkpoints ?? []
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if checkpoints.isEmpty {
                emptyState
                    .transition(Motion.paneSwap)
            } else {
                list
                    .transition(Motion.paneSwap)
            }
        }
        .animation(Motion.settle, value: checkpoints.isEmpty)
        .task(id: threadID) {
            await model.refreshCheckpoints(threadID: threadID)
        }
        .confirmationDialog(
            "Restore Checkpoint?",
            isPresented: $isConfirmingRestore,
            presenting: pendingRestore
        ) { checkpoint in
            Button("Restore", role: .destructive) {
                Task { await model.restoreCheckpoint(checkpoint) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { checkpoint in
            Text("This restores the thread to \"\(checkpoint.label)\". Changes made since then will be lost.")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Label("Checkpoints", systemImage: "clock.arrow.circlepath")
                .font(.headline)
            if !checkpoints.isEmpty {
                Text("\(checkpoints.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .transition(.opacity)
            }
            Spacer()
            Button {
                Task { await model.refreshCheckpoints(threadID: threadID) }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.glass)
            .help("Refresh checkpoints")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
        .padding(8)
    }

    // MARK: - List

    private var list: some View {
        List(checkpoints) { checkpoint in
            row(checkpoint)
                .transition(Motion.rise)
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .animation(Motion.settle, value: checkpoints.map(\.id))
    }

    private func row(_ checkpoint: Checkpoint) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(checkpoint.label)
                    .font(.body)
                Text(checkpoint.createdAt, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Restore") {
                pendingRestore = checkpoint
                isConfirmingRestore = true
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ContentUnavailableView(
            "No Checkpoints",
            systemImage: "clock.arrow.circlepath",
            description: Text("Checkpoints created during this thread will appear here.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
