import SwiftUI

/// Inline approval prompt rendered as a timeline item. This is chrome (an
/// interactive control), not reading content, so it's one of the few things
/// inside the timeline allowed to sit on Liquid Glass.
public struct ApprovalCard: View {
    let request: ApprovalRequest
    let onRespond: (Bool) -> Void

    public init(request: ApprovalRequest, onRespond: @escaping (Bool) -> Void) {
        self.request = request
        self.onRespond = onRespond
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(request.title, systemImage: icon)
                .font(.callout.weight(.semibold))

            if !request.detail.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(request.detail)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                // The command/diff detail is reading content even inside a
                // glass card, so it gets the same opaque treatment as code
                // blocks in assistant messages.
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                Spacer()
                Button("Deny", role: .cancel) {
                    onRespond(false)
                }
                .buttonStyle(.glass)

                Button("Approve") {
                    onRespond(true)
                }
                .buttonStyle(.glass)
                .tint(.green)
            }
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }

    private var icon: String {
        switch request.kind {
        case .command: "terminal"
        case .fileEdit: "pencil"
        case .other: "questionmark.circle"
        }
    }
}
