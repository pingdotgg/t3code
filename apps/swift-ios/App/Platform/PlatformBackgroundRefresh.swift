import BackgroundTasks
import Foundation

@MainActor
final class PlatformBackgroundRefreshCoordinator {
    typealias RefreshAction = @MainActor @Sendable () async -> Bool

    static let shared = PlatformBackgroundRefreshCoordinator()
    static var identifier: String {
        "\(Bundle.main.bundleIdentifier ?? "com.t3tools.t3code.swiftui").refresh"
    }

    private var refreshAction: RefreshAction?
    private var isRegistered = false

    func install(refreshAction: @escaping RefreshAction) {
        self.refreshAction = refreshAction
    }

    func register() {
        guard !isRegistered else { return }
        isRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.identifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await Self.shared.handle(refreshTask)
            }
        }
    }

    func schedule() {
        guard isRegistered else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date().addingTimeInterval(
            PlatformBackgroundRefreshPolicy.minimumDelay
        )
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handle(_ task: BGAppRefreshTask) async {
        schedule()
        guard let refreshAction else {
            task.setTaskCompleted(success: false)
            return
        }

        // Install cancellation before creating the operation. If expiration
        // wins the race, `install` immediately cancels the new task.
        let cancellation = PlatformBackgroundRefreshCancellation()
        task.expirationHandler = {
            cancellation.cancel()
        }
        let operation = Task { @MainActor in
            await refreshAction()
        }
        cancellation.install(operation)
        let succeeded = await operation.value
        task.setTaskCompleted(success: succeeded && !operation.isCancelled)
    }
}

private final class PlatformBackgroundRefreshCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var operation: Task<Bool, Never>?
    private var didExpire = false

    func install(_ operation: Task<Bool, Never>) {
        let shouldCancel = lock.withLock {
            self.operation = operation
            return didExpire
        }
        if shouldCancel { operation.cancel() }
    }

    func cancel() {
        let operation = lock.withLock {
            didExpire = true
            return self.operation
        }
        operation?.cancel()
    }
}

enum PlatformBackgroundRefreshPolicy {
    /// iOS chooses the actual cadence. Fifteen minutes is merely the earliest
    /// useful retry and avoids repeatedly asking the scheduler for immediate work.
    static let minimumDelay: TimeInterval = 15 * 60
}
