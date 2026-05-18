import SwiftUI

struct ThreadRowView: View {
    let thread: MobileThread

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(thread.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Label(thread.status, systemImage: statusIcon)
                    .labelStyle(.iconOnly)
                    .foregroundStyle(statusColor)
                    .accessibilityLabel(thread.status)
            }
            Text(thread.latestSummary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 6) {
                Capsule()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                Text(thread.status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var statusIcon: String {
        switch thread.status.lowercased() {
        case "running", "starting":
            "bolt.circle"
        case "approval", "input", "plan":
            "exclamationmark.circle"
        case "error":
            "exclamationmark.triangle"
        default:
            "checkmark.circle"
        }
    }

    private var statusColor: Color {
        switch thread.status.lowercased() {
        case "running", "starting":
            .blue
        case "approval", "input", "plan":
            .orange
        case "error":
            .red
        default:
            .green
        }
    }
}

#Preview {
    List {
        ThreadRowView(thread: MobilePreviewData.threads[0])
    }
}
