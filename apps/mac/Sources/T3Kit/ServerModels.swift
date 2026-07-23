// Typed wire models for the "server meta / config / settings" RPC family
// (§3.2 of docs/wire-protocol.md), hand-ported from
// packages/contracts/src/server.ts, settings.ts, environment.ts, auth.ts,
// editor.ts, model.ts. Covers the v1 subset actually needed by
// SergeCodeMac.BackendService: initial sync (`server.getConfig`), live
// provider/settings updates (`subscribeServerConfig`), and provider status
// display. Diagnostics (trace/process), keybindings editing, and
// source-control discovery RPCs are out of v1 scope (ARCHITECTURE.md) and
// are not modeled; their carrier fields on `ServerConfig` are decoded as
// opaque `JSONValue` so the struct still round-trips.

import Foundation

// MARK: - Environment / auth descriptors (small, stable; decoded in full)

public enum ExecutionEnvironmentPlatformOs: String, Codable, Sendable {
    case darwin, linux, windows, unknown
}

public enum ExecutionEnvironmentPlatformArch: String, Codable, Sendable {
    case arm64, x64, other
}

public struct ExecutionEnvironmentPlatform: Codable, Sendable {
    public var os: ExecutionEnvironmentPlatformOs
    public var arch: ExecutionEnvironmentPlatformArch
}

public struct ExecutionEnvironmentCapabilities: Codable, Sendable {
    public var repositoryIdentity: Bool

    private enum CodingKeys: String, CodingKey { case repositoryIdentity }

    public init(repositoryIdentity: Bool) {
        self.repositoryIdentity = repositoryIdentity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repositoryIdentity = try c.decode(Bool.self, forKey: .repositoryIdentity, default: false)
    }
}

public struct ExecutionEnvironmentDescriptor: Codable, Sendable {
    public var environmentId: String
    public var label: String
    public var platform: ExecutionEnvironmentPlatform
    public var serverVersion: String
    public var capabilities: ExecutionEnvironmentCapabilities
}

public enum ServerAuthPolicy: String, Codable, Sendable {
    case desktopManagedLocal = "desktop-managed-local"
    case loopbackBrowser = "loopback-browser"
    case remoteReachable = "remote-reachable"
    case unsafeNoAuth = "unsafe-no-auth"
}

public enum ServerAuthBootstrapMethod: String, Codable, Sendable {
    case desktopBootstrap = "desktop-bootstrap"
    case oneTimeToken = "one-time-token"
}

public enum ServerAuthSessionMethod: String, Codable, Sendable {
    case browserSessionCookie = "browser-session-cookie"
    case bearerAccessToken = "bearer-access-token"
    case dpopAccessToken = "dpop-access-token"
}

public struct ServerAuthDescriptor: Codable, Sendable {
    public var policy: ServerAuthPolicy
    public var bootstrapMethods: [ServerAuthBootstrapMethod]
    public var sessionMethods: [ServerAuthSessionMethod]
    public var sessionCookieName: String
}

// MARK: - Editors (editor.ts). `EditorId` is a closed literal set today but
// treated as an open string so a server ahead of this client on the editor
// list still decodes.

public typealias EditorId = String

// MARK: - Config issues

public struct ServerConfigIssue: Codable, Sendable {
    public var kind: String  // "keybindings.malformed-config" | "keybindings.invalid-entry"
    public var message: String
    public var index: Int?
}

// MARK: - Provider option descriptors (model.ts; used by ServerProviderModel.capabilities)

public struct ProviderOptionChoice: Codable, Sendable, Hashable {
    public var id: String
    public var label: String
    public var description: String?
    public var isDefault: Bool?
}

public struct SelectProviderOptionDescriptor: Codable, Sendable {
    public let type: String = "select"
    public var id: String
    public var label: String
    public var description: String?
    public var options: [ProviderOptionChoice]
    public var currentValue: String?
    public var promptInjectedValues: [String]?

    private enum CodingKeys: String, CodingKey {
        case type, id, label, description, options, currentValue, promptInjectedValues
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        options = try c.decode([ProviderOptionChoice].self, forKey: .options)
        currentValue = try c.decodeIfPresent(String.self, forKey: .currentValue)
        promptInjectedValues = try c.decodeIfPresent([String].self, forKey: .promptInjectedValues)
    }
}

public struct BooleanProviderOptionDescriptor: Codable, Sendable {
    public let type: String = "boolean"
    public var id: String
    public var label: String
    public var description: String?
    public var currentValue: Bool?

    private enum CodingKeys: String, CodingKey { case type, id, label, description, currentValue }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        currentValue = try c.decodeIfPresent(Bool.self, forKey: .currentValue)
    }
}

/// `ProviderOptionDescriptor` union, discriminated by `type`.
public enum ProviderOptionDescriptor: Codable, Sendable {
    case select(SelectProviderOptionDescriptor)
    case boolean(BooleanProviderOptionDescriptor)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "select":
            self = .select(try SelectProviderOptionDescriptor(from: decoder))
        case "boolean":
            self = .boolean(try BooleanProviderOptionDescriptor(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown ProviderOptionDescriptor type: \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .select(let d): try d.encode(to: encoder)
        case .boolean(let d): try d.encode(to: encoder)
        }
    }
}

public struct ModelCapabilities: Codable, Sendable {
    public var optionDescriptors: [ProviderOptionDescriptor]?
}

// MARK: - Providers (server.ts)

public enum ServerProviderState: String, Codable, Sendable {
    case ready, warning, error, disabled
}

public enum ServerProviderAuthStatus: String, Codable, Sendable {
    case authenticated, unauthenticated, unknown
}

public struct ServerProviderAuth: Codable, Sendable {
    public var status: ServerProviderAuthStatus
    public var type: String?
    public var label: String?
    public var email: String?
}

public struct ServerProviderModel: Codable, Sendable {
    public var slug: String
    public var name: String
    public var shortName: String?
    public var subProvider: String?
    public var isCustom: Bool
    public var capabilities: ModelCapabilities?
}

public struct ServerProviderSlashCommandInput: Codable, Sendable {
    public var hint: String
}

public struct ServerProviderSlashCommand: Codable, Sendable {
    public var name: String
    public var description: String?
    public var input: ServerProviderSlashCommandInput?
}

public struct ServerProviderSkill: Codable, Sendable {
    public var name: String
    public var description: String?
    public var path: String
    public var scope: String?
    public var enabled: Bool
    public var displayName: String?
    public var shortDescription: String?
}

/// See server.ts doc comment: an absent `availability` means `"available"`
/// (legacy producers never set it) — use `ServerProvider.isAvailable`
/// instead of reading this field directly.
public enum ServerProviderAvailability: String, Codable, Sendable {
    case available, unavailable
}

public struct ServerProviderContinuation: Codable, Sendable {
    public var groupKey: String
}

public enum ServerProviderVersionAdvisoryStatus: String, Codable, Sendable {
    case unknown, current, behindLatest = "behind_latest"
}

public struct ServerProviderVersionAdvisory: Codable, Sendable {
    public var status: ServerProviderVersionAdvisoryStatus
    public var currentVersion: String?
    public var latestVersion: String?
    public var updateCommand: String?
    public var canUpdate: Bool
    public var checkedAt: String?
    public var message: String?

    private enum CodingKeys: String, CodingKey {
        case status, currentVersion, latestVersion, updateCommand, canUpdate, checkedAt, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(ServerProviderVersionAdvisoryStatus.self, forKey: .status)
        currentVersion = try c.decode(String?.self, forKey: .currentVersion, default: nil)
        latestVersion = try c.decode(String?.self, forKey: .latestVersion, default: nil)
        updateCommand = try c.decode(String?.self, forKey: .updateCommand, default: nil)
        canUpdate = try c.decode(Bool.self, forKey: .canUpdate, default: false)
        checkedAt = try c.decode(String?.self, forKey: .checkedAt, default: nil)
        message = try c.decode(String?.self, forKey: .message, default: nil)
    }
}

public enum ServerProviderUpdateStatus: String, Codable, Sendable {
    case idle, queued, running, succeeded, failed, unchanged
}

public struct ServerProviderUpdateState: Codable, Sendable {
    public var status: ServerProviderUpdateStatus
    public var startedAt: String?
    public var finishedAt: String?
    public var message: String?
    public var output: String?
}

/// `ServerProvider` — one configured provider instance snapshot.
public struct ServerProvider: Codable, Sendable {
    public var instanceId: String
    public var driver: String
    public var displayName: String?
    public var accentColor: String?
    public var badgeLabel: String?
    public var continuation: ServerProviderContinuation?
    public var showInteractionModeToggle: Bool?
    public var requiresNewThreadForModelChange: Bool?
    public var enabled: Bool
    public var installed: Bool
    public var version: String?
    public var status: ServerProviderState
    public var auth: ServerProviderAuth
    public var checkedAt: String
    public var message: String?
    public var availability: ServerProviderAvailability?
    public var unavailableReason: String?
    public var models: [ServerProviderModel]
    public var slashCommands: [ServerProviderSlashCommand]
    public var skills: [ServerProviderSkill]
    public var versionAdvisory: ServerProviderVersionAdvisory?
    public var updateState: ServerProviderUpdateState?

    /// Absent `availability` means available (server.ts `isProviderAvailable`).
    public var isAvailable: Bool { availability != .unavailable }

    private enum CodingKeys: String, CodingKey {
        case instanceId, driver, displayName, accentColor, badgeLabel, continuation,
            showInteractionModeToggle, requiresNewThreadForModelChange, enabled, installed,
            version, status, auth, checkedAt, message, availability, unavailableReason, models,
            slashCommands, skills, versionAdvisory, updateState
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        instanceId = try c.decode(String.self, forKey: .instanceId)
        driver = try c.decode(String.self, forKey: .driver)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        accentColor = try c.decodeIfPresent(String.self, forKey: .accentColor)
        badgeLabel = try c.decodeIfPresent(String.self, forKey: .badgeLabel)
        continuation = try c.decodeIfPresent(ServerProviderContinuation.self, forKey: .continuation)
        showInteractionModeToggle = try c.decodeIfPresent(Bool.self, forKey: .showInteractionModeToggle)
        requiresNewThreadForModelChange = try c.decodeIfPresent(
            Bool.self, forKey: .requiresNewThreadForModelChange)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        installed = try c.decode(Bool.self, forKey: .installed)
        version = try c.decode(String?.self, forKey: .version, default: nil)
        status = try c.decode(ServerProviderState.self, forKey: .status)
        auth = try c.decode(ServerProviderAuth.self, forKey: .auth)
        checkedAt = try c.decode(String.self, forKey: .checkedAt)
        message = try c.decodeIfPresent(String.self, forKey: .message)
        availability = try c.decodeIfPresent(ServerProviderAvailability.self, forKey: .availability)
        unavailableReason = try c.decodeIfPresent(String.self, forKey: .unavailableReason)
        models = try c.decode([ServerProviderModel].self, forKey: .models)
        slashCommands = try c.decode(
            [ServerProviderSlashCommand].self, forKey: .slashCommands, default: [])
        skills = try c.decode([ServerProviderSkill].self, forKey: .skills, default: [])
        versionAdvisory = try c.decodeIfPresent(
            ServerProviderVersionAdvisory.self, forKey: .versionAdvisory)
        updateState = try c.decodeIfPresent(ServerProviderUpdateState.self, forKey: .updateState)
    }
}

public struct ServerObservability: Codable, Sendable {
    public var logsDirectoryPath: String
    public var localTracingEnabled: Bool
    public var otlpTracesUrl: String?
    public var otlpTracesEnabled: Bool
    public var otlpMetricsUrl: String?
    public var otlpMetricsEnabled: Bool
}

// MARK: - Settings (settings.ts). Per-driver settings blobs and the
// instance-config map are intentionally opaque (`JSONValue`) — no v1 UI
// edits them (SettingsScene.swift ships only a read-only provider list and
// connection info); the fields still decode/round-trip losslessly.

public enum ThreadEnvMode: String, Codable, Sendable {
    case local, worktree
}

public struct ObservabilitySettings: Codable, Sendable {
    public var otlpTracesUrl: String
    public var otlpMetricsUrl: String

    private enum CodingKeys: String, CodingKey { case otlpTracesUrl, otlpMetricsUrl }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        otlpTracesUrl = try c.decode(String.self, forKey: .otlpTracesUrl, default: "")
        otlpMetricsUrl = try c.decode(String.self, forKey: .otlpMetricsUrl, default: "")
    }
}

// Decode-only: the client never sends a whole `ServerSettings` back (a
// future `server.updateSettings` would use the separate `ServerSettingsPatch`
// shape, out of v1 scope). `automaticGitFetchIntervalMs` is deliberately
// renamed from the wire's `automaticGitFetchInterval` for clarity, which
// would break Encodable synthesis (no matching CodingKeys case) — kept
// Decodable-only so that's moot.
public struct AutoReviewSettings: Decodable, Sendable {
    public var enabled: Bool
    public var mode: String
    public var modelSelection: ModelSelection
    public var mentionHandle: String
    /// `Schema.DurationFromMillis` — milliseconds.
    public var pollIntervalMs: Double
    public var autoFixOriginThread: Bool
    public var maxDiffBytes: Int
    public var concurrency: Int
    /// Per-project overrides — opaque for v1; full UI can refine later.
    public var projects: JSONValue

    public static let `default` = AutoReviewSettings(
        enabled: false,
        mode: "auto",
        modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4-mini"),
        mentionHandle: "surgecode",
        pollIntervalMs: 60_000,
        autoFixOriginThread: true,
        maxDiffBytes: 400_000,
        concurrency: 1,
        projects: .object([:])
    )

    public init(
        enabled: Bool,
        mode: String,
        modelSelection: ModelSelection,
        mentionHandle: String,
        pollIntervalMs: Double,
        autoFixOriginThread: Bool,
        maxDiffBytes: Int,
        concurrency: Int,
        projects: JSONValue
    ) {
        self.enabled = enabled
        self.mode = mode
        self.modelSelection = modelSelection
        self.mentionHandle = mentionHandle
        self.pollIntervalMs = pollIntervalMs
        self.autoFixOriginThread = autoFixOriginThread
        self.maxDiffBytes = maxDiffBytes
        self.concurrency = concurrency
        self.projects = projects
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, mode, modelSelection, mentionHandle, pollInterval, autoFixOriginThread,
            maxDiffBytes, concurrency, projects
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled, default: false)
        mode = try c.decode(String.self, forKey: .mode, default: "auto")
        modelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .modelSelection)
            ?? ModelSelection(instanceId: "codex", model: "gpt-5.4-mini")
        mentionHandle = try c.decode(String.self, forKey: .mentionHandle, default: "surgecode")
        pollIntervalMs = try c.decode(Double.self, forKey: .pollInterval, default: 60_000)
        autoFixOriginThread = try c.decode(Bool.self, forKey: .autoFixOriginThread, default: true)
        maxDiffBytes = try c.decode(Int.self, forKey: .maxDiffBytes, default: 400_000)
        concurrency = try c.decode(Int.self, forKey: .concurrency, default: 1)
        projects = try c.decode(JSONValue.self, forKey: .projects, default: .object([:]))
    }
}

public struct ServerSettings: Decodable, Sendable {
    public var enableAssistantStreaming: Bool
    public var enableProviderUpdateChecks: Bool
    /// `Schema.DurationFromMillis` — milliseconds (§5.1 numeric-time exception).
    public var automaticGitFetchIntervalMs: Double
    public var defaultThreadEnvMode: ThreadEnvMode
    public var newWorktreesStartFromOrigin: Bool
    public var addProjectBaseDirectory: String
    public var textGenerationModelSelection: ModelSelection
    /// Per-driver legacy settings blobs (`codex`, `claudeAgent`, `cursor`,
    /// `grok`, `fugu`) — opaque, not edited by v1 UI.
    public var providers: JSONValue
    /// `Record<ProviderInstanceId, ProviderInstanceConfig>` — opaque.
    public var providerInstances: JSONValue
    public var observability: ObservabilitySettings
    public var autoReview: AutoReviewSettings

    private enum CodingKeys: String, CodingKey {
        case enableAssistantStreaming, enableProviderUpdateChecks, automaticGitFetchInterval,
            defaultThreadEnvMode, newWorktreesStartFromOrigin, addProjectBaseDirectory,
            textGenerationModelSelection, providers, providerInstances, observability, autoReview
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enableAssistantStreaming = try c.decode(
            Bool.self, forKey: .enableAssistantStreaming, default: false)
        enableProviderUpdateChecks = try c.decode(
            Bool.self, forKey: .enableProviderUpdateChecks, default: true)
        automaticGitFetchIntervalMs = try c.decode(
            Double.self, forKey: .automaticGitFetchInterval, default: 30_000)
        defaultThreadEnvMode = try c.decode(
            ThreadEnvMode.self, forKey: .defaultThreadEnvMode, default: .local)
        newWorktreesStartFromOrigin = try c.decode(
            Bool.self, forKey: .newWorktreesStartFromOrigin, default: false)
        addProjectBaseDirectory = try c.decode(
            String.self, forKey: .addProjectBaseDirectory, default: "")
        textGenerationModelSelection = try c.decode(
            ModelSelection.self, forKey: .textGenerationModelSelection)
        providers = try c.decode(JSONValue.self, forKey: .providers, default: .object([:]))
        providerInstances = try c.decode(
            JSONValue.self, forKey: .providerInstances, default: .object([:]))
        observability = try c.decode(
            ObservabilitySettings.self, forKey: .observability,
            default: ObservabilitySettings(rawTracesUrl: "", rawMetricsUrl: ""))
        autoReview = try c.decodeIfPresent(AutoReviewSettings.self, forKey: .autoReview)
            ?? .default
    }
}

extension ObservabilitySettings {
    fileprivate init(rawTracesUrl: String, rawMetricsUrl: String) {
        self.otlpTracesUrl = rawTracesUrl
        self.otlpMetricsUrl = rawMetricsUrl
    }
}

// MARK: - ServerConfig (initial sync object, §1.3/§3.2)

public struct ServerConfig: Decodable, Sendable {
    public var environment: ExecutionEnvironmentDescriptor
    public var auth: ServerAuthDescriptor
    public var cwd: String
    public var keybindingsConfigPath: String
    /// `ResolvedKeybindingsConfig` — opaque; the keybindings editor is out of
    /// v1 scope (ARCHITECTURE.md).
    public var keybindings: JSONValue
    public var issues: [ServerConfigIssue]
    public var providers: [ServerProvider]
    public var availableEditors: [EditorId]
    public var observability: ServerObservability
    public var settings: ServerSettings
}

// MARK: - subscribeServerConfig stream (server.ts §3.11)

public struct ServerConfigKeybindingsUpdatedPayload: Decodable, Sendable {
    public var keybindings: JSONValue
    public var issues: [ServerConfigIssue]
}

public struct ServerConfigProviderStatusesPayload: Decodable, Sendable {
    public var providers: [ServerProvider]
}

public struct ServerConfigSettingsUpdatedPayload: Decodable, Sendable {
    public var settings: ServerSettings
}

/// `ServerConfigStreamEvent` — union discriminated by `type` (plus a fixed
/// `version: 1`).
public enum ServerConfigStreamEvent: Decodable, Sendable {
    case snapshot(ServerConfig)
    case keybindingsUpdated(ServerConfigKeybindingsUpdatedPayload)
    case providerStatuses(ServerConfigProviderStatusesPayload)
    case settingsUpdated(ServerConfigSettingsUpdatedPayload)
    /// Any `type` this codec doesn't recognize (forward compatibility, §6
    /// risk 1) — this is one of the explicitly-unstable streams, so an
    /// unknown variant must not kill the subscription (matching
    /// `OrchestrationEvent`'s `.other` fallback).
    case other(type: String, payload: JSONValue?)

    private enum CodingKeys: String, CodingKey { case type, config, payload }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            self = .snapshot(try c.decode(ServerConfig.self, forKey: .config))
        case "keybindingsUpdated":
            self = .keybindingsUpdated(
                try c.decode(ServerConfigKeybindingsUpdatedPayload.self, forKey: .payload))
        case "providerStatuses":
            self = .providerStatuses(
                try c.decode(ServerConfigProviderStatusesPayload.self, forKey: .payload))
        case "settingsUpdated":
            self = .settingsUpdated(
                try c.decode(ServerConfigSettingsUpdatedPayload.self, forKey: .payload))
        default:
            let payload = try c.decodeIfPresent(JSONValue.self, forKey: .payload)
            self = .other(type: type, payload: payload)
        }
    }
}

// MARK: - subscribeServerLifecycle stream (server.ts; used only for the
// welcome/ready readiness signal — see wire-protocol.md §1.3)

public struct ServerLifecycleWelcomePayload: Decodable, Sendable {
    public var environment: ExecutionEnvironmentDescriptor
    public var cwd: String
    public var projectName: String
    public var bootstrapProjectId: String?
    public var bootstrapThreadId: String?
}

public struct ServerLifecycleReadyPayload: Decodable, Sendable {
    public var at: String
    public var environment: ExecutionEnvironmentDescriptor
}

public enum ServerLifecycleStreamEvent: Decodable, Sendable {
    case welcome(sequence: Int, payload: ServerLifecycleWelcomePayload)
    case ready(sequence: Int, payload: ServerLifecycleReadyPayload)
    /// Any `type` this codec doesn't recognize (forward compatibility, §6
    /// risk 1) — see `ServerConfigStreamEvent.other`.
    case other(type: String, sequence: Int, payload: JSONValue?)

    private enum CodingKeys: String, CodingKey { case type, sequence, payload }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let sequence = try c.decode(Int.self, forKey: .sequence)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "welcome":
            self = .welcome(
                sequence: sequence, payload: try c.decode(ServerLifecycleWelcomePayload.self, forKey: .payload))
        case "ready":
            self = .ready(
                sequence: sequence, payload: try c.decode(ServerLifecycleReadyPayload.self, forKey: .payload))
        default:
            let payload = try c.decodeIfPresent(JSONValue.self, forKey: .payload)
            self = .other(type: type, sequence: sequence, payload: payload)
        }
    }
}
