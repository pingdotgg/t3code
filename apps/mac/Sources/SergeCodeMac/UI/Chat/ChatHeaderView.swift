import SwiftUI

/// Single task-identity header. The task title leads; project scenery,
/// provider, and status remain compact supporting context. The git controls
/// (branch dropdown, working-tree chips, PR affordances, git actions) live
/// inline on the trailing side — there is no separate git section below.
/// Transparent by design: the full-page frosted scenery remains atmospheric
/// behind this shallow identity band without adding another gray plate.
struct ChatHeaderView: View {
    let thread: ChatThread
    let model: AppModel
    let scenery: SceneryStore
    let threadKey: String

    var body: some View {
        HStack(spacing: 16) {
            let names = scenery.displayNames(for: thread, threadKey: threadKey)
            VStack(alignment: .leading, spacing: 5) {
                Text(thread.title.isEmpty ? names.primary : thread.title)
                    .font(SurgeTypography.threadTitle)
                    .lineLimit(1)
                    // A generated title lands after the header is already on
                    // screen; fade the swap instead of teleporting the
                    // header's largest text.
                    .contentTransition(Motion.reduceMotion ? .identity : .opacity)
                    .animation(Motion.reveal, value: thread.title)

                HStack(spacing: 8) {
                    projectIdentity(names.primary)
                    if model.isRemote {
                        metadataDivider
                        Label(model.deviceName ?? "Remote Mac", systemImage: "laptopcomputer")
                            .lineLimit(1)
                    }
                }
                .font(SurgeTypography.technicalMetadata)
                .foregroundStyle(.primary.opacity(0.76))
            }

            Spacer(minLength: 8)

            // Git controls ride the header instead of a separate section
            // below; the toolbar owns the repo-status gate and shows nothing
            // for non-repo projects. Keyed per thread so in-flight git state
            // never leaks across a thread switch (see VcsToolbar.threadID).
            VcsToolbar(model: model, threadID: thread.id)
                .id(thread.id)

            ProviderBadge(provider: thread.provider, modelID: thread.modelID)
            StatusBadge(status: thread.status, stalled: thread.isStalled)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var projectPrefs: ProjectSceneryPrefs? {
        guard let project = model.projects.first(where: { $0.id == thread.projectID }) else {
            return nil
        }
        return scenery.projectPrefs(for: project.path)
    }

    @ViewBuilder
    private func projectIdentity(_ name: String) -> some View {
        if let prefs = projectPrefs, prefs.showsProjectBadge {
            HStack(spacing: 5) {
                ProjectSceneryBadge(prefs: prefs, symbolSize: 10, dotSize: 5)
                Text(name)
            }
        } else {
            Text(name)
        }
    }

    private var metadataDivider: some View {
        Text("·")
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

private struct ProviderBadge: View {
    let provider: ProviderKind
    let modelID: String?

    var body: some View {
        ProviderLabel(provider: provider, modelID: modelID, iconSize: 13)
            .font(.caption)
            .foregroundStyle(.primary.opacity(0.76))
    }
}

private struct StatusBadge: View {
    let status: ThreadStatus
    /// Server-reported stall for the active turn; warning-tinted (not error).
    var stalled: Bool = false

    var body: some View {
        Label(text, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(color)
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            .animation(Motion.ambient, value: status)
            .animation(Motion.ambient, value: stalled)
    }

    private var text: String {
        if stalled { return "Stalled" }
        switch status {
        case .idle: return "Idle"
        case .running: return "Running"
        case .waiting: return "Waiting"
        case .waitingApproval: return "Needs approval"
        case .waitingInput: return "Needs input"
        case .backgroundWork: return "Background work"
        case .error: return "Error"
        case .archived: return "Archived"
        case .settled: return "Settled"
        case .done: return "Done"
        case .reviewing: return "Reviewing"
        case .fixing: return "Fixing"
        case .readyToMerge: return "Ready to merge"
        }
    }

    private var icon: String {
        if stalled { return "exclamationmark.circle" }
        switch status {
        case .idle: return "circle"
        case .running: return "bolt.fill"
        case .waiting: return "clock.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .waitingInput: return "questionmark.bubble.fill"
        case .backgroundWork: return "person.2.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        case .settled: return "checkmark.circle"
        case .done: return "checkmark"
        case .reviewing: return "magnifyingglass"
        case .fixing: return "wrench.and.screwdriver"
        case .readyToMerge: return "checkmark.seal"
        }
    }

    private var color: Color {
        if stalled { return AlpineTheme.clay }
        switch status {
        case .idle: return .secondary
        case .running: return AlpineTheme.accent
        case .waiting: return AlpineTheme.sky
        case .waitingApproval: return AlpineTheme.lichen
        case .waitingInput: return AlpineTheme.sky
        case .backgroundWork: return AlpineTheme.meadow
        case .error: return .red
        case .archived: return .secondary
        case .settled: return .secondary
        case .done: return .secondary
        case .reviewing: return AlpineTheme.sky
        case .fixing: return AlpineTheme.accent
        case .readyToMerge: return AlpineTheme.lichen
        }
    }
}
