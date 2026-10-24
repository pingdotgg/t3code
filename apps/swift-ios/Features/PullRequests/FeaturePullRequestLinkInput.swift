import Foundation

enum FeaturePullRequestLinkInput {
    enum InputError: LocalizedError {
        case invalid, repositoryRequired

        var errorDescription: String? {
            switch self {
            case .invalid: "Use a pull request URL, 123, or #123."
            case .repositoryRequired: "Paste a full URL; this project's pull request address is not known."
            }
        }
    }

    static func resolve(_ input: String, repository: FeatureRepositoryIdentity?) throws -> String {
        var reference = input.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["gh pr checkout ", "glab mr checkout "] where reference.hasPrefix(prefix) {
            reference = String(reference.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if ThreadPullRequests.parseURL(reference) != nil { return reference }
        let digits = reference.hasPrefix("#") ? String(reference.dropFirst()) : reference
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = Int(digits), number > 0, number <= 9_007_199_254_740_991 else {
            throw InputError.invalid
        }
        guard let repository,
              let slash = repository.canonicalKey.firstIndex(of: "/") else { throw InputError.repositoryRequired }
        let host = String(repository.canonicalKey[..<slash])
        let path = String(repository.canonicalKey[repository.canonicalKey.index(after: slash)...])
        let provider = repository.provider ?? (host == "github.com" ? "github" : host == "gitlab.com" ? "gitlab" : "unknown")
        let suffix: String
        switch provider {
        case "github": suffix = "/pull/\(number)"
        case "gitlab": suffix = "/-/merge_requests/\(number)"
        case "forgejo", "gitea", "gitcafe": suffix = "/pulls/\(number)"
        case "bitbucket": suffix = "/pull-requests/\(number)"
        case "azure-devops", "azure": suffix = "/pullrequest/\(number)"
        default: throw InputError.repositoryRequired
        }
        let remoteBase = repository.remoteURL.flatMap { remote -> String? in
            guard let url = URL(string: remote), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            parts.user = nil
            parts.password = nil
            parts.query = nil
            parts.fragment = nil
            if parts.path.hasSuffix(".git") { parts.path = String(parts.path.dropLast(4)) }
            return parts.url?.absoluteString
        }
        let base = repository.webURL ?? remoteBase ?? "https://\(host)/\(path)"
        let url = base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + suffix
        guard ThreadPullRequests.parseURL(url) != nil else { throw InputError.repositoryRequired }
        return url
    }
}
