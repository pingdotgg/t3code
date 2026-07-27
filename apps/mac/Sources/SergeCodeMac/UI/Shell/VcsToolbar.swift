import AppKit
import SwiftUI

/// The git controls embedded in the chat header: one bar of same-height chips
/// grouping the branch dropdown, working-tree status, PR affordances, and the
/// git-actions menu.
///
/// Every chip goes through `HeaderChip`/`HeaderChipButton`, so the row has a
/// single height, a single shape, and a single type scale. The bar renders at
/// the `density` the header resolves for the current window width: the same
/// chips throughout, trading prose for glyphs as the window narrows, with the
/// full sentence kept in each chip's tooltip and accessibility label.
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
            if let outcome {
                outcomeChip(outcome)
                    .transition(Motion.banner)
            }
            branchChip(status)
            workingTreeChip(inventory)
            divergenceChip(inventory)
            prChips(status, inventory)
            actionChip(status)
        }
        // Rare successes arrive on the delight spring; failures stay sober.
        .animation(
            outcome?.success == true ? Motion.delight : Motion.reveal,
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
            maxWidth: density.branchWidth,
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

    // MARK: - Working tree

    @ViewBuilder
    private func workingTreeChip(_ inventory: GitBarInventory) -> some View {
        if inventory.showsWorkingTree {
            HeaderChip {
                HStack(spacing: HeaderChipMetrics.contentSpacing) {
                    if density.showsLabels {
                        Text(inventory.filesChangedLabel)
                    } else {
                        Image(systemName: "doc.on.doc")
                            .font(HeaderChipMetrics.iconFont)
                        Text(inventory.changedFilesCount)
                    }
                    // The deltas are the chip's most-read numbers, so they
                    // survive one tier longer than the words around them.
                    if density > .minimal {
                        if let insertions = inventory.insertionsLabel {
                            Text(insertions).foregroundStyle(AlpineTheme.statusSuccess)
                        }
                        if let deletions = inventory.deletionsLabel {
                            Text(deletions).foregroundStyle(.red)
                        }
                    }
                }
            }
            .contentTransition(.numericText())
            .transition(Motion.materialize)
            .help(workingTreeDescription(inventory))
            .accessibilityLabel(workingTreeDescription(inventory))
        }
    }

    private func workingTreeDescription(_ inventory: GitBarInventory) -> String {
        let deltas = [inventory.insertionsLabel, inventory.deletionsLabel]
            .compactMap(\.self)
            .joined(separator: " ")
        let counts = deltas.isEmpty ? "" : " (\(deltas))"
        return "Uncommitted changes in the working tree: "
            + inventory.filesChangedLabel + counts
    }

    @ViewBuilder
    private func divergenceChip(_ inventory: GitBarInventory) -> some View {
        if inventory.showsDivergence {
            HeaderChip {
                HStack(spacing: HeaderChipMetrics.contentSpacing) {
                    if inventory.ahead > 0 {
                        chipLabel("arrow.up", inventory.aheadCount)
                    }
                    if inventory.behind > 0 {
                        chipLabel("arrow.down", inventory.behindCount)
                    }
                }
            }
            .contentTransition(.numericText())
            .transition(Motion.materialize)
            .help("Commits ahead of / behind the upstream branch")
            .accessibilityLabel(
                "\(inventory.ahead) commits ahead, \(inventory.behind) behind upstream")
        }
    }

    // MARK: - PR controls

    @ViewBuilder
    private func prChips(_ status: VcsStatus, _ inventory: GitBarInventory) -> some View {
        if let prURL = status.prURL, let url = URL(string: prURL) {
            let label = inventory.prLabel(at: density)
            HeaderChipButton(
                role: .tinted(
                    inventory.prIsMerged
                        ? .purple : inventory.prIsDraft ? .secondary : AlpineTheme.sky),
                isIconOnly: label == nil,
                action: { NSWorkspace.shared.open(url) }
            ) {
                chipLabel(
                    inventory.prIsMerged
                        ? "checkmark.seal.fill"
                        : inventory.prIsDraft ? "doc.badge.clock" : "arrow.triangle.pull",
                    label)
            }
            .help(status.prTitle ?? "Open pull request")
            .accessibilityLabel(inventory.prLabel(at: .full) ?? "Pull request")
        }
        if inventory.showsConflicts {
            HeaderChip(
                role: .tinted(.red),
                isIconOnly: !density.showsLabels
            ) {
                chipLabel(
                    "exclamationmark.triangle.fill", density.showsLabels ? "Conflicts" : nil)
            }
            .transition(Motion.materialize)
            .help("This pull request has merge conflicts with its base branch.")
            .accessibilityLabel("Merge conflicts")
        }
        if let prNumber = status.prNumber {
            let label = inventory.commentsLabel(at: density)
            HeaderChipButton(
                role: .tinted(
                    (inventory.comments ?? 0) > 0 ? .orange : .secondary),
                isIconOnly: label == nil,
                action: { pullRequestReviewReference = String(prNumber) }
            ) {
                chipLabel("bubble.left.and.bubble.right", label)
            }
            .help("View comments and review threads on PR #\(prNumber)")
            .accessibilityLabel(inventory.commentsLabel(at: .full) ?? "Comments")
        }
        if inventory.showsReadyForReview {
            let label = inventory.readyLabel(at: density)
            HeaderChipButton(
                role: .control,
                isIconOnly: label == nil && runningAction != .readyPR,
                action: { run(.readyPR, message: nil) }
            ) {
                if runningAction == .readyPR {
                    HStack(spacing: HeaderChipMetrics.contentSpacing) {
                        ProgressView().controlSize(.small)
                        if density.showsLabels { Text("Marking ready…") }
                    }
                    .transition(.opacity)
                } else {
                    chipLabel("checkmark.circle", label)
                        .transition(.opacity)
                }
            }
            .disabled(isRunningAction)
            .animation(Motion.reveal, value: runningAction)
            .help("Mark PR #\(status.prNumber ?? 0) ready for review")
            .accessibilityLabel("Mark ready for review")
        }
        if inventory.showsMerge {
            let label = inventory.mergeLabel(at: density)
            HeaderChipButton(
                role: .primary,
                isIconOnly: label == nil && runningAction != .mergePR,
                action: { run(.mergePR, message: nil) }
            ) {
                if runningAction == .mergePR {
                    HStack(spacing: HeaderChipMetrics.contentSpacing) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(AlpineTheme.forest)
                        if density.showsLabels { Text("Merging…") }
                    }
                    .transition(.opacity)
                } else {
                    chipLabel("arrow.triangle.merge", label)
                        .transition(.opacity)
                }
            }
            .disabled(isRunningAction)
            .animation(Motion.reveal, value: runningAction)
            .help("Merge the open pull request")
            .accessibilityLabel("Merge pull request")
        }
    }

    // MARK: - Actions

    private func actionChip(_ status: VcsStatus) -> some View {
        HeaderChipButton(
            role: .primary,
            isOn: showGitActions,
            showsChevron: true,
            action: { showGitActions.toggle() }
        ) {
            // Merge and ready-for-review own their in-chip spinners; only show
            // the menu spinner for the actions this menu itself started.
            if let runningAction, runningAction != .mergePR, runningAction != .readyPR {
                ProgressView()
                    .controlSize(.small)
                    .tint(AlpineTheme.forest)
                    .transition(.opacity)
            } else {
                chipLabel("arrow.up.circle", density == .minimal ? nil : "Git")
                    .transition(.opacity)
            }
        }
        .disabled(isRunningAction)
        .animation(Motion.reveal, value: runningAction)
        .help("Commit, push, and pull-request actions")
        .accessibilityLabel("Git actions")
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

    // MARK: - Outcome chip

    /// Compact inline result of the last git action. The full detail string
    /// (often a long error) rides in the tooltip so the bar never grows a
    /// second line.
    private func outcomeChip(_ outcome: GitActionOutcome) -> some View {
        HeaderChip(
            role: .tinted(outcome.success ? AlpineTheme.statusSuccess : .red),
            // Capped on the chip, not on the title inside it: a cap applied
            // within a `fixedSize`d chip clips the text instead of truncating
            // it, because the chip proposes the title its full ideal width.
            maxWidth: density.outcomeChipWidth,
            isIconOnly: density == .minimal
        ) {
            HStack(spacing: HeaderChipMetrics.contentSpacing) {
                let icon = Image(
                    systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill"
                )
                .font(HeaderChipMetrics.iconFont)
                if Motion.reduceMotion || !outcome.success {
                    icon
                } else {
                    icon.symbolEffect(.bounce, value: outcome)
                }
                if density > .minimal {
                    Text(outcome.title)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if density == .full, let prURL = outcome.prURL, let url = URL(string: prURL) {
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
                // The chip's `.help` sits on the enclosing chip, so the
                // icon-only button needs its own name.
                .help("Dismiss")
                .accessibilityLabel("Dismiss git result")
            }
        }
        .help(outcome.detail ?? outcome.title)
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
