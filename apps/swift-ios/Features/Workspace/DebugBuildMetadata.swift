import Foundation

#if DEBUG
struct DebugBuildMetadata: Equatable {
    let build: String
    let commit: String
    let repositoryURL: String?
    let baseRef: String?
    let ahead: Int?
    let behind: Int?

    init(info: [String: Any]?) {
        build = Self.nonemptyValue("CFBundleVersion", info: info) ?? "?"
        commit = Self.nonemptyValue("T3GitCommit", info: info) ?? "unknown"

        let repository = Self.nonemptyValue("T3GitRepoURL", info: info)
        repositoryURL = repository?.hasPrefix("https://github.com/") == true ? repository : nil
        baseRef = Self.nonemptyValue("T3GitBaseRef", info: info)
        ahead = Self.nonnegativeCount("T3GitAheadCount", info: info)
        behind = Self.nonnegativeCount("T3GitBehindCount", info: info)
    }

    var identityLabel: String {
        "\(build) · \(commit)"
    }

    var distanceLabel: String? {
        guard let baseRef, let ahead, let behind else { return nil }
        let displayBaseRef = baseRef.split(separator: "/", maxSplits: 1).last.map(String.init)
            ?? baseRef
        return "\(ahead)↑ \(behind)↓ \(displayBaseRef)"
    }

    var accessibilityLabel: String {
        guard let baseRef, let ahead, let behind else {
            return "Development build \(identityLabel)"
        }
        let aheadUnit = ahead == 1 ? "commit" : "commits"
        let behindUnit = behind == 1 ? "commit" : "commits"
        return "Development build \(identityLabel), compared with \(baseRef): \(ahead) \(aheadUnit) ahead and \(behind) \(behindUnit) behind"
    }

    var commitURL: URL? {
        guard let repositoryURL, commit != "unknown" else { return nil }
        let cleanCommit = commit.hasSuffix("-dirty")
            ? String(commit.dropLast("-dirty".count))
            : commit
        return URL(string: "\(repositoryURL)/commit/\(cleanCommit)")
    }

    private static func nonemptyValue(_ key: String, info: [String: Any]?) -> String? {
        guard let value = info?[key] as? String,
              !value.isEmpty,
              !value.hasPrefix("$(")
        else { return nil }
        return value
    }

    private static func nonnegativeCount(_ key: String, info: [String: Any]?) -> Int? {
        guard let value = nonemptyValue(key, info: info),
              let count = Int(value),
              count >= 0
        else { return nil }
        return count
    }
}
#endif
