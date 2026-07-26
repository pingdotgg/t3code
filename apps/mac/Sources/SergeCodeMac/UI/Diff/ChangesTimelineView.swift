import SwiftUI

/// Unified agent activity inspector: one continuous feed of what the agent
/// is doing right now, what changed in the working tree, and the checkpoint
/// history — no mode switcher. Live rows reuse the chat's tool-activity
/// visual language (`ActivityIconChip`, shimmer, pulse) so the panel reads
/// as the same stream as the timeline. Selecting a file or checkpoint opens
/// main-area review mode.
public struct ChangesTimelineView: View {
    /// Scroll targets for the probe harness and deep links.
    private enum FeedAnchor: String {
        case now, changes, history
    }

    private let model: AppModel
    private let threadID: String

    @UIState private var pendingRestore: Checkpoint?
    @UIState private var isConfirmingRestore = false
    @UIState private var expandedFileCheckpoints: Set<String> = []
    @UIState private var isHoveringAllChanges = false
    @UIState private var hoveredCheckpointID: String?
    @UIState private var hoveredFilePath: String?
    @UIState private var changesCollapsed = false
    @UIState private var changesFilesExpanded = false
    @UIState private var historyCollapsed = false

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

    private var isRunning: Bool {
        model.threads.first { $0.id == threadID }?.status == .running
    }

    /// The turn currently in flight, segmented out of the timeline (see
    /// `TurnActivityProjection` for the turn rule). One forward pass, same
    /// order of work as the per-checkpoint `toolCounts` mapping the History
    /// section already runs on every body pass.
    private var currentTurn: TurnActivity {
        TurnActivityProjection.currentTurn(
            timeline: model.threadState(threadID)?.timeline ?? [],
            checkpoints: model.threadState(threadID)?.checkpoints ?? []
        )
    }

    private var showsNow: Bool {
        // Trust the thread status only: an interrupted turn (cancel, session
        // restart, cut stream) can leave a trailing tool event stuck at
        // `.running`, which would pin the live card at the top forever.
        isRunning
    }

    private var isEmpty: Bool {
        fullDiff.isEmpty && checkpoints.isEmpty && !showsNow
    }

    public var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                header
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if showsNow {
                            currentTurnSection
                                .id(FeedAnchor.now)
                                .transition(Motion.materialize)
                        }
                        if isEmpty {
                            emptyState
                        } else {
                            if !fullDiff.isEmpty {
                                changesSection
                                    .id(FeedAnchor.changes)
                            }
                            if !checkpoints.isEmpty {
                                historySection
                                    .id(FeedAnchor.history)
                            }
                        }
                    }
                    .padding(.vertical, 12)
                    .animation(Motion.structure, value: showsNow)
                    .animation(Motion.structure, value: isEmpty)
                    .entranceWindow(resetOn: threadID)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .accessibilityIdentifier("changes-timeline")
            .task(id: threadID) {
                await model.refreshDiff(threadID: threadID)
                await model.refreshCheckpoints(threadID: threadID)
            }
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                guard let key = note.object as? String else { return }
                // Legacy harness key: open full-thread review.
                if key == "checkpoints" {
                    DispatchQueue.main.async { openAllChanges() }
                    return
                }
                #if DEBUG
                    // The unified feed has no tabs; the legacy keys scroll to
                    // their section instead of switching a segment.
                    if key == "activity" {
                        DispatchQueue.main.async {
                            withAnimation(Motion.structure) {
                                proxy.scrollTo(FeedAnchor.history, anchor: .top)
                            }
                        }
                    } else if key == "files" {
                        DispatchQueue.main.async {
                            withAnimation(Motion.structure) {
                                proxy.scrollTo(FeedAnchor.changes, anchor: .top)
                            }
                        }
                    }
                #endif
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
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Label("Activity", systemImage: "waveform.path.ecg")
                .font(.headline)
                .lineLimit(1)
            if isRunning {
                HStack(spacing: 5) {
                    Circle()
                        .fill(AlpineTheme.accent)
                        .frame(width: 6, height: 6)
                        .pulseGlow(isActive: true)
                    Text("Working")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .transition(.opacity)
            }
            Spacer(minLength: 4)
            if !fullDiff.isEmpty {
                let totals = DiffPresentation.aggregateCounts(in: fullDiff)
                changeCounts(additions: totals.additions, deletions: totals.deletions)
            }
            refreshButton
        }
        .padding(.horizontal, 12)
        // Floor height shared with the chat identity header so the dividers
        // under both headers line up; a floor (not a fixed height) so the
        // header can grow instead of clipping if its content ever exceeds
        // the band (see AlpineTheme.contentHeaderHeight).
        .frame(minHeight: AlpineTheme.contentHeaderHeight)
        .animation(Motion.ambient, value: isRunning)
    }

    /// Quiet inspector-surface refresh control: flat hover wash, no glass.
    private var refreshButton: some View {
        ChangesQuietIconButton(
            systemImage: "arrow.clockwise",
            help: "Refresh changes and activity"
        ) {
            Task {
                await model.refreshDiff(threadID: threadID)
                await model.refreshCheckpoints(threadID: threadID)
                if model.threadState(threadID)?.isReviewing == true {
                    await model.loadReviewDiff(threadID: threadID)
                }
            }
        }
    }

    // MARK: - Current turn

    /// Cap on visible tool rows so a long agent loop can't blow up the
    /// panel; older events fold into a "… N earlier" line.
    private static let visibleEventLimit = 6

    /// Live card for the turn in flight: which turn it is, what kicked it
    /// off, how long it's been running, and this turn's tool calls in
    /// chronological order (latest at the bottom, matching how the chat
    /// reads). The shimmer border marks the card as live; settled rows stay
    /// still.
    private var currentTurnSection: some View {
        let turn = currentTurn
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                sectionLabel("Now · Turn \(turn.turnNumber)")
                Spacer(minLength: 4)
                if let startedAt = turn.startedAt {
                    Text(startedAt, style: .timer)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                if let prompt = turn.prompt, !prompt.isEmpty {
                    Text(prompt)
                        .font(SurgeTypography.technicalMetadata)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                }
                turnStatsRow(turn)
                if turn.events.isEmpty {
                    nowRow(
                        chipStyle: ToolActivityStyle(
                            symbolName: "sparkles", tint: AlpineTheme.accent),
                        title: "Working",
                        detail: nil,
                        status: .running
                    )
                } else {
                    let hiddenCount = max(0, turn.events.count - Self.visibleEventLimit)
                    if hiddenCount > 0 {
                        Text("… \(hiddenCount) earlier tool call\(hiddenCount == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                    }
                    ForEach(turn.events.suffix(Self.visibleEventLimit)) { event in
                        nowRow(
                            chipStyle: event.kind.activityStyle,
                            title: event.name,
                            detail: event.detail.isEmpty ? nil : event.detail,
                            status: event.status
                        )
                    }
                }
            }
            .padding(6)
            .background(
                Color.primary.opacity(0.045),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
            .shimmerBorder(
                color: AlpineTheme.accent, isActive: isRunning,
                cornerRadius: AlpineTheme.Corners.card)
        }
        .padding(.horizontal, 12)
    }

    /// Compact "12 tools · 3 files · 1 failed" summary for the live turn.
    private func turnStatsRow(_ turn: TurnActivity) -> some View {
        HStack(spacing: 6) {
            Text("\(turn.toolCount) tool\(turn.toolCount == 1 ? "" : "s")")
            if !turn.filesTouched.isEmpty {
                Text("·")
                Text("\(turn.filesTouched.count) file\(turn.filesTouched.count == 1 ? "" : "s")")
            }
            if turn.failedCount > 0 {
                Text("·")
                Text("\(turn.failedCount) failed")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }

    private func nowRow(
        chipStyle: ToolActivityStyle, title: String, detail: String?, status: ToolEventStatus
    ) -> some View {
        HStack(spacing: 10) {
            ActivityIconChip(style: chipStyle, size: 24)
                .pulseGlow(isActive: status == .running)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(SurgeTypography.toolTitle)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 6)
            switch status {
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            case .succeeded:
                Image(systemName: "checkmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            case .running:
                EmptyView()
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Changes

    private var changesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader(
                "Changed Files",
                count: fullDiff.count,
                isCollapsed: $changesCollapsed
            )
            .padding(.horizontal, 12)

            if !changesCollapsed {
                // Bound the eager inner VStack: the outer LazyVStack only
                // defers this section as one unit, so an uncapped list would
                // materialize every row of a large working tree at once.
                let visibleFiles =
                    changesFilesExpanded ? fullDiff : Array(fullDiff.prefix(12))
                VStack(alignment: .leading, spacing: 2) {
                    allChangesRow
                    ForEach(Array(visibleFiles.enumerated()), id: \.element.id) { index, file in
                        Button {
                            withAnimation(Motion.structure) {
                                model.openReview(
                                    threadID: threadID, scope: .allChanges, focusPath: file.path)
                            }
                        } label: {
                            changedFileRow(file)
                        }
                        .buttonStyle(.plain)
                        .entrance(.row, index: index)
                    }
                    if fullDiff.count > 12 {
                        Button {
                            withAnimation(Motion.structure) {
                                changesFilesExpanded.toggle()
                            }
                        } label: {
                            Text(
                                changesFilesExpanded
                                    ? "Show less" : "Show \(fullDiff.count - 12) more"
                            )
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 12)
                    }
                }
                .transition(Motion.unfold)
            }
        }
    }

    /// Card-style entry into the full working-tree review.
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
            HStack(spacing: 10) {
                ActivityIconChip(
                    style: ToolActivityStyle(
                        symbolName: "arrow.left.arrow.right", tint: AlpineTheme.accent),
                    size: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Review All Changes")
                        .font(SurgeTypography.toolTitle)
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
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selected
                    ? AlpineTheme.accent.opacity(0.12)
                    : Color.primary.opacity(isHoveringAllChanges ? 0.05 : 0),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .onHover { isHoveringAllChanges = $0 }
        .animation(Motion.feedback, value: isHoveringAllChanges)
        .animation(Motion.feedback, value: selected)
        .accessibilityIdentifier("timeline-all-changes")
    }

    private func changedFileRow(_ file: DiffFile) -> some View {
        let counts = DiffPresentation.aggregateCounts(in: [file])
        let hovered = hoveredFilePath == file.path
        return HStack(spacing: 10) {
            ActivityIconChip(style: fileStatusStyle(file.status), size: 20)
                .accessibilityLabel(fileStatusLabel(file.status))
            Text(file.path)
                .font(SurgeTypography.technicalMetadata)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            changeCounts(additions: counts.additions, deletions: counts.deletions)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            Color.primary.opacity(hovered ? 0.05 : 0),
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.compact, style: .continuous))
        .contentShape(Rectangle())
        .padding(.horizontal, 4)
        .onHover { hovering in
            hoveredFilePath = hovering ? file.path : (hoveredFilePath == file.path ? nil : hoveredFilePath)
        }
        .animation(Motion.feedback, value: hovered)
    }

    private func changeCounts(additions: Int, deletions: Int) -> some View {
        HStack(spacing: 5) {
            if additions > 0 {
                Text("+\(additions)").foregroundStyle(.green)
            }
            if deletions > 0 {
                Text("−\(deletions)").foregroundStyle(.red)
            }
        }
        .font(.caption2.monospacedDigit())
    }

    private func fileStatusStyle(_ status: DiffFileStatus) -> ToolActivityStyle {
        switch status {
        case .added: ToolActivityStyle(symbolName: "plus", tint: AlpineTheme.meadow)
        case .modified: ToolActivityStyle(symbolName: "pencil", tint: AlpineTheme.sky)
        case .deleted: ToolActivityStyle(symbolName: "minus", tint: AlpineTheme.clay)
        case .renamed: ToolActivityStyle(symbolName: "arrow.right", tint: AlpineTheme.lavender)
        }
    }

    private func fileStatusLabel(_ status: DiffFileStatus) -> String {
        switch status {
        case .added: "Added"
        case .modified: "Modified"
        case .deleted: "Deleted"
        case .renamed: "Renamed"
        }
    }

    private func openAllChanges() {
        withAnimation(Motion.structure) {
            model.openReview(threadID: threadID, scope: .allChanges)
        }
    }

    // MARK: - History

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader(
                "History",
                count: checkpoints.count,
                isCollapsed: $historyCollapsed
            )
            .padding(.horizontal, 12)

            if !historyCollapsed {
                timelineSpine
                    .transition(Motion.unfold)
            }
        }
    }

    private var timelineSpine: some View {
        let toolCounts = CheckpointMapping.toolCounts(
            timeline: model.threadState(threadID)?.timeline ?? [],
            checkpoints: model.threadState(threadID)?.checkpoints ?? []
        )
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(checkpoints.enumerated()), id: \.element.id) { index, checkpoint in
                checkpointMarker(
                    checkpoint,
                    isLast: index == checkpoints.count - 1,
                    toolCount: toolCounts[checkpoint.id]
                )
                .entrance(.row, index: index)
            }
        }
    }

    private func checkpointMarker(
        _ checkpoint: Checkpoint, isLast: Bool, toolCount: Int?
    ) -> some View {
        let selected = isCheckpointSelected(checkpoint)
        let previousTurn = previousTurnCount(before: checkpoint)

        return HStack(alignment: .top, spacing: 0) {
            // Vertical line + dot
            VStack(spacing: 0) {
                Circle()
                    .fill(selected ? AlpineTheme.accent : Color.secondary.opacity(0.55))
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
                checkpointFiles(checkpoint, previousTurn: previousTurn, toolCount: toolCount)
            }
            .padding(.trailing, 10)
            .padding(.bottom, 10)
        }
        .background(
            selected ? AlpineTheme.accent.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        .accessibilityIdentifier("timeline-checkpoint-\(checkpoint.turnCount)")
    }

    private func checkpointHeader(
        _ checkpoint: Checkpoint, previousTurn: Int
    ) -> some View {
        let hovered = hoveredCheckpointID == checkpoint.id
        return HStack(spacing: 6) {
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
                .opacity(hovered ? 1 : 0)
                // Zero-opacity views still take hits and stay in the AX tree;
                // keep the invisible destructive control out of both. The
                // context menu still offers Restore for keyboard/VO users.
                .allowsHitTesting(hovered)
                .accessibilityHidden(!hovered)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(
            Color.primary.opacity(hovered ? 0.05 : 0),
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.compact, style: .continuous))
        .onHover { hovering in
            hoveredCheckpointID = hovering ? checkpoint.id : (
                hoveredCheckpointID == checkpoint.id ? nil : hoveredCheckpointID
            )
        }
        // Fades the restore button and hover wash in rather than flicking.
        .animation(Motion.feedback, value: hovered)
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
    private func checkpointFiles(
        _ checkpoint: Checkpoint, previousTurn: Int, toolCount: Int?
    ) -> some View {
        let files = checkpoint.files
        if files.isEmpty {
            if let n = toolCount, n >= 1 {
                Text("Ran \(n) tool\(n == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 8)
            } else {
                EmptyView()
            }
        } else {
            let expanded = expandedFileCheckpoints.contains(checkpoint.id)
            let visibleFiles = expanded ? files : Array(files.prefix(6))
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(visibleFiles.enumerated()), id: \.element.id) { index, file in
                    Button {
                        openCheckpoint(
                            checkpoint, previousTurn: previousTurn, focusPath: file.path)
                    } label: {
                        checkpointFileRow(file)
                    }
                    .buttonStyle(.plain)
                    .entrance(.row, index: index)
                }
                if files.count > 6 {
                    Button {
                        withAnimation(Motion.structure) {
                            // `_ =`: keep the Set.insert/remove results out
                            // of `withAnimation`'s generic Result inference
                            // (see SidebarView's expandedProjects toggle).
                            if expanded {
                                _ = expandedFileCheckpoints.remove(checkpoint.id)
                            } else {
                                _ = expandedFileCheckpoints.insert(checkpoint.id)
                            }
                        }
                    } label: {
                        Text(expanded ? "Show less" : "Show \(files.count - 6) more")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 8)
                }
            }
        }
    }

    private func checkpointFileRow(_ file: CheckpointFile) -> some View {
        let style = checkpointKindStyle(file.kind)
        return HStack(spacing: 6) {
            Image(systemName: style.symbolName)
                .font(.caption2)
                .foregroundStyle(style.tint)
                .frame(width: 12)
            Text(file.path)
                .font(SurgeTypography.technicalMetadata)
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
        .padding(.leading, 8)
        .contentShape(Rectangle())
    }

    private func checkpointKindStyle(_ kind: String) -> ToolActivityStyle {
        // Normalize the raw wire string into a DiffFileStatus so the glyph/
        // tint pairs live in exactly one place (`fileStatusStyle`).
        let status: DiffFileStatus =
            switch kind.lowercased() {
            case "added", "add", "a": .added
            case "deleted", "delete", "d": .deleted
            case "renamed", "rename", "r": .renamed
            default: .modified
            }
        return fileStatusStyle(status)
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
        withAnimation(Motion.structure) {
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

    // MARK: - Sections

    /// Uppercase eyebrow labeling a feed zone ("Now").
    private func sectionLabel(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }

    /// Collapsible section header: chevron, eyebrow label, and a count pill.
    /// Collapse is the only "mode" the feed has — everything stays in one
    /// scroll, the section just folds away.
    private func sectionHeader(
        _ title: String, count: Int, isCollapsed: Binding<Bool>
    ) -> some View {
        Button {
            withAnimation(Motion.structure) {
                isCollapsed.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isCollapsed.wrappedValue ? 0 : 90))
                sectionLabel(title)
                Text("\(count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityHint(isCollapsed.wrappedValue ? "Expand" : "Collapse")
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ContentUnavailableView(
            "No Activity Yet",
            systemImage: "waveform.path.ecg",
            description: Text("Agent activity and file changes will appear here as you work."))
            .frame(maxWidth: .infinity)
            .padding(.top, 32)
            .transition(Motion.materialize)
    }
}

/// 26×26 icon button for inspector surfaces: transparent at rest, flat hover
/// wash in `Corners.compact` — no glass (content surface rule).
private struct ChangesQuietIconButton: View {
    let systemImage: String
    let help: String
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
                .background {
                    if isHovering {
                        RoundedRectangle(
                            cornerRadius: AlpineTheme.Corners.compact, style: .continuous
                        )
                        .fill(Color.primary.opacity(0.07))
                    }
                }
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }
}
