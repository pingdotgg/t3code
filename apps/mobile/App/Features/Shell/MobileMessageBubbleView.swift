import SwiftUI

struct MobileMessageBubbleView: View {
    let message: MobileChatMessage
    @State private var isExpanded = false

    private var isUser: Bool {
        message.role == "user"
    }

    private var visibleText: String {
        guard shouldCollapse, !isExpanded else {
            return message.text
        }
        return message.text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .prefix(80)
            .joined(separator: "\n")
    }

    private var shouldCollapse: Bool {
        let lineCount = message.text.split(separator: "\n", omittingEmptySubsequences: false).count
        return lineCount > 80 || message.text.count > 6_000
    }

    var body: some View {
        HStack(alignment: .top) {
            if isUser {
                Spacer(minLength: 44)
            }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(message.role.capitalized)
                    if message.streaming {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

                Text(visibleText.isEmpty ? " " : visibleText)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)

                if shouldCollapse {
                    Button(isExpanded ? "Show less" : "Show more") {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isExpanded.toggle()
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tint)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(backgroundStyle, in: RoundedRectangle(cornerRadius: MobileDesign.cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MobileDesign.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06))
            }
            if !isUser {
                Spacer(minLength: 44)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var backgroundStyle: some ShapeStyle {
        isUser ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground).opacity(0.92)
    }
}

#Preview {
    VStack {
        MobileMessageBubbleView(message: MobilePreviewData.threadDetail.messages[0])
        MobileMessageBubbleView(message: MobilePreviewData.threadDetail.messages[1])
    }
    .padding()
}
