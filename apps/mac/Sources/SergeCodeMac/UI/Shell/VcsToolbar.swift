import AppKit
import SwiftUI

/// The git controls embedded in the chat header: an inline row that groups
/// the branch dropdown, working-tree status chips, PR affordances, and the
/// git-actions dropdown directly into the top bar. There is no surrounding
/// card — the triggers' own bordered-pill chrome keeps the controls legible
/// on the header's transparent scenery backdrop.
struct VcsToolbar: View {
    let model: AppModel
    /// The thread this toolbar instance is scoped to. The call site
    /// (`ChatHeaderView`) keys this view's identity to the same id
    /// (`.id(thread.id)`) so switching threads tears down and remounts a
    /// fresh instance — otherwise `branches`/`runningAction`/`pendingAction`/
    /// `commitMessage` below would survive the switch and briefly show
    /// thread A's in-flight git state over thread B.
    let threadID: String

    @UIState private var branches: [BranchRef] = []
    @UIState private var branchQuery = ""
    @UIState private var showNewBranchPrompt = false
    @UIState private var newBranchName = ""
    @UIState private var pendingAction: GitAction?
    @UIState private var commitMessage = ""
    @UIState private var runningAction: GitAction?
    @UIState private var pullRequestReviewReference: String?
    @UIState private var showBranchMenu = false
    @UIState private var showGitActions = false
    @UIState private var branchMenuHovering = false
    @UIState private var gitActionsHovering = false
    @FocusState private var branchSearchFocused: Bool

    private var isRunningAction: Bool { runningAction != nil }

    private var filteredBranches: [BranchRef] {
        let query = branchQuery.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return branches }
        return branches.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        if let status = model.selectedVcsStatus(), status.isRepo {
            vcsStrip(status)
                .transition(Motion.unfold)
        }
    }

    private func vcsStrip(_ status: VcsStatus) -> some View {
        HStack(spacing: 10) {
            if let outcome = model.lastGitActionOutcome(for: threadID) {
                outcomePill(outcome)
                    .transition(Motion.banner)
            }
            branchMenu(status)
            statusChips(status)
            prControls(status)
            actionMenu(status)
        }
        // Rare successes arrive on the delight spring; failures stay sober.
        .animation(
            model.lastGitActionOutcome(for: threadID)?.success == true
                ? Motion.delight
                : Motion.reveal,
            value: model.lastGitActionOutcome(for: threadID)
        )
        .animation(Motion.ambient, value: status)
        .alert("New branch", isPresented: $showNewBranchPrompt) {
            TextField("Branch name", text: $newBranchName)
            Button("Create") {
                let name = newBranchName.trimmingCharacters(in: .whitespaces)
                newBranchName = ""
                guard !name.isEmpty else { return }
                Task {
                    await model.createBranch(name)
                    await refreshBranches()
                }
            }
            Button("Cancel", role: .cancel) { newBranchName = "" }
        }
        .sheet(isPresented: commitSheetBinding) {
            commitMessageSheet
        }
        .sheet(
            isPresented: Binding(
                get: { pullRequestReviewReference != nil },
                set: { if !$0 { pullRequestReviewReference = nil } })
        ) {
            if let reference = pullRequestReviewReference {
                PullRequestReviewView(model: model, threadID: threadID, reference: reference)
            }
        }
    }

    // MARK: - Dropdown chrome

    /// Shared chrome for the toolbar's dropdown triggers: a bordered pill that is
    /// always visibly a button (fill + hairline, deepening on hover/open)
    /// with a chevron that flips while the popover is presented. `prominent`
    /// tints the pill with the alpine accent for the primary git-actions menu.
    private func dropdownTrigger<LabelContent: View>(
        isPresented: Bool,
        isHovering: Bool,
        prominent: Bool = false,
        @ViewBuilder label: () -> LabelContent
    ) -> some View {
        HStack(spacing: 6) {
            label()
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(
                    prominent ? AlpineTheme.forest.opacity(0.75) : Color.secondary)
                .rotationEffect(.degrees(isPresented ? 180 : 0))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .contentShape(
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        .background {
            let shape = RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.control, style: .continuous)
            shape
                .fill(
                    prominent
                        ? AlpineTheme.accent.opacity(
                            isPresented ? 0.62 : isHovering ? 0.5 : 0.34)
                        : Color.primary.opacity(
                            isPresented ? 0.11 : isHovering ? 0.085 : 0.05)
                )
                .overlay {
                    shape.strokeBorder(
                        prominent
                            ? AlpineTheme.accent.opacity(0.95)
                            : Color.primary.opacity(isPresented || isHovering ? 0.16 : 0.10),
                        lineWidth: 1)
                }
        }
    }

    /// Bordered capsule button for the toolbar's inline actions (PR link,
    /// comments, ready-for-review). A view (not a `ButtonStyle`) so the hover
    /// state can live in `@UIState`; the pill deepens under the pointer like
    /// the dropdown triggers do.
    private struct PillButton<LabelContent: View>: View {
        let action: () -> Void
        @ViewBuilder let label: LabelContent

        @UIState private var isHovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            Button {
                Haptics.play(.selection)
                action()
            } label: {
                label
            }
                .buttonStyle(.plain)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 9)
                .padding(.vertical, 4.5)
                .contentShape(Capsule())
                .background {
                    Capsule()
                        .fill(Color.primary.opacity(isHovering ? 0.1 : 0.05))
                        .overlay {
                            Capsule()
                                .strokeBorder(
                                    Color.primary.opacity(isHovering ? 0.16 : 0.10),
                                    lineWidth: 1)
                        }
                }
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { isHovering = $0 }
                .animation(Motion.feedback, value: isHovering)
        }
    }

    // MARK: - Branch menu

    private func branchMenu(_ status: VcsStatus) -> some View {
        Button {
            showBranchMenu.toggle()
        } label: {
            dropdownTrigger(isPresented: showBranchMenu, isHovering: branchMenuHovering) {
                HStack(spacing: 7) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(AlpineTheme.forest)
                        .frame(width: 20, height: 20)
                        .background(
                            AlpineTheme.accent.opacity(0.85),
                            in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    Text(status.branch ?? "no branch")
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .buttonStyle(.plain)
        // No `.fixedSize()` here: it would counter-propose the label's ideal
        // width and defeat the middle-truncation for long branch names.
        // Capped tighter than a standalone toolbar would allow so the header
        // keeps room for the thread title on narrower windows.
        .frame(maxWidth: 200, alignment: .leading)
        .onHover { branchMenuHovering = $0 }
        .animation(Motion.feedback, value: branchMenuHovering)
        .animation(Motion.feedback, value: showBranchMenu)
        .help("Current branch — click to switch, create, or pull")
        .popover(isPresented: $showBranchMenu, arrowEdge: .bottom) {
            branchPopover(status)
        }
        .onChange(of: showBranchMenu) { _, presented in
            if !presented { branchQuery = "" }
        }
        // Keyed to the thread (not a one-shot `.onAppear`) so the branch
        // list refreshes for the repo this toolbar instance now belongs to,
        // and cancels cleanly if the thread changes mid-fetch.
        .task(id: threadID) {
            await refreshBranches()
        }
    }

    /// Re-fetches the popover's branch list. Called on mount and after a
    /// branch create/switch so the list and its `isCurrent` markers don't
    /// go stale while the toolbar stays mounted.
    private func refreshBranches() async {
        branches = await model.listBranches(query: nil)
    }

    private func branchPopover(_ status: VcsStatus) -> some View {
        ComposerPickerSurface(width: 320) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "arrow.triangle.branch",
                    title: "Branches",
                    subtitle: "Current: \(status.branch ?? "none")")
                branchSearchField
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
                Divider().opacity(0.55)
                ScrollView {
                    LazyVStack(spacing: 3) {
                        if filteredBranches.isEmpty {
                            VStack(spacing: 6) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 16, weight: .medium))
                                Text("No branches match “\(branchQuery)”")
                                    .font(.caption)
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 22)
                        } else {
                            ComposerPickerSectionLabel(title: "Switch branch")
                            ForEach(filteredBranches) { branch in
                                AlpineMenuRow(
                                    icon: "arrow.triangle.branch",
                                    title: branch.name,
                                    isSelected: branch.isCurrent
                                ) {
                                    showBranchMenu = false
                                    Task {
                                        await model.switchBranch(branch.name)
                                        await refreshBranches()
                                    }
                                }
                                .disabled(branch.isCurrent)
                            }
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: 280)
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ComposerPickerSectionLabel(title: "Repository")
                    AlpineMenuRow(
                        icon: "plus", title: "New Branch…",
                        detail: "Create and switch to a new branch"
                    ) {
                        showBranchMenu = false
                        // Defer one runloop turn so the alert never races the
                        // popover dismissal.
                        DispatchQueue.main.async { showNewBranchPrompt = true }
                    }
                    AlpineMenuRow(
                        icon: "arrow.triangle.pull", title: "Pull",
                        detail: "Fetch and merge the latest remote changes"
                    ) {
                        showBranchMenu = false
                        Task { await model.pull() }
                    }
                }
                .padding(8)
            }
        }
        .onAppear { branchSearchFocused = true }
    }

    private var branchSearchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Filter branches", text: $branchQuery)
                .textFieldStyle(.plain)
                .focused($branchSearchFocused)
            if !branchQuery.isEmpty {
                Button {
                    branchQuery = ""
                    branchSearchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Clear filter")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            .fill.quaternary,
            in: RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                .strokeBorder(
                    branchSearchFocused
                        ? AlpineTheme.accent : Color.primary.opacity(0.08),
                    lineWidth: 1)
        }
    }

    // MARK: - Status chips

    @ViewBuilder
    private func statusChips(_ status: VcsStatus) -> some View {
        if status.changedFileCount > 0 {
            statusChip {
                HStack(spacing: 5) {
                    Text(
                        "^[\(status.changedFileCount) file](inflect: true) changed"
                    )
                    if status.insertions > 0 {
                        Text("+\(status.insertions)")
                            .foregroundStyle(AlpineTheme.statusSuccess)
                    }
                    if status.deletions > 0 {
                        Text("−\(status.deletions)")
                            .foregroundStyle(.red)
                    }
                }
            }
            .contentTransition(.numericText())
            .transition(Motion.materialize)
            .help("Uncommitted changes in the working tree")
        }
        if status.aheadCount > 0 || status.behindCount > 0 {
            statusChip {
                HStack(spacing: 6) {
                    if status.aheadCount > 0 {
                        Label("\(status.aheadCount)", systemImage: "arrow.up")
                    }
                    if status.behindCount > 0 {
                        Label("\(status.behindCount)", systemImage: "arrow.down")
                    }
                }
            }
            .contentTransition(.numericText())
            .transition(Motion.materialize)
            .help("Commits ahead of / behind the upstream branch")
        }
    }

    /// A bordered capsule tag so working-tree state reads as glanceable
    /// status rather than bare toolbar text.
    private func statusChip<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(0.05), in: Capsule())
            .overlay {
                Capsule().strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            }
    }

    // MARK: - PR controls

    @ViewBuilder
    private func prControls(_ status: VcsStatus) -> some View {
        if let prURL = status.prURL, let url = URL(string: prURL) {
            let isMerged = status.prState == .merged
            let isDraft = status.isDraftPR == true
            PillButton {
                NSWorkspace.shared.open(url)
            } label: {
                Label(
                    (status.prNumber.map { "PR #\($0)" } ?? "PR")
                        + (isMerged ? " · Merged" : isDraft ? " · Draft" : ""),
                    systemImage: isMerged
                        ? "checkmark.seal.fill"
                        : isDraft ? "doc.badge.clock" : "arrow.triangle.pull")
            }
            .foregroundStyle(
                isMerged
                    ? AnyShapeStyle(.purple)
                    : isDraft ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
            .help(status.prTitle ?? "Open pull request")
        }
        if status.prState == .open, status.hasPrConflicts {
            Label("Conflicts", systemImage: "exclamationmark.triangle.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(.red)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.red.opacity(0.12), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(Color.red.opacity(0.25), lineWidth: 1)
                }
                .transition(Motion.materialize)
                .help("This pull request has merge conflicts with its base branch.")
        }
        if let prNumber = status.prNumber {
            PillButton {
                pullRequestReviewReference = String(prNumber)
            } label: {
                Label(
                    status.unresolvedReviewThreadCount.map { "Comments · \($0)" }
                        ?? "Comments",
                    systemImage: "bubble.left.and.bubble.right")
            }
            .foregroundStyle(
                (status.unresolvedReviewThreadCount ?? 0) > 0
                    ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            .help("View comments and review threads on PR #\(prNumber)")
        }
        if status.prState == .open, status.isDraftPR == true {
            PillButton {
                run(.readyPR, message: nil)
            } label: {
                if runningAction == .readyPR {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Marking ready…")
                    }
                    .transition(.opacity)
                } else {
                    Label("Ready for Review", systemImage: "checkmark.circle")
                        .transition(.opacity)
                }
            }
            .disabled(isRunningAction)
            .animation(Motion.reveal, value: runningAction)
            .help("Mark PR #\(status.prNumber ?? 0) ready for review")
        }
        if MergeReadiness.isReady(for: status) {
            Button {
                run(.mergePR, message: nil)
            } label: {
                if runningAction == .mergePR {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(AlpineTheme.forest)
                        Text("Merging…")
                    }
                    .transition(.opacity)
                } else {
                    Label("Merge PR", systemImage: "arrow.triangle.merge")
                        .transition(.opacity)
                }
            }
            .buttonStyle(VcsMergePillButtonStyle())
            .disabled(isRunningAction)
            .animation(Motion.reveal, value: runningAction)
            .help("Merge the open pull request")
        }
    }

    // MARK: - Actions

    private func actionMenu(_ status: VcsStatus) -> some View {
        Button {
            showGitActions.toggle()
        } label: {
            dropdownTrigger(
                isPresented: showGitActions, isHovering: gitActionsHovering, prominent: true
            ) {
                // Merge owns its own in-button spinner; only show the menu
                // spinner for other actions.
                if let runningAction, runningAction != .mergePR, runningAction != .readyPR {
                    ProgressView()
                        .controlSize(.small)
                        .tint(AlpineTheme.forest)
                        .transition(.opacity)
                } else {
                    Label("Git", systemImage: "arrow.up.circle")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(AlpineTheme.forest)
                        .transition(.opacity)
                }
            }
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(isRunningAction)
        .onHover { gitActionsHovering = $0 }
        .animation(Motion.feedback, value: gitActionsHovering)
        .animation(Motion.reveal, value: runningAction)
        .help("Commit, push, and pull-request actions")
        .popover(isPresented: $showGitActions, arrowEdge: .bottom) {
            gitActionsPopover(status)
        }
    }

    private func gitActionsPopover(_ status: VcsStatus) -> some View {
        ComposerPickerSurface(width: 300) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "arrow.up.circle",
                    title: "Git actions",
                    subtitle: status.branch ?? "No branch")
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ForEach(GitAction.menuActions) { action in
                        AlpineMenuRow(
                            icon: action.menuSymbol,
                            title: action.displayName,
                            detail: action.menuDetail
                        ) {
                            showGitActions = false
                            if action.needsCommitMessage {
                                commitMessage = ""
                                // Defer one runloop turn so the commit sheet
                                // never races the popover dismissal.
                                DispatchQueue.main.async { pendingAction = action }
                            } else {
                                run(action, message: nil)
                            }
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    private var commitSheetBinding: Binding<Bool> {
        Binding(
            get: { pendingAction != nil },
            set: { if !$0 { pendingAction = nil } })
    }

    private var commitMessageSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(pendingAction?.displayName ?? "Commit")
                .font(.headline)
            TextEditor(text: $commitMessage)
                .font(.body)
                .frame(width: 380, height: 90)
                .overlay(alignment: .topLeading) {
                    if commitMessage.isEmpty {
                        Text("Commit message (optional — server generates one if empty)")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 1)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                Spacer()
                // `.cancel` role only wires Escape up inside alerts, so the
                // sheet needs the shortcut spelled out to be dismissible from
                // the focused message editor.
                Button("Cancel", role: .cancel) { pendingAction = nil }
                    .keyboardShortcut(.cancelAction)
                Button("Run") {
                    let action = pendingAction
                    pendingAction = nil
                    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let action {
                        run(action, message: message.isEmpty ? nil : message)
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(20)
    }

    private func run(_ action: GitAction, message: String?) {
        guard runningAction == nil else { return }
        runningAction = action
        Haptics.play(.commit)
        Task {
            await model.runGitAction(action, commitMessage: message)
            runningAction = nil
            // The outcome pill lands with a tap so a long push/PR round trip
            // reports itself even when the user has looked away. A successful
            // merge is skipped here — the celebration overlay owns that beat.
            if let outcome = model.lastGitActionOutcome,
                !(action == .mergePR && outcome.success)
            {
                Haptics.playOutcome(success: outcome.success)
            }
        }
    }

    // MARK: - Outcome pill

    /// Compact inline result of the last git action. The full detail string
    /// (often a long error) rides in the tooltip so the header row never
    /// grows a second line.
    private func outcomePill(_ outcome: GitActionOutcome) -> some View {
        HStack(spacing: 6) {
            let icon = Image(systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(outcome.success ? .green : .red)
            if Motion.reduceMotion || !outcome.success {
                icon
            } else {
                icon.symbolEffect(.bounce, value: outcome)
            }
            Text(outcome.title)
                .lineLimit(1)
            if let prURL = outcome.prURL, let url = URL(string: prURL) {
                Button("Open PR") { NSWorkspace.shared.open(url) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
            }
            Button {
                // The flat compat setter clears whichever thread is
                // currently selected — safe here because this toolbar only
                // ever renders for the selected thread, so it's always
                // `threadID` being cleared, matching the outcome read above.
                model.lastGitActionOutcome = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            // The pill's `.help` sits on the enclosing HStack, so the
            // icon-only button needs its own name.
            .help("Dismiss")
            .accessibilityLabel("Dismiss git result")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.primary.opacity(0.05), in: Capsule())
        .overlay {
            Capsule().strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        }
        .help(outcome.detail ?? outcome.title)
    }
}

/// Emphasized pill for the one-click merge affordance (matches follow-up bar).
/// Solid accent fill with a forest label — the app's primary-action language —
/// so the button and its in-flight spinner stay legible on the dark chrome
/// (the old white capsule rendered a white-on-white spinner).
private struct VcsMergePillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background {
                Capsule()
                    .fill(AlpineTheme.accent.opacity(configuration.isPressed ? 0.72 : 1))
            }
            .foregroundStyle(AlpineTheme.forest)
            .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
            .pressFeedback(configuration.isPressed, event: .commit)
    }
}

private extension GitAction {
    /// SF Symbol for the action's row in the Git actions popover.
    var menuSymbol: String {
        switch self {
        case .commit: "checkmark.circle"
        case .push: "arrow.up.circle"
        case .commitPush: "arrow.up.doc"
        case .commitPushPR: "arrow.triangle.pull"
        case .readyPR: "checkmark.seal"
        case .mergePR: "arrow.triangle.merge"
        }
    }

    /// One-line explanation under the action title, so the menu teaches what
    /// each stacked action does instead of relying on the name alone.
    var menuDetail: String {
        switch self {
        case .commit: "Commit all working-tree changes"
        case .push: "Push committed changes to the remote"
        case .commitPush: "Commit all changes, then push"
        case .commitPushPR: "Commit, push, and open a pull request"
        case .readyPR: "Mark the draft PR ready for review"
        case .mergePR: "Merge the open pull request"
        }
    }
}
