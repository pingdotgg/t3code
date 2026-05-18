import SwiftUI

struct MobileActivityRowView: View {
    let activity: MobileThreadActivity
    let isResponded: Bool
    let isResponding: Bool
    var onApprove: ((String, String) -> Void)?
    var onUserInput: ((String, String) -> Void)?
    @State private var userInputText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text(activity.summary)
                        .font(.callout)
                    Text(activity.kind)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: iconName)
                    .foregroundStyle(iconColor)
            }

            if isResponded {
                Label("Response sent", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if activity.interactionKind == .approvalRequest, let requestID = activity.requestID {
                HStack {
                    Button("Approve") {
                        onApprove?(requestID, "accept")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isResponding)
                    Button("Deny") {
                        onApprove?(requestID, "reject")
                    }
                    .buttonStyle(.bordered)
                    .disabled(isResponding)
                }
            } else if activity.interactionKind == .userInputRequest, let requestID = activity.requestID {
                HStack {
                    TextField("Response", text: $userInputText)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") {
                        onUserInput?(requestID, userInputText)
                        userInputText = ""
                    }
                    .disabled(isResponding || userInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemBackground).opacity(0.85), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var iconName: String {
        switch activity.tone {
        case "approval":
            "checkmark.seal"
        case "error":
            "exclamationmark.triangle"
        case "tool":
            "terminal"
        default:
            "info.circle"
        }
    }

    private var iconColor: Color {
        activity.tone == "error" ? .red : .secondary
    }
}

#Preview {
    MobileActivityRowView(activity: MobilePreviewData.threadDetail.activities[0], isResponded: false, isResponding: false)
        .padding()
}
