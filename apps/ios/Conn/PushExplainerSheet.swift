import SwiftUI

/// Shown once, at the first thread start or send after Orbit sign-in, before the system
/// permission prompt (#229, section 4).
struct PushExplainerSheet: View {
    let onTurnOn: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bell.badge")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.tint)
                .padding(.top, 28)
            Text("Get told when an agent needs you")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("Conn can notify you when a thread asks for approval or an answer, and when a turn finishes or fails. Tap a notification to open the thread.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button(action: onTurnOn) {
                Text("Turn on notifications")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button("Not now", action: onNotNow)
                .buttonStyle(.borderless)
                .padding(.bottom, 8)
        }
        .padding(.horizontal, 24)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}
