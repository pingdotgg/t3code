import Foundation

/// Provider- and project-scoped data used by the composer command menu.
/// The feature layer supplies these values because the composer should not
/// know how a particular environment fetches provider or workspace data.
struct FeatureComposerPowerFeatures {
    typealias PathSearch = (_ query: String) async throws -> [FeatureComposerPathEntry]

    var slashCommands: [FeatureProviderSlashCommand]
    var skills: [FeatureProviderSkill]
    var pathSearchScopeID: String
    var searchPaths: PathSearch?

    init(
        slashCommands: [FeatureProviderSlashCommand] = [],
        skills: [FeatureProviderSkill] = [],
        pathSearchScopeID: String = "",
        searchPaths: PathSearch? = nil
    ) {
        self.slashCommands = slashCommands
        self.skills = skills
        self.pathSearchScopeID = pathSearchScopeID
        self.searchPaths = searchPaths
    }

    static let disabled = FeatureComposerPowerFeatures()
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
            var items: [FeatureComposerMenuItem] = []
            if query.isEmpty || "model".contains(query) {
                items.append(.modelCommand)
            }
            let commands = powerFeatures.slashCommands
                .filter { !["model", "plan", "default"].contains($0.name.lowercased()) }
                .filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            items.append(contentsOf: commands.prefix(19).map(FeatureComposerMenuItem.providerCommand))
            return items

        case .model:
            let query = trigger.query.trimmingCharacters(in: .whitespacesAndNewlines)
            let lockedProviderID = threadSelection.flatMap { selection in
                providers.first { $0.id == selection.providerID }?
                    .requiresNewThreadForModelChange == true
                    ? selection.providerID
                    : nil
            }
            return providers
                .filter(\.isAvailable)
                .filter { lockedProviderID == nil || $0.id == lockedProviderID }
                .flatMap { provider in
                    provider.models
                        .filter { model in
                            guard lockedProviderID != nil, let threadSelection else { return true }
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
            return powerFeatures.skills
                .filter(\.isEnabled)
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
