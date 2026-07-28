import SwiftUI

/// Inline approval prompt rendered as a timeline item — the customs
/// checkpoint of a thread: the one place where work genuinely stops until
/// the user stamps a decision. This is chrome (an interactive control), not
/// reading content, so it's one of the few things inside the timeline
/// allowed to sit on Liquid Glass.
///
/// The card reads as a manifest: what kind of authority is requested, the
/// exact request, then three stamps — deny, approve once, or approve for
/// the rest of the session (the standing declaration that stops repeat
/// prompts for similar requests).
public struct ApprovalCard: View {
    let request: ApprovalRequest
    /// Whether this is the most-recent pending approval in the thread's
    /// timeline. Only that one card gets the keyboard shortcuts below —
    /// see the scheme rationale on `approveShortcut`/`denyShortcut`.
    let isActive: Bool
    /// True after a decision was sent and before the provider acknowledges it.
    /// The action row keeps its exact geometry and crossfades to progress so
    /// the card cannot jump or accept the same decision twice.
    let isResponding: Bool
    let onRespond: (ApprovalDecision) -> Void

    public init(
        request: ApprovalRequest, isActive: Bool, isResponding: Bool = false,
        onRespond: @escaping (ApprovalDecision) -> Void
    ) {
        self.request = request
        self.isActive = isActive
        self.isResponding = isResponding
        self.onRespond = onRespond
    }

    /// The composer's own send shortcut (Command-Return, ComposerBar.swift)
    /// stays enabled even while a turn is blocked on approval — a queued
    /// follow-up message is still valid to type — so these use combinations
    /// Command-Return (and Option-Return, its queue variant) can never
    /// collide with. Command-Escape was considered for deny but macOS
    /// reserves it for Force Quit before any app ever sees the event.
    /// Approve-for-session deliberately has no shortcut: a standing grant
    /// deserves a pointer's worth of deliberation.
    private static let approveShortcut = KeyboardShortcut(.return, modifiers: [.command, .shift])
    private static let denyShortcut = KeyboardShortcut(.delete, modifiers: .command)

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(request.title, systemImage: icon)
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Text(request.kind.displayName)
                    .font(SurgeTypography.technicalMetadata)
                    .foregroundStyle(.secondary)
            }

            if !request.detail.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(request.detail)
                        .font(SurgeTypography.toolPayload)
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                // The command/diff detail is reading content even inside a
                // glass card, so it gets the same opaque treatment as code
                // blocks in assistant messages.
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }

            actionRow
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card))
        // The timeline suppresses ambient layout animation while a turn is
        // live. Re-arm this fixed-geometry opacity swap downstream so a click
        // still gets immediate visual acknowledgement without remeasuring the
        // transcript.
        .animation(Motion.reveal, value: isResponding)
        // An approval prompt interrupts the user mid-read, so it is the one
        // surface that most needs to announce itself rather than blink into
        // the transcript. Arrival is owned by the timeline ForEach's
        // `.entrance(.row)` — a second `.entrance(.card)` here doubled the
        // travel and multiplied the opacity/scale.
    }

    private var icon: String {
        switch request.kind {
        case .command: "terminal"
        case .fileEdit: "pencil"
        case .fileRead: "doc.text"
        case .other: "questionmark.circle"
        }
    }

    private var actionRow: some View {
        ZStack(alignment: .trailing) {
            HStack {
                Spacer()
                Button("Deny", role: .cancel) {
                    Haptics.play(.decision)
                    onRespond(.deny)
                }
                .buttonStyle(.glass)
                .keyboardShortcut(isActive ? Self.denyShortcut : nil)
                .help(isActive ? "Deny (⌘⌫)" : "Deny")

                Button("Approve for Session") {
                    Haptics.play(.decision)
                    onRespond(.approveForSession)
                }
                .buttonStyle(.glass)
                .help("Approve and stop asking for similar requests this session")

                Button("Approve") {
                    // Approve and deny both hand real authority to the agent,
                    // and both have keyboard shortcuts — the firmer level-change
                    // tap confirms the keystroke landed on this card.
                    Haptics.play(.decision)
                    onRespond(.approve)
                }
                .buttonStyle(.glass)
                .tint(AlpineTheme.meadow)
                .keyboardShortcut(isActive ? Self.approveShortcut : nil)
                .help(isActive ? "Approve (⌘⇧⏎)" : "Approve")
            }
            .disabled(isResponding)
            .opacity(isResponding ? 0 : 1)
            .accessibilityHidden(isResponding)

            Label("Submitting decision…", systemImage: "arrow.up.circle")
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
                .opacity(isResponding ? 1 : 0)
                .accessibilityHidden(!isResponding)
        }
    }
}
