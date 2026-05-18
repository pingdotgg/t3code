import SwiftUI

struct MobileThreadHeaderView: View {
    let thread: MobileThread
    let detail: MobileThreadDetail?
    let state: MobileConnectionState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(state.summary, systemImage: state == .connected ? "checkmark.circle" : "arrow.trianglehead.2.clockwise")
                if let detail {
                    Text("•")
                    Text("\(detail.messages.count) messages")
                    Text("•")
                    Text(detail.sessionStatus)
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        if let detail {
            return "\(thread.title), \(state.summary), \(detail.messages.count) messages, \(detail.sessionStatus)"
        }
        return "\(thread.title), \(state.summary)"
    }
}

#Preview {
    MobileThreadHeaderView(thread: MobilePreviewData.threads[0], detail: MobilePreviewData.threadDetail, state: .connected)
        .padding()
}
