import SwiftUI

/// Inline approval prompt rendered as a timeline item. This is chrome (an
/// interactive control), not reading content, so it's one of the few things
/// inside the timeline allowed to sit on Liquid Glass.
public struct ApprovalCard: View {
    let request: ApprovalRequest
    /// Whether this is the most-recent pending approval in the thread's
    /// timeline. Only that one card gets the keyboard shortcuts below —
    /// see the scheme rationale on `approveShortcut`/`denyShortcut`.
    let isActive: Bool
    let onRespond: (Bool) -> Void

    public init(request: ApprovalRequest, isActive: Bool, onRespond: @escaping (Bool) -> Void) {
        self.request = request
        self.isActive = isActive
        self.onRespond = onRespond
    }

    /// The composer's own send shortcut (Command-Return, ComposerBar.swift)
    /// stays enabled even while a turn is blocked on approval — a queued
    /// follow-up message is still valid to type — so these use combinations
    /// Command-Return (and Option-Return, its queue variant) can never
    /// collide with. Command-Escape was considered for deny but macOS
    /// reserves it for Force Quit before any app ever sees the event.
    private static let approveShortcut = KeyboardShortcut(.return, modifiers: [.command, .shift])
    private static let denyShortcut = KeyboardShortcut(.delete, modifiers: .command)

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
                .keyboardShortcut(isActive ? Self.denyShortcut : nil)
                .help(isActive ? "Deny (⌘⌫)" : "Deny")

                Button("Approve") {
                    onRespond(true)
                }
                .buttonStyle(.glass)
                .tint(AlpineTheme.meadow)
                .keyboardShortcut(isActive ? Self.approveShortcut : nil)
                .help(isActive ? "Approve (⌘⇧⏎)" : "Approve")
            }
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card))
    }

    private var icon: String {
        switch request.kind {
        case .command: "terminal"
        case .fileEdit: "pencil"
        case .other: "questionmark.circle"
        }
    }
}
