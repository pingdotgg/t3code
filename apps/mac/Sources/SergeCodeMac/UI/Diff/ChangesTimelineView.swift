import SwiftUI

/// Slim inspector timeline: pinned "All Changes" plus checkpoint markers.
/// Selecting a row opens main-area review mode — no code renders here.
public struct ChangesTimelineView: View {
    private let model: AppModel
    private let threadID: String

    @UIState private var pendingRestore: Checkpoint?
    @UIState private var isConfirmingRestore = false
    @UIState private var expandedFileCheckpoints: Set<String> = []
    @UIState private var hoveredCheckpointID: String?

    public init(model: AppModel, threadID: String) {
        self.model = model
        self.threadID = threadID
    }

    private var checkpoints: [Checkpoint] {
        let list = model.threadState(threadID)?.checkpoints ?? []
        // Newest first for the timeline.
        return list.sorted { $0.turnCount > $1.turnCount }
    }

    private var fullDiff: [DiffFile] {
        model.threadState(threadID)?.diff ?? []
    }

    private var isReviewing: Bool {
        model.threadState(threadID)?.isReviewing == true
    }

    private var activeScope: ReviewScope? {
        model.threadState(threadID)?.reviewScope
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    allChangesRow
                    if !checkpoints.isEmpty {
                        timelineSpine
                    }
                }
                .padding(.vertical, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityIdentifier("changes-timeline")
        .task(id: threadID) {
            await model.refreshDiff(threadID: threadID)
            await model.refreshCheckpoints(threadID: threadID)
        }
        .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
            // Legacy harness key: open full-thread review (rail has no collapse).
            guard note.object as? String == "checkpoints" else { return }
            openAllChanges()
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
            Text(
                "This restores the thread to \"\(checkpoint.label)\". Changes made since then will be lost."
            )
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Label("Changes", systemImage: "clock.arrow.circlepath")
                .font(.headline)
                .lineLimit(1)
            if !checkpoints.isEmpty {
                Text("\(checkpoints.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 4)
            Button {
                Task {
                    await model.refreshDiff(threadID: threadID)
                    await model.refreshCheckpoints(threadID: threadID)
                    if model.threadState(threadID)?.isReviewing == true {
                        await model.loadReviewDiff(threadID: threadID)
                    }
                }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.glass)
            .help("Refresh changes")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
        .padding(8)
    }

    // MARK: - All Changes

    private var allChangesRow: some View {
        let counts = DiffPresentation.aggregateCounts(in: fullDiff)
        let selected =
            isReviewing
            && {
                if case .allChanges = activeScope { return true }
                return false
            }()

        return Button {
            openAllChanges()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text("All Changes")
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text("\(fullDiff.count) file\(fullDiff.count == 1 ? "" : "s")")
                            .foregroundStyle(.secondary)
                        if counts.additions > 0 {
                            Text("+\(counts.additions)")
                                .foregroundStyle(.green)
                        }
                        if counts.deletions > 0 {
                            Text("−\(counts.deletions)")
                                .foregroundStyle(.red)
                        }
                    }
                    .font(.caption.monospacedDigit())
                    .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("timeline-all-changes")
    }

    private func openAllChanges() {
        withAnimation(Motion.settle) {
            model.openReview(threadID: threadID, scope: .allChanges)
        }
    }

    // MARK: - Timeline spine

    private var timelineSpine: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(checkpoints.enumerated()), id: \.element.id) { index, checkpoint in
                checkpointMarker(checkpoint, isLast: index == checkpoints.count - 1)
            }
        }
    }

    private func checkpointMarker(_ checkpoint: Checkpoint, isLast: Bool) -> some View {
        let selected = isCheckpointSelected(checkpoint)
        let previousTurn = previousTurnCount(before: checkpoint)

        return HStack(alignment: .top, spacing: 0) {
            // Vertical line + dot
            VStack(spacing: 0) {
                Circle()
                    .fill(selected ? Color.accentColor : Color.secondary.opacity(0.55))
                    .frame(width: 8, height: 8)
                    .padding(.top, 12)
                if !isLast {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.25))
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 20)

            VStack(alignment: .leading, spacing: 4) {
                checkpointHeader(checkpoint, previousTurn: previousTurn)
                checkpointFiles(checkpoint, previousTurn: previousTurn)
            }
            .padding(.trailing, 10)
            .padding(.bottom, 10)
        }
        .background(selected ? Color.accentColor.opacity(0.08) : Color.clear)
        .accessibilityIdentifier("timeline-checkpoint-\(checkpoint.turnCount)")
    }

    private func checkpointHeader(
        _ checkpoint: Checkpoint, previousTurn: Int
    ) -> some View {
        HStack(spacing: 6) {
            Button {
                openCheckpoint(checkpoint, previousTurn: previousTurn, focusPath: nil)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(checkpoint.label)
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        statusBadge(checkpoint.status)
                    }
                    Text(checkpoint.createdAt, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            restoreButton(checkpoint)
                .opacity(hoveredCheckpointID == checkpoint.id ? 1 : 0)
        }
        .padding(.top, 6)
        .onHover { hovering in
            hoveredCheckpointID = hovering ? checkpoint.id : (
                hoveredCheckpointID == checkpoint.id ? nil : hoveredCheckpointID
            )
        }
        .contextMenu {
            Button("Restore…") {
                pendingRestore = checkpoint
                isConfirmingRestore = true
            }
            Button("Review changes") {
                openCheckpoint(checkpoint, previousTurn: previousTurn, focusPath: nil)
            }
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: CheckpointStatus) -> some View {
        switch status {
        case .ready:
            EmptyView()
        case .missing:
            Text("missing")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Color.orange.opacity(0.15), in: Capsule())
                .lineLimit(1)
        case .error:
            Text("error")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.red)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Color.red.opacity(0.15), in: Capsule())
                .lineLimit(1)
        }
    }

    private func restoreButton(_ checkpoint: Checkpoint) -> some View {
        Button {
            pendingRestore = checkpoint
            isConfirmingRestore = true
        } label: {
            Image(systemName: "arrow.uturn.backward")
                .font(.caption)
        }
        .buttonStyle(.borderless)
        .help("Restore checkpoint")
        .opacity(0.7)
    }

    @ViewBuilder
    private func checkpointFiles(_ checkpoint: Checkpoint, previousTurn: Int) -> some View {
        let files = checkpoint.files
        if files.isEmpty {
            EmptyView()
        } else if files.count > 6 && !expandedFileCheckpoints.contains(checkpoint.id) {
            Button {
                withAnimation(Motion.snap) {
                    _ = expandedFileCheckpoints.insert(checkpoint.id)
                }
            } label: {
                Text("\(files.count) files")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .padding(.leading, 2)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(files) { file in
                    Button {
                        openCheckpoint(
                            checkpoint, previousTurn: previousTurn, focusPath: file.path)
                    } label: {
                        fileRow(file)
                    }
                    .buttonStyle(.plain)
                }
                if files.count > 6 {
                    Button {
                        withAnimation(Motion.snap) {
                            _ = expandedFileCheckpoints.remove(checkpoint.id)
                        }
                    } label: {
                        Text("Show less")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func fileRow(_ file: CheckpointFile) -> some View {
        HStack(spacing: 4) {
            Image(systemName: kindGlyph(file.kind))
                .font(.caption2)
                .foregroundStyle(kindColor(file.kind))
                .frame(width: 12)
            Text(file.path)
                .font(.caption.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 2)
            if file.additions > 0 {
                Text("+\(file.additions)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.green)
                    .lineLimit(1)
            }
            if file.deletions > 0 {
                Text("−\(file.deletions)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.red)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }

    private func kindGlyph(_ kind: String) -> String {
        switch kind.lowercased() {
        case "added", "add", "a": return "plus.circle"
        case "deleted", "delete", "d": return "minus.circle"
        case "renamed", "rename", "r": return "arrow.right.circle"
        default: return "pencil.circle"
        }
    }

    private func kindColor(_ kind: String) -> Color {
        switch kind.lowercased() {
        case "added", "add", "a": return .green
        case "deleted", "delete", "d": return .red
        case "renamed", "rename", "r": return .blue
        default: return .orange
        }
    }

    private func isCheckpointSelected(_ checkpoint: Checkpoint) -> Bool {
        guard isReviewing, case .checkpoint(_, let toTurn, _) = activeScope else {
            return false
        }
        return toTurn == checkpoint.turnCount
    }

    /// Previous checkpoint's turnCount (older, lower) — or 0 for the first turn.
    private func previousTurnCount(before checkpoint: Checkpoint) -> Int {
        let older = (model.threadState(threadID)?.checkpoints ?? [])
            .filter { $0.turnCount < checkpoint.turnCount }
            .map(\.turnCount)
        return older.max() ?? 0
    }

    private func openCheckpoint(
        _ checkpoint: Checkpoint, previousTurn: Int, focusPath: String?
    ) {
        withAnimation(Motion.settle) {
            model.openReview(
                threadID: threadID,
                scope: .checkpoint(
                    fromTurn: previousTurn,
                    toTurn: checkpoint.turnCount,
                    label: checkpoint.label
                ),
                focusPath: focusPath
            )
        }
    }
}
