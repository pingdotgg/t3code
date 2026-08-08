import Foundation

@MainActor
protocol FeatureProjectCreationClient: AnyObject {
    func addProject(environmentID: String, path: String) async throws
    func browseProjectFolders(
        environmentID: String,
        partialPath: String
    ) async throws -> FilesystemBrowseResult
    func discoverProjectSources(environmentID: String) async throws -> SourceControlDiscoveryResult
    func lookupProjectRepository(
        environmentID: String,
        provider: SourceControlProviderKind,
        repository: String
    ) async throws -> SourceControlRepositoryInfo
    func cloneProjectRepository(
        environmentID: String,
        remoteURL: String,
        destinationPath: String
    ) async throws -> SourceControlCloneResult
}

enum ProjectRemoteSource: String, CaseIterable, Hashable, Identifiable {
    case url
    case github
    case gitlab
    case bitbucket
    case azureDevOps = "azure-devops"

    var id: String { rawValue }

    var provider: SourceControlProviderKind? {
        switch self {
        case .url: nil
        case .github: .github
        case .gitlab: .gitlab
        case .bitbucket: .bitbucket
        case .azureDevOps: .azureDevOps
        }
    }

    var label: String {
        switch self {
        case .url: "Git URL"
        case .github: "GitHub"
        case .gitlab: "GitLab"
        case .bitbucket: "Bitbucket"
        case .azureDevOps: "Azure DevOps"
        }
    }

    var prompt: String {
        switch self {
        case .url: "https://github.com/org/repository.git"
        case .github, .gitlab, .bitbucket: "owner/repository"
        case .azureDevOps: "organization/project/repository"
        }
    }
}

struct ProjectRemoteSourceOption: Equatable, Identifiable {
    let source: ProjectRemoteSource
    let isReady: Bool
    let detail: String?

    var id: String { source.id }
}

enum ProjectRemoteSourceOptions {
    static func options(
        discovery: SourceControlDiscoveryResult?
    ) -> [ProjectRemoteSourceOption] {
        let providerByKind = Dictionary(
            uniqueKeysWithValues: (discovery?.sourceControlProviders ?? []).map {
                ($0.kind.rawValue, $0)
            }
        )

        return ProjectRemoteSource.allCases.map { source in
            guard let providerKind = source.provider else {
                return ProjectRemoteSourceOption(source: source, isReady: true, detail: nil)
            }
            guard let provider = providerByKind[providerKind.rawValue] else {
                return ProjectRemoteSourceOption(
                    source: source,
                    isReady: false,
                    detail: "Provider status unavailable"
                )
            }
            guard provider.status == .available else {
                return ProjectRemoteSourceOption(
                    source: source,
                    isReady: false,
                    detail: provider.detail ?? provider.installHint
                )
            }
            guard provider.auth.status != .unauthenticated else {
                return ProjectRemoteSourceOption(
                    source: source,
                    isReady: false,
                    detail: provider.auth.detail ?? "Authentication required"
                )
            }
            let account = provider.auth.account.map { "Signed in as \($0)" }
            return ProjectRemoteSourceOption(
                source: source,
                isReady: true,
                detail: account ?? provider.version
            )
        }
    }
}

enum ProjectCreationPath {
    static func validated(_ rawValue: String) -> Result<String, ProjectCreationValidationError> {
        let path = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            return .failure(.init(message: "Enter a project path."))
        }
        guard isAbsoluteOrHomeRelative(path) else {
            return .failure(
                .init(message: "Use an absolute path, or start with ~/.")
            )
        }
        return .success(path)
    }

    static func repositoryName(from value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "repository" }
        let withoutQuery = trimmed.split(separator: "?", maxSplits: 1).first.map(String.init)
            ?? trimmed
        let withoutFragment = withoutQuery.split(separator: "#", maxSplits: 1).first.map(String.init)
            ?? withoutQuery
        let normalized = withoutFragment
            .replacingOccurrences(of: "\\", with: "/")
            .replacingOccurrences(of: ":", with: "/")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let component = normalized.split(separator: "/").last.map(String.init) ?? "repository"
        let withoutGit = component.lowercased().hasSuffix(".git")
            ? String(component.dropLast(4))
            : component
        let sanitized = withoutGit.trimmingCharacters(in: .whitespacesAndNewlines)
        return sanitized.isEmpty ? "repository" : sanitized
    }

    static func appending(_ component: String, to basePath: String) -> String {
        let base = basePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty else { return component }
        guard !component.isEmpty else { return base }
        let separator = base.contains("\\") && !base.contains("/") ? "\\" : "/"
        if base.hasSuffix("/") || base.hasSuffix("\\") {
            return base + component
        }
        return base + separator + component
    }

    /// `filesystem.browse` interprets a path without a trailing separator as
    /// a prefix search. Directory navigation always sends an explicit folder.
    static func directoryBrowsePath(_ value: String) -> String {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty,
              !path.hasSuffix("/"),
              !path.hasSuffix("\\") else {
            return path
        }
        if isWindowsAbsolutePath(path) {
            return path.replacingOccurrences(of: "/", with: "\\") + "\\"
        }
        return path + "/"
    }

    static func parentBrowsePath(of value: String) -> String? {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }

        if isWindowsAbsolutePath(path) {
            let normalized = path.replacingOccurrences(of: "/", with: "\\")
            if normalized.hasPrefix("\\\\") {
                let components = normalized.dropFirst(2).split(separator: "\\")
                guard components.count > 2 else { return nil }
                return "\\\\"
                    + components.dropLast().joined(separator: "\\")
                    + "\\"
            }

            var trimmed = normalized
            while trimmed.count > 3, trimmed.hasSuffix("\\") {
                trimmed.removeLast()
            }
            guard trimmed.count > 3,
                  let separator = trimmed.lastIndex(of: "\\") else {
                return nil
            }
            let parent = String(trimmed[...separator])
            return parent.count == 3 ? parent : directoryBrowsePath(parent)
        }

        var trimmed = path
        while trimmed.count > 1, trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard trimmed != "/", trimmed != "~",
              let separator = trimmed.lastIndex(of: "/") else {
            return nil
        }
        let parent = String(trimmed[...separator])
        guard parent != "~/" || trimmed != "~" else { return nil }
        return directoryBrowsePath(parent)
    }

    static func lastPathComponent(_ value: String) -> String {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = isWindowsAbsolutePath(path)
            ? path.replacingOccurrences(of: "\\", with: "/")
            : path
        return normalized
            .split(separator: "/", omittingEmptySubsequences: true)
            .last
            .map(String.init) ?? path
    }

    static func isCompatibleWithServerPath(_ value: String, serverPath: String) -> Bool {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let reference = serverPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.hasPrefix("~"),
              isAbsoluteOrHomeRelative(reference) else {
            return true
        }
        return isWindowsAbsolutePath(path) == isWindowsAbsolutePath(reference)
    }

    static func normalizedForComparison(_ value: String) -> String {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let isWindows = isWindowsAbsolutePath(path)
        var normalized = isWindows
            ? path.replacingOccurrences(of: "\\", with: "/")
            : path
        while normalized.count > 1, normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return isWindows ? normalized.lowercased() : normalized
    }

    private static func isAbsoluteOrHomeRelative(_ path: String) -> Bool {
        if path == "~" || path.hasPrefix("~/") || path.hasPrefix("~\\") {
            return true
        }
        if path.hasPrefix("/") || path.hasPrefix("\\\\") {
            return true
        }
        return isWindowsAbsolutePath(path)
    }

    private static func isWindowsAbsolutePath(_ path: String) -> Bool {
        if path.hasPrefix("\\\\") || path.hasPrefix("//") { return true }
        let scalars = Array(path.unicodeScalars.prefix(3))
        return scalars.count == 3
            && CharacterSet.letters.contains(scalars[0])
            && scalars[1] == ":"
            && (scalars[2] == "\\" || scalars[2] == "/")
    }
}

struct ProjectCreationValidationError: LocalizedError, Equatable {
    let message: String

    var errorDescription: String? { message }
}
