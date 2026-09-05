import SwiftUI

public struct FeatureRootView: View {
    @State private var model: FeatureRootModel
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void

    public init(client: any FeatureClient) {
        _model = State(initialValue: FeatureRootModel(client: client))
        navigationRequest = nil
        onNavigationRequestConsumed = { _ in }
    }

    init(
        model: FeatureRootModel,
        navigationRequest: FeatureWorkspaceNavigationRequest? = nil,
        onNavigationRequestConsumed: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        _model = State(initialValue: model)
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
    }

    public var body: some View {
        Group {
            if model.isLoading {
                FeatureLoadingView()
            } else if shouldShowWorkspace {
                WorkspaceView(
                    model: model,
                    navigationRequest: navigationRequest,
                    onNavigationRequestConsumed: onNavigationRequestConsumed,
                    submitNewTask: { request in
                        await model.startTask(request)
                    },
                    submitMessage: { submission in
                        await model.sendMessage(submission)
                    }
                )
            } else {
                ConnectionOnboardingView(model: model)
            }
        }
        .preferredColorScheme(preferredColorScheme)
        .tint(T3Colors.accent)
        .background(T3Colors.background.ignoresSafeArea())
        .task { await model.start() }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            ),
            actions: {
                Button("OK") { model.errorMessage = nil }
            },
            message: {
                Text(model.errorMessage ?? "Unknown error")
            }
        )
    }

    /// Keep the last-known workspace visible through a degraded connection.
    /// Connection management also stays mounted while saved servers are being
    /// removed, so a disconnected fallback cannot destroy its own Settings sheet.
    private var shouldShowWorkspace: Bool {
        FeatureRootPresentation.showsWorkspace(
            snapshot: model.snapshot,
            isManagingConnections: model.isManagingConnections
        )
    }

    private var preferredColorScheme: ColorScheme? {
        switch model.snapshot.settings.appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum FeatureRootPresentation {
    static func showsWorkspace(
        snapshot: FeatureSnapshot,
        isManagingConnections: Bool
    ) -> Bool {
        isManagingConnections
            || !snapshot.environments.isEmpty
            || !snapshot.projects.isEmpty
            || !snapshot.threads.isEmpty
    }
}

private struct FeatureLoadingView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 30, weight: .semibold))
            ProgressView()
                .controlSize(.small)
            Text("Connecting to T3 Code")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
    }
}
