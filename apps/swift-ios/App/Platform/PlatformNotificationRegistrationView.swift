import SwiftUI
import ActivityKit
import UserNotifications

/// Mount beside notification preferences. A preference alone is not proof that
/// APNs or the account relay has accepted this installation.
struct PlatformNotificationRegistrationView: View {
    let settings: FeatureSettings
    private let notifications = PlatformNotificationService.shared
    private let delivery = PlatformCloudDeliveryCoordinator.shared
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var liveActivitiesAllowed = ActivityAuthorizationInfo().areActivitiesEnabled

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if notifications.permissionStatus == .denied {
                Text("Notifications are blocked in iOS Settings.")
                systemSettingsButton
            } else if settings.notificationsEnabled, let error = notifications.remoteRegistrationError {
                Text("Apple notification registration failed: \(error)").foregroundStyle(T3Colors.danger)
                retryButton
            } else if settings.notificationsEnabled, !notifications.hasRemoteToken {
                Text("Waiting for Apple notification registration.")
                retryButton
            }
            if settings.liveActivitiesEnabled, !liveActivitiesAllowed {
                Text("Live Activities are blocked in iOS Settings.")
                systemSettingsButton
            }
            switch delivery.registrationStatus {
            case .idle:
                if settings.notificationsEnabled || settings.liveActivitiesEnabled {
                    Text("Remote delivery is not registered.")
                    retryButton
                }
            case .signedOut:
                Text("Sign in to T3 Connect for remote delivery.")
            case .registering:
                Text("Registering remote delivery…")
            case .registered:
                Text("Remote delivery registered.")
            case let .failed(error):
                Text("Remote registration failed: \(error)").foregroundStyle(T3Colors.danger)
                retryButton
            case let .unavailable(reason):
                Text(reason)
            }
        }
        .font(T3Typography.supporting)
        .task { await notifications.refreshPermissionStatus() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                liveActivitiesAllowed = ActivityAuthorizationInfo().areActivitiesEnabled
                Task { await notifications.refreshPermissionStatus() }
            }
        }
    }

    private var systemSettingsButton: some View {
        Button("Open iOS Settings") {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
    }

    private var retryButton: some View {
        Button("Retry registration") {
            Task { @MainActor in
                if settings.notificationsEnabled {
                    _ = await notifications.requestAuthorization()
                }
                await delivery.retryRegistration()
            }
        }
        .disabled(delivery.isSettingUpLiveActivities)
    }
}
