import SwiftUI

/// Top chrome bar: thread title, provider + status badges, cancel control.
/// Transparent — it sits directly on the thread's `SceneryChatBackground`
/// wallpaper (which darkens toward the top for exactly this text).
struct ChatHeaderView: View {
    let thread: ChatThread
    let model: AppModel
    let scenery: SceneryStore

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title)
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 10) {
                    ProviderBadge(provider: thread.provider)
                    StatusBadge(status: thread.status)
                }
            }

            Spacer()

            if let photo = scenery.photo(for: thread.id) {
                SceneryAttributionTag(photo: photo)
            }

            if thread.status == .running {
                Button(role: .destructive) {
                    Task { await model.cancelCurrentTurn() }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .buttonStyle(.glass)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .cursor: "cursorarrow"
        case .opencode: "shippingbox"
        }
    }
}

private struct StatusBadge: View {
    let status: ThreadStatus

    var body: some View {
        Label(text, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(color)
    }

    private var text: String {
        switch status {
        case .idle: "Idle"
        case .running: "Running"
        case .waitingApproval: "Needs approval"
        case .error: "Error"
        case .archived: "Archived"
        }
    }

    private var icon: String {
        switch status {
        case .idle: "circle"
        case .running: "bolt.fill"
        case .waitingApproval: "exclamationmark.circle.fill"
        case .error: "xmark.octagon.fill"
        case .archived: "archivebox.fill"
        }
    }

    private var color: Color {
        switch status {
        case .idle: .secondary
        case .running: .accentColor
        case .waitingApproval: .orange
        case .error: .red
        case .archived: .secondary
        }
    }
}
