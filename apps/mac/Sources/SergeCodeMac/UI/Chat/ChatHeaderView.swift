import SwiftUI

/// Top chrome bar: thread title, provider + status badges, cancel control.
/// Transparent — it sits directly on the thread's `SceneryChatBackground`
/// wallpaper (which darkens toward the top for exactly this text).
struct ChatHeaderView: View {
    let thread: ChatThread
    let model: AppModel
    let scenery: SceneryStore
    let threadKey: String

    var body: some View {
        HStack(spacing: 12) {
            let names = scenery.displayNames(for: thread, threadKey: threadKey)
            VStack(alignment: .leading, spacing: 3) {
                Group {
                    if let prefs = projectPrefs, prefs.showsProjectBadge {
                        HStack(spacing: 6) {
                            ProjectSceneryBadge(prefs: prefs, symbolSize: 12, dotSize: 6)
                            Text(names.primary)
                        }
                    } else {
                        Text(names.primary)
                    }
                }
                .font(.headline)
                .lineLimit(1)
                if let description = names.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if model.isRemote {
                    Text("on \(model.deviceName ?? "Remote Mac")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack(spacing: 10) {
                    ProviderBadge(provider: thread.provider)
                    StatusBadge(status: thread.status, stalled: thread.isStalled)
                }
            }

            Spacer()

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
}

private struct ProviderBadge: View {
    let provider: ProviderKind

    var body: some View {
        Label(provider.displayName, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var icon: String {
        switch provider {
        case .claude: "sparkle"
        case .claudeWork: "briefcase.fill"
        case .claudex: "arrow.triangle.branch"
        case .claudeSynthero: "link"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .cursor: "cursorarrow"
        case .grok: "bolt"
        case .fugu: "fish"
        case .opencode: "shippingbox"
        }
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
        case .waitingApproval: return "Needs approval"
        case .backgroundWork: return "Background work"
        case .error: return "Error"
        case .archived: return "Archived"
        }
    }

    private var icon: String {
        if stalled { return "exclamationmark.circle" }
        switch status {
        case .idle: return "circle"
        case .running: return "bolt.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .backgroundWork: return "person.2.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        }
    }

    private var color: Color {
        if stalled { return .orange }
        switch status {
        case .idle: return .secondary
        case .running: return .accentColor
        case .waitingApproval: return .orange
        case .backgroundWork: return .green
        case .error: return .red
        case .archived: return .secondary
        }
    }
}
