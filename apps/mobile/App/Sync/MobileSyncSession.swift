import Foundation
import T3MobileProtocol

struct MobileSyncSession: Sendable {
    let descriptor: MobileDescriptorResult
    let bearerSessionToken: String
    let webSocketToken: MobileWebSocketToken
    let serverCapabilities: Set<MobileServerCapability>
    let webSocket: MobileWebSocketClient

    func supports(_ capability: MobileServerCapability) -> Bool {
        serverCapabilities.contains(capability)
    }

    func require(_ capability: MobileServerCapability) throws {
        guard supports(capability) else {
            throw MobileSyncError.missingCapability(capability.rawValue)
        }
    }
}
