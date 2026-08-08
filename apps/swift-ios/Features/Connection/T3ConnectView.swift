import ClerkKit
import ClerkKitUI
import SwiftUI

public struct T3ConnectView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var controller: T3ConnectController
    @State private var isAuthPresented = false
    @State private var didFinishInitialRefresh = false
    private let connectEnvironment:
        @MainActor (T3ConnectManagedEnvironmentCredential) async throws -> Void
    private let signOut: @MainActor () async -> Void
    private let onConnected: @MainActor () async -> Void

    public init(
        capability: any T3ConnectCapable,
        onConnected: @escaping @MainActor () async -> Void = {}
    ) {
        controller = capability.t3ConnectController
        connectEnvironment = capability.connectT3Environment
        signOut = capability.signOutT3Connect
        self.onConnected = onConnected
    }

    public var body: some View {
        content
            .navigationTitle("T3 Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if controller.account != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Sign out", role: .destructive) {
                            Task { await signOut() }
                        }
                        .disabled(controller.isRefreshing)
                    }
                }
            }
            .refreshable {
                await controller.refresh()
            }
            .task {
                await controller.refresh()
                didFinishInitialRefresh = true
                presentAuthenticationIfNeeded()
            }
            .onChange(of: controller.account?.id) { _, accountID in
                guard didFinishInitialRefresh,
                      accountID == nil,
                      controller.unavailableReason == nil else { return }
                isAuthPresented = true
            }
            .fullScreenCover(
                isPresented: $isAuthPresented,
                onDismiss: handleAuthenticationDismissal
            ) {
                authenticationView
            }
            .alert(
                "T3 Connect",
                isPresented: Binding(
                    get: { controller.errorMessage != nil },
                    set: { if !$0 { controller.errorMessage = nil } }
                )
            ) {
                Button("OK") { controller.errorMessage = nil }
            } message: {
                Text(controller.errorMessage ?? "Something went wrong.")
            }
    }

    @ViewBuilder
    private var content: some View {
        if let reason = controller.unavailableReason {
            connectList {
                unavailableSection(reason)
            }
        } else if let account = controller.account {
            connectList {
                accountSection(account)
                environmentSection
            }
        } else {
            ZStack {
                T3Colors.background.ignoresSafeArea()
                ProgressView()
                    .tint(T3Colors.textPrimary)
            }
        }
    }

    private func connectList<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        List {
            content()
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
    }

    @ViewBuilder
    private var authenticationView: some View {
        if let clerk = controller.clerk {
            T3ConnectAuthenticationView {
                await controller.refresh()
                if controller.account != nil {
                    isAuthPresented = false
                    return true
                }
                return false
            }
                .environment(\.clerkTheme, T3ConnectClerkAppearance.theme)
                .environment(clerk)
        } else {
            ZStack {
                T3Colors.background.ignoresSafeArea()
                ProgressView()
                    .tint(T3Colors.textPrimary)
            }
        }
    }

    private func presentAuthenticationIfNeeded() {
        guard controller.unavailableReason == nil,
              controller.account == nil else { return }
        isAuthPresented = true
    }

    private func handleAuthenticationDismissal() {
        Task {
            await controller.refresh()
            if controller.account == nil {
                dismiss()
            }
        }
    }

    private func unavailableSection(_ reason: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Label("Unavailable in this build", systemImage: "cloud.slash")
                    .font(T3Typography.homeTitle)
                Text(reason)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textSecondary)
                Text("Direct and local connections still work without an account.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.vertical, 8)
            .listRowBackground(T3Colors.background)
        }
    }

    private func accountSection(_ account: T3ConnectAccount) -> some View {
        Section("Account") {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(T3Colors.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.email ?? "T3 account")
                        .font(T3Typography.homeTitle)
                    Text("Signed in")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .padding(.vertical, 3)
            .listRowBackground(T3Colors.background)
        }
    }

    private var environmentSection: some View {
        Section("Cloud environments") {
            if controller.environments.isEmpty, !controller.isRefreshing {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No linked environments")
                        .font(T3Typography.homeTitle)
                    Text("Link an environment from T3 Code on desktop, then pull to refresh.")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .padding(.vertical, 8)
                .listRowBackground(T3Colors.background)
            }

            ForEach(controller.environments) { item in
                environmentRow(item)
                    .listRowBackground(T3Colors.background)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await controller.unlink(item.environment) }
                        } label: {
                            Label("Unlink", systemImage: "link.badge.minus")
                        }
                    }
            }

            if controller.isRefreshing {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Refreshing environments…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .listRowBackground(T3Colors.background)
            }
        }
    }

    private func environmentRow(_ item: T3ConnectCloudEnvironment) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor(item))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.environment.label)
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text(statusText(item))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button {
                Task { await handleConnect(item.environment) }
            } label: {
                if controller.busyEnvironmentID == item.id {
                    ProgressView()
                        .frame(width: 54)
                } else {
                    Text("Connect")
                        .font(T3Typography.supportingStrong)
                }
            }
            .buttonStyle(.borderless)
            .disabled(controller.busyEnvironmentID != nil || item.status?.status == .offline)
        }
        .padding(.vertical, 5)
    }

    private func handleConnect(_ environment: T3ConnectRelayEnvironment) async {
        do {
            let credential = try await controller.credential(for: environment)
            try await connectEnvironment(credential)
            await onConnected()
        } catch {
            controller.errorMessage = error.localizedDescription
        }
    }

    private func statusText(_ item: T3ConnectCloudEnvironment) -> String {
        if let error = item.statusError { return error }
        switch item.status?.status {
        case .online: return "Online"
        case .offline: return item.status?.error ?? "Offline"
        case nil: return "Checking…"
        }
    }

    private func statusColor(_ item: T3ConnectCloudEnvironment) -> Color {
        switch item.status?.status {
        case .online: T3Colors.success
        case .offline: T3Colors.danger
        case nil: T3Colors.textTertiary
        }
    }
}

@MainActor
private struct T3ConnectAuthenticationView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(Clerk.self) private var clerk
    @State private var activeProvider: OAuthProvider?
    @State private var errorMessage: String?
    @State private var isEmailPresented = false

    private let onAuthenticationChanged: @MainActor () async -> Bool
    private let preferredProviders: [OAuthProvider] = [
        .apple,
        .github,
        .google,
        .microsoft,
    ]

    init(
        onAuthenticationChanged: @escaping @MainActor () async -> Bool
    ) {
        self.onAuthenticationChanged = onAuthenticationChanged
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    brand
                        .padding(.bottom, 38)

                    Text("Continue to T3 Code")
                        .font(.system(.largeTitle, design: .default, weight: .bold))
                        .foregroundStyle(T3Colors.textPrimary)
                        .padding(.bottom, 10)

                    Text("Sign in to reach your environments from anywhere.")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 34)

                    providerButtons

                    emailButton
                        .padding(.top, 24)
                }
                .frame(maxWidth: 440, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 34)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(T3Colors.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(T3Colors.textSecondary)
                            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .task {
            if clerk.environment == nil {
                _ = try? await clerk.refreshEnvironment()
            }
        }
        .sheet(isPresented: $isEmailPresented, onDismiss: authenticationDidFinish) {
            AuthView(mode: .signInOrUp)
                .prefetchClerkImages()
                .environment(\.clerkTheme, T3ConnectClerkAppearance.theme)
                .environment(clerk)
        }
        .alert(
            "Couldn’t sign in",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Please try again.")
        }
    }

    private var brand: some View {
        HStack(spacing: 10) {
            Text("T3")
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .foregroundStyle(T3Colors.primaryActionForeground)
                .frame(width: 32, height: 32)
                .background(T3Colors.primaryAction)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            Text("T3 Connect")
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var providerButtons: some View {
        if clerk.environment == nil {
            HStack(spacing: 10) {
                ProgressView()
                    .tint(T3Colors.textPrimary)
                Text("Loading sign-in options…")
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
        } else {
            VStack(spacing: 12) {
                ForEach(availableProviders) { provider in
                    providerButton(provider)
                }
            }
        }
    }

    private func providerButton(_ provider: OAuthProvider) -> some View {
        Button {
            Task { await signIn(with: provider) }
        } label: {
            HStack(spacing: 12) {
                T3ConnectAuthProviderIcon(provider: provider)
                    .frame(width: 22, height: 22)

                Text("Continue with \(provider.name)")
                    .font(.system(.body, design: .default, weight: .semibold))
                    .foregroundStyle(T3Colors.textPrimary)

                Spacer(minLength: 8)

                if activeProvider == provider {
                    ProgressView()
                        .tint(T3Colors.textPrimary)
                }
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(T3Colors.surfaceRaised)
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(T3Colors.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(activeProvider != nil)
        .opacity(activeProvider == nil || activeProvider == provider ? 1 : 0.55)
        .accessibilityIdentifier("t3-connect-auth-\(provider.strategy)")
    }

    private var emailButton: some View {
        Button {
            isEmailPresented = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "envelope")
                    .font(.system(size: 15, weight: .medium))
                Text("Use email instead")
                    .font(T3Typography.control)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var availableProviders: [OAuthProvider] {
        guard let environment = clerk.environment else { return [] }
        let enabledStrategies = Set(
            environment.userSettings.social.values
                .filter { $0.enabled && $0.authenticatable }
                .map(\.strategy)
        )
        return preferredProviders.filter { enabledStrategies.contains($0.strategy) }
    }

    private func signIn(with provider: OAuthProvider) async {
        activeProvider = provider
        defer { activeProvider = nil }

        do {
            if provider == .apple {
                try await clerk.auth.signInWithApple()
            } else {
                try await clerk.auth.signInWithOAuth(provider: provider)
            }

            if !(await onAuthenticationChanged()) {
                isEmailPresented = true
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func authenticationDidFinish() {
        Task { _ = await onAuthenticationChanged() }
    }
}

private struct T3ConnectAuthProviderIcon: View {
    let provider: OAuthProvider

    @ViewBuilder
    var body: some View {
        switch provider {
        case .apple:
            Image(systemName: "apple.logo")
                .resizable()
                .scaledToFit()
                .foregroundStyle(T3Colors.textPrimary)
        case .github:
            Image("AuthGitHub")
                .resizable()
                .scaledToFit()
        case .google:
            Image("AuthGoogle")
                .resizable()
                .scaledToFit()
        case .microsoft:
            Image("AuthMicrosoft")
                .resizable()
                .scaledToFit()
        default:
            Image(systemName: "person.crop.circle")
                .resizable()
                .scaledToFit()
                .foregroundStyle(T3Colors.textPrimary)
        }
    }
}

@MainActor
private enum T3ConnectClerkAppearance {
    static let theme = ClerkTheme(
        colors: .init(
            primary: T3Colors.primaryAction,
            background: T3Colors.background,
            input: T3Colors.input,
            danger: T3Colors.danger,
            success: T3Colors.success,
            warning: T3Colors.warning,
            foreground: T3Colors.textPrimary,
            mutedForeground: T3Colors.textSecondary,
            primaryForeground: T3Colors.primaryActionForeground,
            inputForeground: T3Colors.textPrimary,
            neutral: T3Colors.textPrimary,
            ring: T3Colors.textPrimary,
            muted: T3Colors.surfaceRaised,
            shadow: T3Colors.border,
            border: T3Colors.border
        ),
        design: .init(borderRadius: 12)
    )
}
