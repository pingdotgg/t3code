import SwiftUI

public struct PermissionNoticeEnvironment: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let permissions: EnvironmentPermissionState?

    public init(id: String, label: String, permissions: EnvironmentPermissionState?) {
        self.id = id
        self.label = label
        self.permissions = permissions
    }
}

/// Mount once in the root view. Each affected environment is shown until
/// dismissed, with dismissal retained across launches.
public struct PermissionUpdateNotice: View {
    public let environments: [PermissionNoticeEnvironment]
    @AppStorage("t3code.permission-update.v1") private var dismissedData = Data()

    public init(environments: [PermissionNoticeEnvironment]) {
        self.environments = environments
    }

    private var dismissed: Set<String> {
        (try? JSONDecoder().decode(Set<String>.self, from: dismissedData)) ?? []
    }

    public var body: some View {
        if let environment = environments.first(where: {
            $0.permissions?.hasLegacyPermissions == true && !dismissed.contains($0.id)
        }) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Permissions have changed for \(environment.label)")
                    .font(T3Typography.supportingStrong)
                Text("Some actions need new permissions. Pair again using a new link with the permissions you need.")
                    .font(T3Typography.supporting)
                Button("Got it") {
                    var ids = dismissed
                    ids.insert(environment.id)
                    if let data = try? JSONEncoder().encode(ids) { dismissedData = data }
                }
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .accessibilityLabel("Dismiss permission notice for \(environment.label)")
            }
            .foregroundStyle(T3Colors.textPrimary)
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T3Colors.background)
            .accessibilityIdentifier("permission-update-\(environment.id)")
        }
    }
}
