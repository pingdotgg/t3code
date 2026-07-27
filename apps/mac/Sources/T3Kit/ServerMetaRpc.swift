// server.* mutation RPCs (rpc.ts §3.2): provider refresh/update and the
// settings get/patch pair. Read-side models live in ServerModels.swift.

import Foundation

/// `server.refreshProviders` / `server.updateProvider` success payload:
/// the full post-action provider list.
public struct ServerProviderUpdatedPayload: Decodable, Sendable {
    public var providers: [ServerProvider]
}

struct ServerRefreshProvidersInput: Encodable, Sendable {
    var instanceId: String?
}

struct ServerUpdateProviderInput: Encodable, Sendable {
    var provider: String
    var instanceId: String?
}

struct ServerUpdateSettingsInput: Encodable, Sendable {
    var patch: ServerSettingsPatch
}

/// Nested patch for `ServerSettings.autoReview`.
public struct AutoReviewSettingsPatch: Encodable, Sendable {
    public var enabled: Bool?
    public var mode: String?
    public var modelSelection: ModelSelection?
    public var mentionHandle: String?
    /// Milliseconds (DurationFromMillis on the wire).
    public var pollInterval: Double?
    public var autoFixOriginThread: Bool?
    /// `"thread"`, `"review"`, or `"custom"`.
    public var fixModelMode: String?
    /// Sent only for `"custom"`; the server ignores it in the other modes.
    public var fixModelSelection: ModelSelection?
    /// Max review attempts per PR head (1–10).
    public var maxAttempts: Int?
    /// Parallel reviews (1–8).
    public var concurrency: Int?
    /// Parallel auto-fix turns (1–8).
    public var fixConcurrency: Int?
    /// Whole-map replacement of per-project overrides.
    public var projects: [String: AutoReviewProjectOverridePatch]?

    public init(
        enabled: Bool? = nil, mode: String? = nil, modelSelection: ModelSelection? = nil,
        mentionHandle: String? = nil, pollInterval: Double? = nil,
        autoFixOriginThread: Bool? = nil, fixModelMode: String? = nil,
        fixModelSelection: ModelSelection? = nil, maxAttempts: Int? = nil,
        concurrency: Int? = nil, fixConcurrency: Int? = nil,
        projects: [String: AutoReviewProjectOverridePatch]? = nil
    ) {
        self.enabled = enabled
        self.mode = mode
        self.modelSelection = modelSelection
        self.mentionHandle = mentionHandle
        self.pollInterval = pollInterval
        self.autoFixOriginThread = autoFixOriginThread
        self.fixModelMode = fixModelMode
        self.fixModelSelection = fixModelSelection
        self.maxAttempts = maxAttempts
        self.concurrency = concurrency
        self.fixConcurrency = fixConcurrency
        self.projects = projects
    }
}

public struct AutoReviewProjectOverridePatch: Encodable, Sendable {
    public var enabled: Bool?

    public init(enabled: Bool? = nil) {
        self.enabled = enabled
    }
}

/// `ServerSettingsPatch` (settings.ts) — every key optionalKey; absent keys
/// leave the setting untouched. Only the fields the mac client edits are
/// modeled; the server merges partial patches.
public struct ServerSettingsPatch: Encodable, Sendable {
    public var enableAssistantStreaming: Bool?
    public var enableProviderUpdateChecks: Bool?
    public var defaultThreadEnvMode: ThreadEnvMode?
    public var newWorktreesStartFromOrigin: Bool?
    public var addProjectBaseDirectory: String?
    public var autoReview: AutoReviewSettingsPatch?
    /// Outer `nil` = leave unchanged; inner `nil` = disable (encoded as an
    /// explicit JSON null so the server clears the setting).
    public var autoArchiveSettledAfterMs: Double??

    public init(
        enableAssistantStreaming: Bool? = nil, enableProviderUpdateChecks: Bool? = nil,
        defaultThreadEnvMode: ThreadEnvMode? = nil, newWorktreesStartFromOrigin: Bool? = nil,
        addProjectBaseDirectory: String? = nil, autoReview: AutoReviewSettingsPatch? = nil,
        autoArchiveSettledAfterMs: Double?? = nil
    ) {
        self.enableAssistantStreaming = enableAssistantStreaming
        self.enableProviderUpdateChecks = enableProviderUpdateChecks
        self.defaultThreadEnvMode = defaultThreadEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.addProjectBaseDirectory = addProjectBaseDirectory
        self.autoReview = autoReview
        self.autoArchiveSettledAfterMs = autoArchiveSettledAfterMs
    }

    private enum CodingKeys: String, CodingKey {
        case enableAssistantStreaming, enableProviderUpdateChecks, defaultThreadEnvMode,
            newWorktreesStartFromOrigin, addProjectBaseDirectory, autoReview,
            autoArchiveSettledAfter
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enableAssistantStreaming, forKey: .enableAssistantStreaming)
        try c.encodeIfPresent(enableProviderUpdateChecks, forKey: .enableProviderUpdateChecks)
        try c.encodeIfPresent(defaultThreadEnvMode, forKey: .defaultThreadEnvMode)
        try c.encodeIfPresent(newWorktreesStartFromOrigin, forKey: .newWorktreesStartFromOrigin)
        try c.encodeIfPresent(addProjectBaseDirectory, forKey: .addProjectBaseDirectory)
        try c.encodeIfPresent(autoReview, forKey: .autoReview)
        if let autoArchiveSettledAfterMs {
            try c.encode(autoArchiveSettledAfterMs, forKey: .autoArchiveSettledAfter)
        }
    }
}

extension T3Client {
    /// Re-probe installed provider CLIs; pass `instanceId` to target one.
    @discardableResult
    public func refreshProviders(instanceId: String? = nil) async throws
        -> ServerProviderUpdatedPayload
    {
        try await call(
            "server.refreshProviders", ServerRefreshProvidersInput(instanceId: instanceId))
    }

    /// Run the provider CLI's own update command (e.g. `npm i -g`).
    @discardableResult
    public func updateProviderCLI(driver: String, instanceId: String? = nil) async throws
        -> ServerProviderUpdatedPayload
    {
        try await call(
            "server.updateProvider",
            ServerUpdateProviderInput(provider: driver, instanceId: instanceId))
    }

    public func getSettings() async throws -> ServerSettings {
        try await call("server.getSettings", EmptyPayload())
    }

    /// Applies a partial settings patch; returns the merged settings.
    @discardableResult
    public func updateSettings(patch: ServerSettingsPatch) async throws -> ServerSettings {
        try await call("server.updateSettings", ServerUpdateSettingsInput(patch: patch))
    }

    /// Recent native auto-review jobs (`autoReview.listJobs`).
    public func listAutoReviewJobs(projectId: String? = nil, limit: Int? = nil) async throws
        -> AutoReviewJobsPayload
    {
        try await call(
            "autoReview.listJobs",
            ListAutoReviewJobsInput(projectId: projectId, limit: limit))
    }
}

struct ListAutoReviewJobsInput: Encodable, Sendable {
    var projectId: String?
    var limit: Int?
}

public struct AutoReviewJobsPayload: Decodable, Sendable {
    public var jobs: [AutoReviewJobWire]
}

public struct AutoReviewJobWire: Decodable, Sendable, Identifiable {
    public var id: String
    public var projectId: String
    public var prNumber: Int
    public var headSha: String
    public var trigger: String
    public var status: String
    /// 1-based attempt number within a PR-head review chain.
    public var attempt: Int
    public var findingsCount: Int?
    public var reviewUrl: String?
    public var autoFixEnqueued: Bool
    public var error: String?
    public var updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, projectId, prNumber, headSha, trigger, status, attempt, findingsCount,
            reviewUrl, autoFixEnqueued, error, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = try c.decode(String.self, forKey: .projectId)
        prNumber = try c.decode(Int.self, forKey: .prNumber)
        headSha = try c.decode(String.self, forKey: .headSha)
        trigger = try c.decode(String.self, forKey: .trigger)
        status = try c.decode(String.self, forKey: .status)
        attempt = try c.decode(Int.self, forKey: .attempt, default: 1)
        findingsCount = try c.decodeIfPresent(Int.self, forKey: .findingsCount)
        reviewUrl = try c.decodeIfPresent(String.self, forKey: .reviewUrl)
        autoFixEnqueued = try c.decode(Bool.self, forKey: .autoFixEnqueued)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
    }
}
