import AppKit
import SwiftUI

/// The repository controls embedded in the chat header: one segmented bar with
/// stable slots for branch, repository state, pull request, contextual action,
/// and the full actions menu.
///
/// Repository updates replace content inside those slots instead of inserting
/// and removing pills. That keeps neighboring controls anchored while the bar
/// trades prose for glyphs at narrower density tiers.
struct VcsToolbar: View {
    let model: AppModel
    /// The thread this toolbar instance is scoped to. The call site
    /// (`ChatHeaderView`) keys this view's identity to the same id
    /// (`.id(thread.id)`) so switching threads tears down and remounts a
    /// fresh instance — otherwise `branches`/`runningAction`/`pendingAction`/
    /// `commitMessage` below would survive the switch and briefly show
    /// thread A's in-flight git state over thread B.
    let threadID: String
    /// How much room the header has for labels. Defaults to the widest tier so
    /// a caller that measures nothing (the probe's fitting-size pass) still
    /// gets the bar at full width.
    var density: HeaderBarDensity = .full

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
        let outcome = model.lastGitActionOutcome(for: threadID)
        let inventory = GitBarInventory(status: status, outcomeTitle: outcome?.title)
        return HStack(spacing: HeaderChipMetrics.barSpacing) {
            branchChip(status)
            repositoryChip(inventory, outcome: outcome)
            pullRequestChip(status, inventory)
            primaryActionChip(status, inventory)
            actionMenuChip(status)
        }
        .headerControlBarChrome()
        .animation(Motion.reveal, value: model.lastGitActionOutcome(for: threadID))
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

    // MARK: - Chip labels

    /// A chip's glyph plus its optional text, at the bar's shared spacing.
    /// `text` is nil at the densities where the chip folds down to its glyph;
    /// every call site pairs that with a `.help` and an `.accessibilityLabel`
    /// carrying the full sentence, so folding removes characters and never
    /// meaning.
    @ViewBuilder
    private func chipLabel(_ symbol: String, _ text: String?) -> some View {
        HStack(spacing: HeaderChipMetrics.contentSpacing) {
            Image(systemName: symbol)
                .font(HeaderChipMetrics.iconFont)
            if let text {
                Text(text)
            }
        }
    }

    // MARK: - Branch

    private func branchChip(_ status: VcsStatus) -> some View {
        HeaderChipButton(
            role: .control,
            isOn: showBranchMenu,
            width: density.branchWidth,
            showsChevron: true,
            action: { showBranchMenu.toggle() }
        ) {
            HStack(spacing: HeaderChipMetrics.contentSpacing) {
                Image(systemName: "arrow.triangle.branch")
                    .font(HeaderChipMetrics.iconFont)
                    .foregroundStyle(AlpineTheme.meadow)
                Text(status.branch ?? "no branch")
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .help("Current branch — click to switch, create, or pull")
        .accessibilityLabel("Branch \(status.branch ?? "none")")
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

    // MARK: - Unified stable segments

    private func repositoryChip(_ inventory: GitBarInventory, outcome: GitActionOutcome?)
        -> some View
    {
        HeaderChip(
            role: outcome.map { .tinted($0.success ? AlpineTheme.statusSuccess : .red) }
                ?? .readout,
            width: density.repositoryWidth
        ) {
            HStack(spacing: HeaderChipMetrics.contentSpacing) {
                if let outcome {
                    Image(systemName: outcome.success ? "checkmark.circle" : "xmark.octagon")
                        .font(HeaderChipMetrics.iconFont)
                    if density > .minimal {
                        Text(outcome.success ? "Complete" : "Failed")
                    }
                    Button {
                        model.lastGitActionOutcome = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("Dismiss")
                    .accessibilityLabel("Dismiss git result")
                } else if inventory.showsWorkingTree {
                    Image(systemName: "doc.on.doc")
                        .font(HeaderChipMetrics.iconFont)
                    Text(inventory.changedFilesCount)
                    if density == .full, let insertions = inventory.insertionsLabel {
                        Text(insertions).foregroundStyle(AlpineTheme.statusSuccess)
                    }
                    if density == .full, let deletions = inventory.deletionsLabel {
                        Text(deletions).foregroundStyle(.red)
                    }
                } else {
                    Image(systemName: "checkmark")
                        .font(HeaderChipMetrics.iconFont)
                    if density > .minimal {
                        Text("Clean")
                    }
                }

                if outcome == nil, density > .minimal {
                    if inventory.ahead > 0 {
                        chipLabel("arrow.up", inventory.aheadCount)
                    }
                    if inventory.behind > 0 {
                        chipLabel("arrow.down", inventory.behindCount)
                    }
                }
            }
        }
        .contentTransition(.numericText())
        .help(repositoryDescription(inventory, outcome: outcome))
        .accessibilityLabel(repositoryDescription(inventory, outcome: outcome))
    }

    private func repositoryDescription(_ inventory: GitBarInventory, outcome: GitActionOutcome?)
        -> String
    {
        if let outcome { return outcome.detail ?? outcome.title }
        var parts = [
            inventory.showsWorkingTree
                ? "Uncommitted changes: \(inventory.filesChangedLabel)"
                : "Working tree clean"
        ]
        if inventory.showsDivergence {
            parts.append("\(inventory.ahead) commits ahead, \(inventory.behind) behind upstream")
        }
        return parts.joined(separator: ". ")
    }

    @ViewBuilder
    private func pullRequestChip(_ status: VcsStatus, _ inventory: GitBarInventory) -> some View {
        if let prURL = status.prURL, let url = URL(string: prURL) {
            let label = inventory.prLabel(at: density)
            HeaderChip(
                role: .tinted(
                    inventory.prIsMerged
                        ? AlpineTheme.statusSuccess
                        : inventory.showsConflicts
                            ? .red : inventory.prIsDraft ? .secondary : AlpineTheme.sky),
                width: density.pullRequestWidth
            ) {
                HStack(spacing: HeaderChipMetrics.contentSpacing) {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        HStack(spacing: HeaderChipMetrics.contentSpacing) {
                            Image(systemName: pullRequestSymbol(inventory))
                                .font(HeaderChipMetrics.iconFont)
                            if let label { Text(label) }
                        }
                    }
                    .buttonStyle(.plain)
                    .help(status.prTitle ?? "Open pull request")

                    if density > .minimal, let prNumber = status.prNumber {
                        Spacer(minLength: 0)
                        Button {
                            pullRequestReviewReference = String(prNumber)
                        } label: {
                            HStack(spacing: 2) {
                                Image(systemName: "bubble.left")
                                if let comments = inventory.comments, comments > 0 {
                                    Text(comments.formatted())
                                }
                            }
                            .font(HeaderChipMetrics.iconFont)
                            .foregroundStyle(
                                (inventory.comments ?? 0) > 0 ? .orange : .secondary)
                        }
                        .buttonStyle(.plain)
                        .help("View comments and review threads on PR #\(prNumber)")
                        .accessibilityLabel(inventory.commentsLabel(at: .full) ?? "Comments")
                    }
                }
            }
            .help(pullRequestDescription(status, inventory))
            .accessibilityLabel(inventory.prLabel(at: .full) ?? "Pull request")
        } else {
            HeaderChipButton(
                role: .control,
                width: density.pullRequestWidth,
                action: { showGitActions.toggle() }
            ) {
                chipLabel("arrow.triangle.pull", inventory.prLabel(at: density))
            }
            .help("No pull request — open Git actions")
            .accessibilityLabel("No pull request")
        }
    }

    private func pullRequestDescription(_ status: VcsStatus, _ inventory: GitBarInventory) -> String {
        var parts = [status.prTitle ?? inventory.prLabel(at: .full) ?? "Pull request"]
        if inventory.showsConflicts { parts.append("Has merge conflicts") }
        if let comments = inventory.comments {
            parts.append("\(comments) unresolved review threads")
        }
        return parts.joined(separator: ". ")
    }

    private func pullRequestSymbol(_ inventory: GitBarInventory) -> String {
        if inventory.prIsMerged { return "checkmark.circle" }
        if inventory.showsConflicts { return "exclamationmark.triangle" }
        if inventory.prIsDraft { return "doc.badge.clock" }
        return "arrow.triangle.pull"
    }

    private enum PrimaryAction {
        case merge, ready, commitPush, push, menu

        var gitAction: GitAction? {
            switch self {
            case .merge: .mergePR
            case .ready: .readyPR
            case .commitPush: .commitPush
            case .push: .push
            case .menu: nil
            }
        }

        var symbol: String {
            switch self {
            case .merge: "arrow.triangle.merge"
            case .ready: "checkmark.seal"
            case .commitPush: "arrow.up.doc"
            case .push: "arrow.up"
            case .menu: "ellipsis"
            }
        }

        func label(at density: HeaderBarDensity) -> String? {
            guard density > .minimal else { return nil }
            return switch self {
            case .merge: "Merge"
            case .ready: "Ready"
            case .commitPush: "Commit"
            case .push: "Push"
            case .menu: "Git"
            }
        }
    }

    private func primaryAction(for inventory: GitBarInventory) -> PrimaryAction {
        if inventory.showsMerge { return .merge }
        if inventory.showsReadyForReview { return .ready }
        if inventory.showsWorkingTree { return .commitPush }
        if inventory.ahead > 0 { return .push }
        return .menu
    }

    private func primaryActionChip(_ status: VcsStatus, _ inventory: GitBarInventory) -> some View {
        let primary = primaryAction(for: inventory)
        let action = primary.gitAction
        return HeaderChipButton(
            role: primary == .merge ? .primary : .control,
            width: density.primaryActionWidth,
            action: {
                if let action {
                    prepare(action)
                } else {
                    showGitActions.toggle()
                }
            }
        ) {
            if runningAction == action, action != nil {
                ProgressView()
                    .controlSize(.small)
            } else {
                chipLabel(primary.symbol, primary.label(at: density))
            }
        }
        .disabled(isRunningAction)
        .animation(Motion.reveal, value: runningAction)
        .help(primaryActionHelp(primary, status: status))
        .accessibilityLabel(primaryActionHelp(primary, status: status))
    }

    private func primaryActionHelp(_ primary: PrimaryAction, status: VcsStatus) -> String {
        switch primary {
        case .merge: "Merge PR #\(status.prNumber ?? 0)"
        case .ready: "Mark PR #\(status.prNumber ?? 0) ready for review"
        case .commitPush: "Commit working-tree changes and push"
        case .push: "Push committed changes"
        case .menu: "Open Git actions"
        }
    }

    private func actionMenuChip(_ status: VcsStatus) -> some View {
        HeaderChipButton(
            role: .control,
            isOn: showGitActions,
            width: HeaderChipMetrics.height,
            isIconOnly: true,
            action: { showGitActions.toggle() }
        ) {
            Image(systemName: "ellipsis")
                .font(HeaderChipMetrics.iconFont)
        }
        .disabled(isRunningAction)
        .help("More Git actions")
        .accessibilityLabel("More Git actions")
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

    private func prepare(_ action: GitAction) {
        if action.needsCommitMessage {
            commitMessage = ""
            pendingAction = action
        } else {
            run(action, message: nil)
        }
    }

}

extension GitAction {
    /// SF Symbol for the action's row in the Git actions popover.
    fileprivate var menuSymbol: String {
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
    fileprivate var menuDetail: String {
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
