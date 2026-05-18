import Foundation

struct MobileInitialSyncResult: Sendable {
    let session: MobileSyncSession
    let environment: MobileEnvironment
    let shellState: MobileShellState
    let shellSubscription: MobileStreamSubscription
}
