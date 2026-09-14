import Foundation

public struct ThreadPullRequestKey: Codable, Hashable, Sendable {
    public let host: String
    public let repository: String
    public let number: Int

    public init(host: String, repository: String, number: Int) {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let repository = repository.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let suffix = ".visualstudio.com"
        let parts = repository.split(separator: "/")
        if ["ssh.dev.azure.com", "vs-ssh.visualstudio.com"].contains(host), parts.count == 4, parts[0] == "v3" {
            self.host = "dev.azure.com"
            self.repository = "\(parts[1])/\(parts[2])/_git/\(parts[3])"
        } else if host.hasSuffix(suffix), repository.contains("/_git/") {
            let organization = String(host.dropLast(suffix.count))
            self.host = "dev.azure.com"
            self.repository = "\(organization)/\(repository.hasPrefix("defaultcollection/") ? String(repository.dropFirst("defaultcollection/".count)) : repository)"
        } else {
            self.host = host
            self.repository = repository
        }
        self.number = number
    }

    public func matchesRepository(_ canonicalKey: String) -> Bool {
        guard let slash = canonicalKey.firstIndex(of: "/") else { return false }
        return self == Self(host: String(canonicalKey[..<slash]),
                            repository: String(canonicalKey[canonicalKey.index(after: slash)...]), number: number)
    }
}

public struct ThreadPullRequestSnapshot: Codable, Hashable, Sendable {
    public let state: PullRequestState
    public let title: String
    public let headBranch: String
    public let baseBranch: String
    public let isDraft: Bool
    public let updatedAt: String?
    public let syncedAt: String
    public var closedAt: String? = nil
    public var mergedAt: String? = nil
    public var author: PullRequestActor? = nil
    public var additions: Int? = nil
    public var deletions: Int? = nil
    public var changedFiles: Int? = nil
    public var reviewDecision: PullRequestReviewDecision? = nil
    public var checksState: PullRequestChecksState? = nil
    public var mergeability: PullRequestMergeability? = nil
}

public struct ThreadPullRequestStack: Codable, Hashable, Sendable {
    public struct Layer: Codable, Hashable, Sendable {
        public let number: Int
        public let headBranch: String
        public let state: PullRequestState
    }
    public let kind: String
    public let id: String
    public let number: Int
    public let url: String
    public let base: String
    public let layers: [Layer]
}

public struct ThreadPullRequestLink: Codable, Hashable, Sendable, Identifiable {
    public let host: String
    public let repository: String
    public let number: Int
    public let url: String
    // Keep unknown sources decodable. Only stack-dismissed is hidden.
    public var source: String
    public let linkedAt: String
    public var snapshot: ThreadPullRequestSnapshot?
    public var stack: ThreadPullRequestStack?

    public var id: ThreadPullRequestKey {
        let parsed = URL(string: url)
        let authority: String
        if let port = parsed?.port, let hostname = parsed?.host,
           hostname.caseInsensitiveCompare(host) == .orderedSame {
            authority = "\(hostname):\(port)"
        } else { authority = host }
        return ThreadPullRequestKey(host: authority, repository: repository, number: number)
    }
    public var isVisible: Bool { source != "stack-dismissed" }
    public var isOpen: Bool { snapshot == nil || snapshot?.state == .open }
}

/// Shared selection rules for badges, search and the thread's external PR link.
public enum ThreadPullRequests {
    public static func authority(of text: String) -> String? {
        guard let url = URL(string: text), let host = url.host else { return nil }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    public static func parseURL(_ text: String) -> ThreadPullRequestKey? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
        var routes: [(pattern: String, host: String)] = []
        if host == "github.com" || host.hasSuffix(".github.com") || host.split(separator: ".").contains("github") {
            routes.append((#"^/([^/]+/[^/]+)/pull/([0-9]+)(?:/|$)"#, host))
        }
        routes.append((#"^/([^/]+(?:/[^/]+)+)/-/merge_requests/([0-9]+)(?:/|$)"#, host))
        routes.append((#"^/([^/]+(?:/[^/]+)+)/pulls/([0-9]+)(?:/|$)"#, authority(of: url.absoluteString) ?? host))
        if host == "bitbucket.org" || host.hasSuffix(".bitbucket.org") || host.split(separator: ".").contains("bitbucket") {
            routes.append((#"^/([^/]+/[^/]+)/pull-requests/([0-9]+)(?:/|$)"#, host))
        }
        if host == "dev.azure.com" || host.hasSuffix(".dev.azure.com") || host.hasSuffix(".visualstudio.com") {
            routes.append((#"^/((?:[^/]+/)*_git/[^/]+)/pullrequest/([0-9]+)(?:/|$)"#, host))
        }
        let path = url.path
        for route in routes {
            guard let regex = try? NSRegularExpression(pattern: route.pattern),
                  let match = regex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
                  let repositoryRange = Range(match.range(at: 1), in: path),
                  let numberRange = Range(match.range(at: 2), in: path),
                  let number = Int(path[numberRange]), number > 0 else { continue }
            return ThreadPullRequestKey(host: route.host, repository: String(path[repositoryRange]), number: number)
        }
        return nil
    }

    public static func mutation(threadID: String, key: ThreadPullRequestKey, url: String,
                                linked: Bool, multiple: Bool, legacyProjectID: String?, legacyRepository: String? = nil,
                                commandID: String = UUID().uuidString) -> JSONValue? {
        var payload: [String: JSONValue] = ["commandId": .string(commandID), "threadId": .string(threadID)]
        if multiple {
            payload["type"] = .string(linked ? "thread.pull-request.link" : "thread.pull-request.unlink")
            payload["host"] = .string(key.host)
            payload["repository"] = .string(key.repository)
            payload["number"] = .number(Double(key.number))
            if linked {
                payload["url"] = .string(url)
                payload["source"] = .string("manual")
            }
        } else {
            guard !linked || legacyProjectID != nil else { return nil }
            payload["type"] = .string("thread.meta.update")
            payload["linkedPullRequest"] = linked ? .object([
                "projectId": .string(legacyProjectID ?? ""), "repository": .string(legacyRepository ?? key.repository),
                "number": .number(Double(key.number)), "url": .string(url),
            ]) : .null
        }
        return .object(payload)
    }

    public static func visible(_ links: [ThreadPullRequestLink]) -> [ThreadPullRequestLink] {
        links.filter(\.isVisible)
    }

    public static func chains(_ links: [ThreadPullRequestLink]) -> [[ThreadPullRequestLink]] {
        let links = visible(links)
        var placed: Set<ThreadPullRequestKey> = []
        var result: [[ThreadPullRequestLink]] = []
        for link in links where link.stack != nil && !placed.contains(link.id) {
            guard let stack = link.stack else { continue }
            let members = links.filter {
                $0.id.host == link.id.host && $0.id.repository == link.id.repository && $0.stack?.id == stack.id
            }
            let ordered = members.sorted { left, right in
                (stack.layers.firstIndex { $0.number == left.number } ?? 0)
                    < (stack.layers.firstIndex { $0.number == right.number } ?? 0)
            }
            placed.formUnion(ordered.map(\.id))
            result.append(ordered)
        }
        let remaining = links.filter { !placed.contains($0.id) }
        func parent(of link: ThreadPullRequestLink) -> ThreadPullRequestLink? {
            guard let base = link.snapshot?.baseBranch else { return nil }
            let matches = remaining.filter {
                $0.id.host == link.id.host && $0.id.repository == link.id.repository
                    && $0.snapshot?.headBranch == base
            }
            return matches.count == 1 && matches[0].id != link.id ? matches[0] : nil
        }
        let parents = Set(remaining.compactMap { parent(of: $0)?.id })
        for top in remaining where !parents.contains(top.id) {
            var chain: [ThreadPullRequestLink] = []
            var cursor: ThreadPullRequestLink? = top
            while let link = cursor, placed.insert(link.id).inserted {
                chain.insert(link, at: 0)
                cursor = parent(of: link)
            }
            if !chain.isEmpty { result.append(chain) }
        }
        for link in remaining where !placed.contains(link.id) { result.append([link]) }
        return result
    }

    public static func current(_ links: [ThreadPullRequestLink]) -> ThreadPullRequestLink? {
        let visible = visible(links)
        let open = visible.filter(\.isOpen)
        if open.count == 1 { return open.first }
        let chains = chains(visible)
        if !open.isEmpty {
            return chains.map { $0.reversed().filter(\.isOpen) }.filter { !$0.isEmpty }
                .sorted { ($0.map(\.linkedAt).max() ?? "") > ($1.map(\.linkedAt).max() ?? "") }
                .first?.first
        }
        if chains.count == 1 { return chains.first?.last }
        return visible.max { ($0.snapshot?.updatedAt ?? $0.linkedAt) < ($1.snapshot?.updatedAt ?? $1.linkedAt) }
    }

    public static func searchTerms(_ links: [ThreadPullRequestLink]?, legacy: ThreadLinkedPullRequest?) -> [String] {
        if let links, !links.isEmpty {
            return visible(links).flatMap { ["#\($0.number)", "\($0.repository)#\($0.number)", $0.url, $0.snapshot?.title ?? ""] }
        }
        return legacy.map { ["#\($0.number)", "\($0.repository)#\($0.number)", $0.url] } ?? []
    }
}
