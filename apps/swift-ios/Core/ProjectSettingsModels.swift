import Foundation

public enum BranchNamingMode: String, Codable, CaseIterable, Sendable {
    case `static`, semantic, custom

    public var label: String {
        switch self {
        case .static: "Static prefix"
        case .semantic: "Semantic prefix"
        case .custom: "Custom instructions"
        }
    }
}

public enum WorktreeSubmodules: String, Codable, CaseIterable, Sendable {
    case recursive
    case topLevel = "top-level"
    case none

    var label: String {
        switch self {
        case .recursive: "All nested submodules"
        case .topLevel: "Top-level only"
        case .none: "Do not initialize"
        }
    }
}

public enum ResponseStreamingMode: String, Codable, CaseIterable, Sendable {
    case turn, paragraph, token

    public var label: String {
        switch self {
        case .turn: "After each turn"
        case .paragraph: "Paragraphs"
        case .token: "Tokens"
        }
    }
}

/// Keys the native settings controls can change. Other override keys stay intact.
public enum ServerProjectSettingKey: String, Sendable {
    case defaultModelSelection, defaultRuntimeMode, defaultThreadEnvMode, newWorktreesStartFromOrigin
    case defaultAutoPull, sidebarAutoSettleOnMerge, sidebarAutoSettleAfterDays, removeAgentCreditsOnMerge
    case branchNamingMode, branchNamePrefix, branchNameInstructions, enableAgentBrowserAccess
    case continueThreadsAfterServerUpdate, responseStreamingMode, worktreeSubmodules, worktreeCleanup
}

public struct ServerProjectSettingChange: Sendable {
    public let key: ServerProjectSettingKey
    /// Nil inherits. JSON null is an explicit override for nullable settings.
    public let value: JSONValue?

    public init(key: ServerProjectSettingKey, value: JSONValue?) {
        self.key = key
        self.value = value
    }

    public func patch(projectID: String, settings: ServerSettingsSnapshot) -> ServerSettingsChange {
        var entry = settings.projectSettingsOverrides[projectID] ?? [:]
        entry[key.rawValue] = value
        return .projectSettingsOverrides(projectID: projectID, entry: entry.isEmpty ? nil : entry)
    }
}

public extension ServerSettingsSnapshot {
    var storageCleanupRules: [String: JSONValue] {
        var result = storageCleanup ?? [:]
        if worktreeCleanup?["mode"]?.stringValue == "off" {
            result["worktreeAfterDays"] = .null
            for key in ["worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"] { result[key] = .bool(false) }
        } else if case let .object(rules) = worktreeCleanup?["rules"] {
            result.merge(rules) { _, next in next }
        }
        return result
    }

    /// The aggregate fields apply only until the server folds them into settings.
    /// After that, removing an override must not restore a stale aggregate value.
    func resolvingProject(
        id: String,
        legacyModelSelection: ModelSelection? = nil,
        legacyWorkspaceMode: ServerThreadEnvironmentMode? = nil,
        disabledProviderIDs: Set<String> = []
    ) -> ServerSettingsSnapshot {
        var resolved = self
        var entry = projectSettingsOverrides[id] ?? [:]
        if !projectSettingsFolded {
            if entry["defaultModelSelection"] == nil, let legacyModelSelection {
                entry["defaultModelSelection"] = try? JSONValue.encode(legacyModelSelection)
            }
            if entry["defaultThreadEnvMode"] == nil, let legacyWorkspaceMode {
                entry["defaultThreadEnvMode"] = .string(legacyWorkspaceMode.rawValue)
            }
        }
        if let value = entry["defaultModelSelection"] {
            if value == .null {
                resolved.defaultModelSelection = nil
            } else if let selection = try? value.decode(ModelSelection.self),
                      !disabledProviderIDs.contains(selection.instanceId) {
                resolved.defaultModelSelection = selection
            }
        }
        if let value = entry["defaultThreadEnvMode"]?.stringValue.flatMap(ServerThreadEnvironmentMode.init(rawValue:)) {
            resolved.defaultThreadEnvMode = value
        }
        if let value = entry["defaultRuntimeMode"]?.stringValue.flatMap(RuntimeMode.init(rawValue:)) {
            resolved.defaultRuntimeMode = value
        }
        if let value = entry["branchNamingMode"]?.stringValue.flatMap(BranchNamingMode.init(rawValue:)) {
            resolved.branchNamingMode = value
        }
        if let value = entry["branchNamePrefix"]?.stringValue { resolved.branchNamePrefix = value }
        if let value = entry["branchNameInstructions"]?.stringValue { resolved.branchNameInstructions = value }
        if let value = entry["enableAgentBrowserAccess"]?.boolValue { resolved.enableAgentBrowserAccess = value }
        if let value = entry["newWorktreesStartFromOrigin"]?.boolValue {
            resolved.newWorktreesStartFromOrigin = value
        }
        if let value = entry["worktreeCleanup"] { resolved.worktreeCleanup = value }
        if let value = entry["worktreeSubmodules"]?.stringValue.flatMap(WorktreeSubmodules.init(rawValue:)) {
            resolved.worktreeSubmodules = value
        }
        if let value = entry["removeAgentCreditsOnMerge"]?.boolValue { resolved.removeAgentCreditsOnMerge = value }
        if let value = entry["defaultAutoPull"]?.boolValue { resolved.defaultAutoPull = value }
        if let value = entry["sidebarAutoSettleOnMerge"]?.boolValue { resolved.sidebarAutoSettleOnMerge = value }
        if let value = entry["sidebarAutoSettleAfterDays"] {
            if value == .null { resolved.sidebarAutoSettleAfterDays = nil }
            else if let days = try? value.decode(Double.self) { resolved.sidebarAutoSettleAfterDays = days }
        }
        if let value = entry["continueThreadsAfterServerUpdate"]?.boolValue {
            resolved.continueThreadsAfterServerUpdate = value
        }
        if let value = entry["responseStreamingMode"]?.stringValue.flatMap(ResponseStreamingMode.init(rawValue:)) {
            resolved.responseStreamingMode = value
        }
        return resolved
    }
}
