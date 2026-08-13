import ClerkKit
import Foundation
import Observation
import OSLog

public extension Notification.Name {
    static let t3ConnectSessionChanged = Notification.Name("T3ConnectSessionChanged")
}

@MainActor
public protocol T3ConnectCapable: AnyObject {
    var t3ConnectController: T3ConnectController { get }

    /// Save and activate the relay-managed environment without treating its
    /// bootstrap credential as a bearer token. Implementations prepare the
    /// DPoP access token and socket ticket through `managedAuthorizer`.
    func connectT3Environment(
        _ credential: T3ConnectManagedEnvironmentCredential
    ) async throws

    /// Ends the account session and removes only relay-managed runtime state.
    /// Directly paired environments belong to the device and must survive.
    func signOutT3Connect() async
}

public struct T3ConnectCloudEnvironment: Identifiable, Equatable, Sendable {
    public var id: String { environment.environmentId }

    public let environment: T3ConnectRelayEnvironment
    public let status: T3ConnectRelayEnvironmentStatus?
    public let statusError: String?

    public init(
        environment: T3ConnectRelayEnvironment,
        status: T3ConnectRelayEnvironmentStatus? = nil,
        statusError: String? = nil
    ) {
        self.environment = environment
        self.status = status
        self.statusError = statusError
    }
}

@MainActor
protocol T3ConnectDeviceManaging: AnyObject {
    var hasActiveAccount: Bool { get }
    var currentRegisteredDeviceID: String? { get }
    func registeredDevices() async throws -> [T3ConnectRelayDevice]
    func unregisterDevice(id: String) async throws
}

@MainActor
@Observable
public final class T3ConnectController: T3ConnectDeviceManaging {
    private static let logger = Logger(
        subsystem: "codes.t3.swift-ios",
        category: "T3Connect"
    )
    public let resolution: T3ConnectConfigurationResolution
    public let managedAuthorizer: T3ConnectManagedEnvironmentAuthorizer

    public private(set) var account: T3ConnectAccount? {
        didSet {
            guard oldValue != account else { return }
            NotificationCenter.default.post(name: .t3ConnectSessionChanged, object: self)
        }
    }
    public private(set) var environments: [T3ConnectCloudEnvironment] = []
    public private(set) var isRefreshing = false
    public private(set) var busyEnvironmentID: String?
    public var errorMessage: String?

    private let auth: T3ConnectClerkSession?
    private let relay: T3ConnectRelayClient?
    private var registeredDeviceID: String?
    private var refreshGeneration: UInt64 = 0
    private var authorizationGeneration: UInt64 = 0
    private var isLocalAuthorizationInvalidated = false
    private var isSignOutInProgress = false
    private var authorizationOperationCount = 0
    private var authorizationOperationWaiters: [CheckedContinuation<Void, Never>] = []
    private var signOutOperation: (@MainActor @Sendable () async throws -> Void)?

    public convenience init(
        resolution: T3ConnectConfigurationResolution = T3ConnectConfiguration.resolve(),
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.init(
            resolution: resolution,
            transport: transport,
            signer: signer,
            configureAuth: true,
            signOutOperation: nil
        )
    }

    private init(
        resolution: T3ConnectConfigurationResolution,
        transport: any HTTPTransport,
        signer: T3ConnectDPoPSigner,
        configureAuth: Bool,
        signOutOperation: (@MainActor @Sendable () async throws -> Void)?
    ) {
        self.resolution = resolution
        self.signOutOperation = signOutOperation
        managedAuthorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        guard let configuration = resolution.configuration else {
            auth = nil
            relay = nil
            return
        }
        auth = configureAuth ? T3ConnectClerkSession(configuration: configuration) : nil
        relay = T3ConnectRelayClient(
            configuration: configuration,
            transport: transport,
            signer: signer
        )
    }

    convenience init(
        resolution: T3ConnectConfigurationResolution,
        transport: any HTTPTransport,
        signer: T3ConnectDPoPSigner,
        signOutOperation: @escaping @MainActor @Sendable () async throws -> Void
    ) {
        self.init(
            resolution: resolution,
            transport: transport,
            signer: signer,
            configureAuth: false,
            signOutOperation: signOutOperation
        )
    }

    public var unavailableReason: String? {
        guard case let .unavailable(reason) = resolution else { return nil }
        return reason
    }

    public var currentRegisteredDeviceID: String? { registeredDeviceID }
    var hasActiveAccount: Bool { account != nil }

    var clerk: Clerk? { auth?.client }

    public func refresh() async {
        guard let auth, let relay else { return }
        guard !isLocalAuthorizationInvalidated else { return }
        refreshGeneration &+= 1
        let generation = refreshGeneration
        let authGeneration = authorizationGeneration
        isRefreshing = true
        defer {
            if refreshGeneration == generation { isRefreshing = false }
        }
        do {
            if !auth.isLoaded { try await auth.refresh() }
            guard refreshGeneration == generation,
                  authorizationGeneration == authGeneration,
                  !isLocalAuthorizationInvalidated else { return }
            await adoptAccount(auth.account, relay: relay)
            guard account != nil else {
                environments = []
                return
            }
            let token = try await auth.relayToken()
            guard refreshGeneration == generation,
                  authorizationGeneration == authGeneration,
                  !isLocalAuthorizationInvalidated else { return }
            let records = try await relay.listEnvironments(clerkToken: token)
            guard refreshGeneration == generation,
                  authorizationGeneration == authGeneration,
                  !isLocalAuthorizationInvalidated else { return }
            environments = records.map { T3ConnectCloudEnvironment(environment: $0) }
            let loaded = await withTaskGroup(
                of: T3ConnectCloudEnvironment.self,
                returning: [T3ConnectCloudEnvironment].self
            ) { group in
                for record in records {
                    group.addTask {
                        do {
                            let status = try await relay.status(for: record, clerkToken: token)
                            return T3ConnectCloudEnvironment(
                                environment: record,
                                status: status
                            )
                        } catch {
                            return T3ConnectCloudEnvironment(
                                environment: record,
                                statusError: error.localizedDescription
                            )
                        }
                    }
                }
                var loaded: [T3ConnectCloudEnvironment] = []
                for await environment in group { loaded.append(environment) }
                return loaded.sorted {
                    $0.environment.linkedAt > $1.environment.linkedAt
                }
            }
            guard refreshGeneration == generation,
                  authorizationGeneration == authGeneration,
                  !isLocalAuthorizationInvalidated else { return }
            environments = loaded
        } catch {
            if refreshGeneration == generation {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// A successful authentication flow is the only action that may restore a
    /// locally signed-out Clerk session.
    public func refreshAfterAuthentication() async {
        isLocalAuthorizationInvalidated = false
        authorizationGeneration &+= 1
        await refresh()
    }

    public func signOut() async {
        guard let relay else { return }
        guard !isSignOutInProgress else { return }
        isSignOutInProgress = true
        let deviceID = registeredDeviceID
        isLocalAuthorizationInvalidated = true
        authorizationGeneration &+= 1
        let signOutAuthorizationGeneration = authorizationGeneration
        refreshGeneration &+= 1
        let generation = refreshGeneration
        isRefreshing = true
        defer {
            isSignOutInProgress = false
            if refreshGeneration == generation { isRefreshing = false }
        }
        account = nil
        environments = []
        registeredDeviceID = nil
        await relay.clearTokenCache()
        await waitForAuthorizationOperations()

        guard authorizationGeneration == signOutAuthorizationGeneration,
              isLocalAuthorizationInvalidated else { return }
        if let auth,
           let deviceID,
           let token = try? await auth.relayToken() {
            guard authorizationGeneration == signOutAuthorizationGeneration,
                  isLocalAuthorizationInvalidated else { return }
            // Remote delivery must not outlive the signed-in session on this
            // install. A failed best-effort unregister must not trap the user
            // in an account they are trying to leave.
            try? await relay.unregisterDevice(
                deviceID: deviceID,
                clerkToken: token
            )
        }
        await relay.clearTokenCache()

        // Local authorization state is security-sensitive and must be cleared
        // before Clerk performs network work. A failed remote sign-out can be
        // reported, but it cannot leave relay tokens or managed state usable.
        do {
            guard authorizationGeneration == signOutAuthorizationGeneration,
                  isLocalAuthorizationInvalidated else { return }
            if let signOutOperation {
                try await signOutOperation()
            } else if let auth {
                try await auth.signOut()
            }
            Self.logger.info("T3 Connect account session signed out")
        } catch {
            guard refreshGeneration == generation else { return }
            Self.logger.error(
                "T3 Connect remote sign-out failed: \(error.localizedDescription, privacy: .private)"
            )
            errorMessage = error.localizedDescription
        }
    }

    public func credential(
        for environment: T3ConnectRelayEnvironment,
        deviceID: String? = nil
    ) async throws -> T3ConnectManagedEnvironmentCredential {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        busyEnvironmentID = environment.environmentId
        defer { busyEnvironmentID = nil }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        let credential = try await relay.connect(
            to: environment,
            clerkToken: token,
            deviceID: deviceID ?? registeredDeviceID
        )
        try requireCurrentAuthorization(generation)
        return credential
    }

    /// Reacquires the one-use bootstrap credential needed to refresh a saved
    /// managed environment. The current relay record is fetched again so an
    /// expired access token never falls back to a manual bearer credential.
    public func credential(
        forEnvironmentID environmentID: String,
        deviceID: String? = nil
    ) async throws -> T3ConnectManagedEnvironmentCredential {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        let records = try await relay.listEnvironments(clerkToken: token)
        try requireCurrentAuthorization(generation)
        guard let environment = records.first(where: { $0.environmentId == environmentID }) else {
            throw T3ConnectRelayError.invalidConfiguration(
                "This environment is no longer linked to your T3 account."
            )
        }
        let credential = try await relay.connect(
            to: environment,
            clerkToken: token,
            deviceID: deviceID ?? registeredDeviceID
        )
        try requireCurrentAuthorization(generation)
        return credential
    }

    public func unlink(_ environment: T3ConnectRelayEnvironment) async {
        guard let auth, let relay else { return }
        busyEnvironmentID = environment.environmentId
        defer { busyEnvironmentID = nil }
        do {
            let token = try await loadedRelayToken(auth)
            let generation = authorizationGeneration
            try beginAuthorizationOperation(generation)
            defer { endAuthorizationOperation() }
            try await relay.unlinkEnvironment(
                environmentID: environment.environmentId,
                clerkToken: token
            )
            guard isAuthorizationCurrent(generation) else { return }
            environments.removeAll { $0.id == environment.environmentId }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func registerDevice(_ registration: T3ConnectDeviceRegistration) async throws {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        try await relay.registerDevice(registration, clerkToken: token)
        guard isAuthorizationCurrent(generation) else {
            try? await relay.unregisterDevice(
                deviceID: registration.deviceId,
                clerkToken: token
            )
            await relay.clearTokenCache()
            throw T3ConnectAuthError.noSession
        }
        registeredDeviceID = registration.deviceId
    }

    public func registeredDevices() async throws -> [T3ConnectRelayDevice] {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        let devices = try await relay.listDevices(clerkToken: token)
        try requireCurrentAuthorization(generation)
        return devices
    }

    public func unregisterDevice(id: String) async throws {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        try await relay.unregisterDevice(deviceID: id, clerkToken: token)
        try requireCurrentAuthorization(generation)
        if registeredDeviceID == id {
            registeredDeviceID = nil
        }
    }

    func rememberRegisteredDevice(id: String) {
        registeredDeviceID = id
    }

    public func registerLiveActivity(
        _ registration: T3ConnectLiveActivityRegistration
    ) async throws {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await loadedRelayToken(auth)
        let generation = authorizationGeneration
        try beginAuthorizationOperation(generation)
        defer { endAuthorizationOperation() }
        try await relay.registerLiveActivity(registration, clerkToken: token)
        guard isAuthorizationCurrent(generation) else {
            // Live activity registrations are device-scoped. Removing the
            // device compensates for a registration that crossed sign-out.
            try? await relay.unregisterDevice(
                deviceID: registration.deviceId,
                clerkToken: token
            )
            await relay.clearTokenCache()
            throw T3ConnectAuthError.noSession
        }
    }

    private func loadedRelayToken(_ auth: T3ConnectClerkSession) async throws -> String {
        guard !isLocalAuthorizationInvalidated else { throw T3ConnectAuthError.noSession }
        let generation = authorizationGeneration
        if !auth.isLoaded {
            try await auth.refresh()
        }
        guard authorizationGeneration == generation,
              !isLocalAuthorizationInvalidated else { throw T3ConnectAuthError.noSession }
        if let relay {
            await adoptAccount(auth.account, relay: relay)
        } else {
            account = auth.account
        }
        guard account != nil else { throw T3ConnectAuthError.noSession }
        let token = try await auth.relayToken()
        guard authorizationGeneration == generation,
              !isLocalAuthorizationInvalidated else { throw T3ConnectAuthError.noSession }
        return token
    }

    private func adoptAccount(
        _ nextAccount: T3ConnectAccount?,
        relay: T3ConnectRelayClient
    ) async {
        if account?.id != nextAccount?.id {
            environments = []
            registeredDeviceID = nil
            await relay.clearTokenCache()
        }
        account = nextAccount
    }

    private func isAuthorizationCurrent(_ generation: UInt64) -> Bool {
        authorizationGeneration == generation && !isLocalAuthorizationInvalidated
    }

    private func requireCurrentAuthorization(_ generation: UInt64) throws {
        guard isAuthorizationCurrent(generation) else {
            throw T3ConnectAuthError.noSession
        }
    }

    private func beginAuthorizationOperation(_ generation: UInt64) throws {
        try requireCurrentAuthorization(generation)
        authorizationOperationCount += 1
    }

    private func endAuthorizationOperation() {
        authorizationOperationCount -= 1
        guard authorizationOperationCount == 0 else { return }
        let waiters = authorizationOperationWaiters
        authorizationOperationWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func waitForAuthorizationOperations() async {
        guard authorizationOperationCount > 0 else { return }
        await withCheckedContinuation { continuation in
            authorizationOperationWaiters.append(continuation)
        }
    }
}
