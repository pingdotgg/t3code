import Foundation

enum PlatformCloudRegistrationStatus: Equatable {
    case idle
    case signedOut
    case registering
    case registered
    case failed(String)
    case unavailable(String)
}

@MainActor
protocol PlatformCloudDeliveryRegistering: AnyObject {
    var cloudDeliveryAccountID: String? { get }
    var unavailableReason: String? { get }
    func rememberRegisteredDevice(id: String)
    func registerDevice(_ registration: T3ConnectDeviceRegistration) async throws
    func registerLiveActivity(_ registration: T3ConnectLiveActivityRegistration) async throws
}

@MainActor
protocol PlatformLiveActivitySettingUp: PlatformCloudDeliveryRegistering {
    func setUpLiveActivityUpdates(
        environments: [T3ConnectLocalEnvironment], enabled: Bool, previousEnabled: Bool,
        deviceID: String,
        makeDeviceRegistration: @escaping @MainActor (Bool) -> T3ConnectDeviceRegistration
    ) async throws
}

extension T3ConnectController: PlatformLiveActivitySettingUp {
    var cloudDeliveryAccountID: String? { account?.id }
}
