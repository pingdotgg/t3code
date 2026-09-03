import Foundation

/// Provider- and project-scoped data used by the composer command menu.
/// The feature layer supplies these values because the composer should not
/// know how a particular environment fetches provider or workspace data.
struct FeatureComposerPowerFeatures {
    typealias PathSearch = (_ query: String) async throws -> [FeatureComposerPathEntry]

    var slashCommands: [FeatureProviderSlashCommand]
    var skills: [FeatureProviderSkill]
    var canCompactContext: Bool
    var pathSearchScopeID: String
    var searchPaths: PathSearch?

    init(
        slashCommands: [FeatureProviderSlashCommand] = [],
        skills: [FeatureProviderSkill] = [],
        canCompactContext: Bool = false,
        pathSearchScopeID: String = "",
        searchPaths: PathSearch? = nil
    ) {
        self.slashCommands = slashCommands
        self.skills = skills
        self.canCompactContext = canCompactContext
        self.pathSearchScopeID = pathSearchScopeID
        self.searchPaths = searchPaths
    }

    static var disabled: FeatureComposerPowerFeatures { FeatureComposerPowerFeatures() }

    var enabledSkills: [FeatureProviderSkill] {
        skills.filter(\.isEnabled)
    }
}

enum FeatureContextCompaction {
    static func isCommand(_ text: String, hasAttachments: Bool) -> Bool {
        !hasAttachments
            && text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/compact"
    }

    static func canStart(in detail: FeatureThreadDetail?, isBusy: Bool) -> Bool {
        guard let detail, !isBusy, detail.isCompacting != true,
              detail.approvals.isEmpty, detail.userInputs.isEmpty else { return false }
        switch detail.thread.state {
        case .queued, .working, .monitoring, .waitingForApproval, .waitingForInput:
            return false
        case .idle, .completed, .failed:
            break
        }

        return detail.messages.contains { message in
            guard message.role == .user, message.state != .queued else { return false }
            return !message.attachments.isEmpty
                || (!message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !isCommand(message.text, hasAttachments: false))
        } || (detail.page?.hasMore == true && detail.thread.settlementFacts?.latestUserMessageAt != nil)
    }
}

public struct FeatureProviderSlashCommand: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { name }
    public let name: String
    public let description: String?
    public let inputHint: String?

    public init(
        name: String,
        description: String? = nil,
        inputHint: String? = nil
    ) {
        self.name = name
        self.description = description
        self.inputHint = inputHint
    }
}

public struct FeatureProviderSkill: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { name }
    public let name: String
    public let displayName: String?
    public let description: String?
    public let shortDescription: String?
    public let path: String
    public let scope: String?
    public let isEnabled: Bool
    public var userInvocationOnly: Bool? = nil
    public var userInvocable: Bool? = nil

    var invocation: String { "\(userInvocationOnly == true ? "/" : "$")\(name) " }

    public init(
        name: String,
        displayName: String? = nil,
        description: String? = nil,
        shortDescription: String? = nil,
        path: String = "",
        scope: String? = nil,
        isEnabled: Bool = true
    ) {
        self.name = name
        self.displayName = displayName
        self.description = description
        self.shortDescription = shortDescription
        self.path = path
        self.scope = scope
        self.isEnabled = isEnabled
    }

    var source: FeatureProviderSkillSource {
        let normalizedPath = path.replacingOccurrences(of: "\\", with: "/")
        if normalizedPath.contains("/.codex/plugins/")
            || normalizedPath.contains("/.agents/plugins/") {
            return .app
        }
        switch scope?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "repo", "repository": return .repository
        case "project", "workspace", "local": return .project
        case "user", "personal": return .personal
        case "system": return .system
        default: return .other
        }
    }
}

enum FeatureProviderSkillSource: String, Sendable, Equatable {
    case app
    case repository
    case project
    case personal
    case system
    case other

    var systemImage: String {
        switch self {
        case .app: "square.grid.2x2"
        case .repository, .project: "folder"
        case .personal: "person.crop.circle"
        case .system: "gearshape"
        case .other: "shippingbox"
        }
    }
}

struct FeatureComposerPathEntry: Identifiable, Sendable, Equatable, Hashable {
    enum Kind: String, Sendable, Equatable, Hashable {
        case file
        case directory
    }

    var id: String { path }
    let path: String
    let kind: Kind

    init(path: String, kind: Kind) {
        self.path = path
        self.kind = kind
    }

    var name: String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/", omittingEmptySubsequences: true)
            .last
            .map(String.init) ?? path
    }

    var parentPath: String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        let parts = normalized.split(separator: "/", omittingEmptySubsequences: true)
        return parts.dropLast().joined(separator: "/")
    }
}

enum FeatureComposerTriggerKind: Sendable, Equatable {
    case slashCommand
    case model
    case skill
    case path
}

struct FeatureComposerTrigger: Sendable, Equatable {
    let kind: FeatureComposerTriggerKind
    let query: String
    let range: Range<Int>
}

struct FeatureCodexFeedbackCommand: Sendable, Equatable {
    private static let expression = try? NSRegularExpression(
        pattern: #"^/feedback(?:\s+([\s\S]*))?$"#,
        options: [.caseInsensitive]
    )

    let reason: String?

    static func parse(_ text: String) -> Self? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("/feedback"),
              let expression,
              let match = expression.firstMatch(
                  in: trimmed,
                  range: NSRange(trimmed.startIndex..., in: trimmed)
              ) else {
            return nil
        }
        guard match.range(at: 1).location != NSNotFound,
              let reasonRange = Range(match.range(at: 1), in: trimmed) else {
            return Self(reason: nil)
        }
        let reason = trimmed[reasonRange].trimmingCharacters(in: .whitespacesAndNewlines)
        return Self(reason: reason.isEmpty ? nil : reason)
    }
}

/// Mirrors the shared web/mobile trigger grammar while keeping this target
/// independent of the TypeScript runtime.
enum FeatureComposerTriggerParser {
    static func detect(in text: String, cursorOffset: Int? = nil) -> FeatureComposerTrigger? {
        let cursor = min(max(cursorOffset ?? text.count, 0), text.count)
        let cursorIndex = text.index(text.startIndex, offsetBy: cursor)
        let prefix = text[..<cursorIndex]
        let lineStartIndex = prefix.lastIndex(of: "\n").map { text.index(after: $0) }
            ?? text.startIndex
        let lineStart = text.distance(from: text.startIndex, to: lineStartIndex)
        let linePrefix = String(text[lineStartIndex..<cursorIndex])
        let lowercasedLine = linePrefix.lowercased()

        if lowercasedLine == "/model" {
            return FeatureComposerTrigger(kind: .model, query: "", range: lineStart..<cursor)
        }
        if lowercasedLine.hasPrefix("/model ") {
            let query = String(linePrefix.dropFirst("/model ".count))
                .trimmingCharacters(in: .whitespaces)
            return FeatureComposerTrigger(kind: .model, query: query, range: lineStart..<cursor)
        }
        if linePrefix.first == "/", !linePrefix.dropFirst().contains(where: { $0.isWhitespace }) {
            return FeatureComposerTrigger(
                kind: .slashCommand,
                query: String(linePrefix.dropFirst()),
                range: lineStart..<cursor
            )
        }

        var tokenStartIndex = cursorIndex
        while tokenStartIndex > text.startIndex {
            let previous = text.index(before: tokenStartIndex)
            if text[previous].isWhitespace { break }
            tokenStartIndex = previous
        }
        let token = String(text[tokenStartIndex..<cursorIndex])
        let tokenStart = text.distance(from: text.startIndex, to: tokenStartIndex)

        if token.first == "$" {
            return FeatureComposerTrigger(
                kind: .skill,
                query: String(token.dropFirst()),
                range: tokenStart..<cursor
            )
        }
        if token.first == "@" {
            return FeatureComposerTrigger(
                kind: .path,
                query: String(token.dropFirst()),
                range: tokenStart..<cursor
            )
        }
        return nil
    }

    static func replacing(
        _ range: Range<Int>,
        in text: String,
        with replacement: String
    ) -> String {
        let lower = min(max(range.lowerBound, 0), text.count)
        let upper = min(max(range.upperBound, lower), text.count)
        let start = text.index(text.startIndex, offsetBy: lower)
        let end = text.index(text.startIndex, offsetBy: upper)
        return String(text[..<start]) + replacement + String(text[end...])
    }
}

enum FeatureComposerFileLinkSerializer {
    static func markdownLink(for path: String) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        let basename = normalized.split(separator: "/", omittingEmptySubsequences: true)
            .last
            .map(String.init) ?? path
        let label = basename
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        return "[\(label)](\(encodeDestination(path)))"
    }

    private static func encodeDestination(_ path: String) -> String {
        let unescaped = Set(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789;,/:@&=+$-_.!~*'"
        )
        return path.utf8.map { byte -> String in
            guard byte < 128,
                  let scalar = UnicodeScalar(Int(byte)),
                  unescaped.contains(Character(String(scalar))) else {
                return String(format: "%%%02X", byte)
            }
            return String(scalar)
        }.joined()
    }
}

enum FeatureComposerMenuItem: Identifiable, Sendable, Equatable {
    case modelCommand
    case model(selection: FeatureSelection, label: String, description: String)
    case providerCommand(FeatureProviderSlashCommand)
    case skill(FeatureProviderSkill)
    case path(FeatureComposerPathEntry)

    var id: String {
        switch self {
        case .modelCommand: "command:model"
        case let .model(selection, _, _): "model:\(selection.providerID):\(selection.modelID)"
        case let .providerCommand(command): "command:\(command.id)"
        case let .skill(skill): "skill:\(skill.id)"
        case let .path(entry): "path:\(entry.path)"
        }
    }

    var label: String {
        switch self {
        case .modelCommand: "/model"
        case let .model(_, label, _): label
        case let .providerCommand(command): "/\(command.name)"
        case let .skill(skill): skill.displayName ?? skill.name
        case let .path(entry): entry.name
        }
    }

    var description: String {
        switch self {
        case .modelCommand: "Switch model"
        case let .model(_, _, description): description
        case let .providerCommand(command):
            command.description ?? command.inputHint ?? ""
        case let .skill(skill):
            skill.shortDescription ?? skill.description ?? skill.scope ?? ""
        case let .path(entry): entry.parentPath
        }
    }
}

enum FeatureComposerMenuBuilder {
    private static func normalizedName(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func enabledSkills(
        in skills: [FeatureProviderSkill]
    ) -> [FeatureProviderSkill] {
        var seenNames = Set<String>()
        return skills.filter { skill in
            guard skill.isEnabled else { return false }
            return seenNames.insert(normalizedName(skill.name)).inserted
        }
    }

    static func items(
        trigger: FeatureComposerTrigger,
        providers: [FeatureProvider],
        currentSelection: FeatureSelection?,
        threadSelection: FeatureSelection?,
        powerFeatures: FeatureComposerPowerFeatures,
        pathEntries: [FeatureComposerPathEntry]
    ) -> [FeatureComposerMenuItem] {
        switch trigger.kind {
        case .slashCommand:
            let query = trigger.query.lowercased()
            let normalizedSkillQuery = query.hasPrefix("skill:")
                ? String(query.dropFirst("skill:".count))
                : query
            var items: [FeatureComposerMenuItem] = []
            if query.isEmpty || "model".contains(query) {
                items.append(.modelCommand)
            }
            let enabledSkills = enabledSkills(in: powerFeatures.skills)
            let skills = enabledSkills
                .filter { $0.userInvocable != false }
                .filter { skill in
                    guard !normalizedSkillQuery.isEmpty else { return true }
                    return [skill.name, skill.displayName, skill.shortDescription, skill.description]
                        .compactMap { $0 }
                        .contains { $0.localizedCaseInsensitiveContains(normalizedSkillQuery) }
                }
                .sorted {
                    ($0.displayName ?? $0.name).localizedStandardCompare($1.displayName ?? $1.name)
                        == .orderedAscending
                }
            let enabledSkillNames = Set(enabledSkills.map { normalizedName($0.name) })
            let excludedCommandNames = Set(["model", "plan", "default"].map(normalizedName))
            let commands = powerFeatures.slashCommands
                .filter { !excludedCommandNames.contains(normalizedName($0.name)) }
                .filter { normalizedName($0.name) != "compact" || powerFeatures.canCompactContext }
                .filter { !enabledSkillNames.contains(normalizedName($0.name)) }
                .filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            items.append(contentsOf: commands.map(FeatureComposerMenuItem.providerCommand))
            items.append(contentsOf: skills.map(FeatureComposerMenuItem.skill))
            return Array(items.prefix(20))

        case .model:
            let query = trigger.query.trimmingCharacters(in: .whitespacesAndNewlines)
            return providers
                .filter(\.isAvailable)
                .filter { provider in
                    threadSelection == nil || provider.id == threadSelection?.providerID
                }
                .flatMap { provider in
                    provider.models
                        .filter { model in
                            guard provider.requiresNewThreadForModelChange,
                                  let threadSelection else { return true }
                            return model.id == threadSelection.modelID
                        }
                        .map { model in
                            (
                                item: FeatureComposerMenuItem.model(
                                    selection: FeatureSelection(
                                        providerID: provider.id,
                                        modelID: model.id,
                                        options: currentSelection?.providerID == provider.id
                                            && currentSelection?.modelID == model.id
                                            ? currentSelection?.options ?? []
                                            : DailyUXModelOptions.defaults(for: model)
                                    ),
                                    label: model.name,
                                    description: provider.name
                                ),
                                searchText: "\(provider.name) \(model.name) \(model.id)"
                            )
                        }
                }
                .filter { query.isEmpty || $0.searchText.localizedCaseInsensitiveContains(query) }
                .prefix(20)
                .map(\.item)

        case .skill:
            let query = trigger.query.trimmingCharacters(in: .whitespacesAndNewlines)
            return enabledSkills(in: powerFeatures.skills)
                .filter { skill in
                    guard !query.isEmpty else { return true }
                    return [skill.name, skill.displayName, skill.shortDescription, skill.description]
                        .compactMap { $0 }
                        .contains { $0.localizedCaseInsensitiveContains(query) }
                }
                .sorted {
                    ($0.displayName ?? $0.name).localizedStandardCompare($1.displayName ?? $1.name)
                        == .orderedAscending
                }
                .prefix(20)
                .map(FeatureComposerMenuItem.skill)

        case .path:
            return pathEntries
                .uniquedByPath()
                .prefix(20)
                .map(FeatureComposerMenuItem.path)
        }
    }
}

private extension Array where Element == FeatureComposerPathEntry {
    func uniquedByPath() -> [Element] {
        var seen = Set<String>()
        return filter { seen.insert($0.path).inserted }
    }
}
