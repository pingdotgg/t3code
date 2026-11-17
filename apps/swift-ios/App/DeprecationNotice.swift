import SwiftUI

/// This SwiftUI build is retired in favor of the T3 Code app on the App Store.
/// The notice opens on every launch; "Not now" hides it until the next launch,
/// so people can still finish work here while they move over.
enum AppDeprecation {
    static let appStoreURL = URL(string: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824")!
}

struct DeprecationNotice: View {
    @SwiftUI.Environment(\.openURL) private var openURL
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text("This app is no longer supported")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(T3Colors.textPrimary)
            Text("T3 Code is now on the App Store. Get it there for new features and fixes. This test build will stop getting updates.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
            Text("Pair your computer again in the new app. Your threads stay on your computer.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
            Spacer()
            Button {
                openURL(AppDeprecation.appStoreURL)
            } label: {
                Text("Get T3 Code on the App Store")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(T3Colors.primaryAction)
            .foregroundStyle(T3Colors.primaryActionForeground)
            .accessibilityIdentifier("deprecation-open-app-store")
            Button("Not now", action: onDismiss)
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("deprecation-dismiss")
        }
        .padding(24)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background.ignoresSafeArea())
        .interactiveDismissDisabled()
    }
}
