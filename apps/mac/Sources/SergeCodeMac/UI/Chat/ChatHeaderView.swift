import SwiftUI

/// Single task-identity header. The task title leads; project scenery, branch,
/// working-tree state, provider, and status remain compact supporting context.
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
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)

                HStack(spacing: 8) {
                    projectIdentity(names.primary)
                    if let status = model.selectedVcsStatus(), status.isRepo {
                        if let branch = status.branch {
                            metadataDivider
                            Label(branch, systemImage: "arrow.triangle.branch")
                                .lineLimit(1)
                        }
                        if status.changedFileCount > 0 {
                            metadataDivider
                            Text(
                                "^[\(status.changedFileCount) file](inflect: true) changed"
                            )
                            .monospacedDigit()
                        }
                    }
                    if model.isRemote {
                        metadataDivider
                        Label(model.deviceName ?? "Remote Mac", systemImage: "laptopcomputer")
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.primary.opacity(0.76))
            }

            Spacer()

            ProviderBadge(provider: thread.provider, modelID: thread.modelID)
            StatusBadge(status: thread.status, stalled: thread.isStalled)

            if let photo = scenery.photo(for: threadKey) {
                SceneryAttributionTag(photo: photo)
            }
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
        case .backgroundWork: return "Background work"
        case .error: return "Error"
        case .archived: return "Archived"
        case .settled: return "Settled"
        }
    }

    private var icon: String {
        if stalled { return "exclamationmark.circle" }
        switch status {
        case .idle: return "circle"
        case .running: return "bolt.fill"
        case .waiting: return "clock.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .backgroundWork: return "person.2.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        case .settled: return "checkmark.circle"
        }
    }

    private var color: Color {
        if stalled { return AlpineTheme.clay }
        switch status {
        case .idle: return .secondary
        case .running: return AlpineTheme.accent
        case .waiting: return AlpineTheme.sky
        case .waitingApproval: return AlpineTheme.lichen
        case .backgroundWork: return AlpineTheme.meadow
        case .error: return .red
        case .archived: return .secondary
        case .settled: return .secondary
        }
    }
}
