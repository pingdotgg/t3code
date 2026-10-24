import Foundation

struct PlatformLiveActivitySetupError: LocalizedError {
    let operation: String
    let rollbackFailures: [String]

    var errorDescription: String? {
        guard !rollbackFailures.isEmpty else { return operation }
        return operation + " Could not restore all previous settings: " + rollbackFailures.joined(separator: "; ")
    }
}

/// Enrollment compensates partial failures. Disabling is best effort across the
/// device and selected linked hosts and must never turn a successful disable on
/// again. The caller validates the account before every write.
@MainActor
enum PlatformLiveActivitySetupTransaction {
    static func run(
        environmentIDs: [String], enabled: Bool, previousEnabled: Bool,
        validateAccount: @escaping @MainActor () throws -> Void,
        updateDevice: @escaping @MainActor (Bool) async throws -> Void,
        linkEnvironment: @escaping @MainActor (String, Bool) async throws -> Void
    ) async throws {
        if !enabled {
            var failures: [String] = []
            do {
                try validateAccount()
                try await updateDevice(false)
            } catch { failures.append("device: \(error.localizedDescription)") }
            for id in environmentIDs {
                do {
                    try validateAccount()
                    try await linkEnvironment(id, false)
                } catch { failures.append("\(id): \(error.localizedDescription)") }
            }
            do { try validateAccount() }
            catch { failures.append(error.localizedDescription) }
            guard failures.isEmpty else {
                throw PlatformLiveActivitySetupError(
                    operation: "Could not disable all remote updates: " + failures.joined(separator: "; "),
                    rollbackFailures: []
                )
            }
            return
        }
        var attempted: [String] = []
        var attemptedDevice = false
        do {
            try validateAccount()
            try Task.checkCancellation()
            attemptedDevice = true
            try await updateDevice(enabled)
            for id in environmentIDs {
                try validateAccount()
                try Task.checkCancellation()
                attempted.append(id)
                try await linkEnvironment(id, enabled)
            }
            try validateAccount()
            try Task.checkCancellation()
        } catch {
            let operationError = error.localizedDescription
            let hostsToRestore = attempted
            let restoreDevice = attemptedDevice
            // Compensate even when the initiating view task was cancelled.
            let failures = await Task { @MainActor in
                var failures: [String] = []
                if restoreDevice {
                    do {
                        try validateAccount()
                        try await updateDevice(previousEnabled)
                    } catch { failures.append("device: \(error.localizedDescription)") }
                }
                for id in hostsToRestore.reversed() {
                    do {
                        try validateAccount()
                        try await linkEnvironment(id, previousEnabled)
                    } catch { failures.append("\(id): \(error.localizedDescription)") }
                }
                return failures
            }.value
            throw PlatformLiveActivitySetupError(operation: operationError, rollbackFailures: failures)
        }
    }
}
