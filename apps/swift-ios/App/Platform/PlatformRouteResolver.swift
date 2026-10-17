import Foundation

enum PlatformRouteResolver {
    static func thread(
        in snapshot: FeatureSnapshot,
        environmentID: String?,
        id: String
    ) -> FeatureThread? {
        let matches = snapshot.threads.filter { thread in
                (environmentID == nil || thread.environmentID == environmentID)
                    && (thread.id == id || thread.wireID == id)
            }
        guard environmentID != nil || matches.count == 1 else { return nil }
        return matches.max { $0.updatedAt < $1.updatedAt }
    }

    static func project(
        in snapshot: FeatureSnapshot,
        environmentID: String?,
        id: String
    ) -> FeatureProject? {
        let matches = snapshot.projects.filter { project in
                (environmentID == nil || project.environmentID == environmentID)
                    && (project.id == id || project.wireID == id)
            }
        guard environmentID != nil || matches.count == 1 else { return nil }
        return matches.first
    }
}

enum PlatformPromptLinkResolver {
    enum Destination: Equatable {
        case thread(FeatureThread)
        case project(FeatureProject)
        case scratch(environmentID: String)
        case missingRepository(PlatformPromptRepository)
        case unavailable(String)
    }

    struct ModelResolution: Equatable {
        let selection: FeatureSelection
        let exact: Bool
    }

    static func destination(
        for link: PlatformNewThreadLink, in snapshot: FeatureSnapshot,
        environmentID: String? = nil, projectID: String? = nil
    ) -> Destination {
        if let environmentID, !snapshot.environments.contains(where: { $0.id == environmentID }) {
            return .unavailable("That environment is not saved on this device.")
        }
        let explicitProject = projectID.flatMap {
            PlatformRouteResolver.project(in: snapshot, environmentID: environmentID, id: $0)
        }
        if projectID != nil, explicitProject == nil {
            return .unavailable("That project is not available on this device.")
        }
        let eligibleEnvironmentIDs = Set(snapshot.environments.filter {
            $0.isEnabled || $0.id == environmentID
        }.map(\.id))
        let projects = snapshot.projects.filter {
            eligibleEnvironmentIDs.contains($0.environmentID)
                && (environmentID == nil || $0.environmentID == environmentID)
                && (explicitProject == nil || $0.id == explicitProject?.id)
        }
        let threads = snapshot.threads.filter { thread in
            thread.environmentID.map(eligibleEnvironmentIDs.contains) == true
                && (environmentID == nil || thread.environmentID == environmentID)
                && (explicitProject == nil || (thread.environmentID == explicitProject?.environmentID
                    && (thread.projectID == explicitProject?.id || thread.projectID == explicitProject?.wireID)))
        }
        if case let .pullRequest(pr, _) = link,
           let thread = pullRequestThread(in: threads, pullRequest: pr),
           let id = thread.environmentID, snapshot.environments.contains(where: { $0.id == id }) {
            return .thread(thread)
        }
        if let repository = link.repository {
            if let project = project(in: projects, threads: threads, repository: repository) { return .project(project) }
            return .missingRepository(repository)
        }
        if let explicitProject { return .project(explicitProject) }
        if let id = scratchEnvironment(in: snapshot, environmentID: environmentID) { return .scratch(environmentID: id) }
        return .unavailable("No connected environment offers threads without a project.")
    }

    static func project(
        in projects: [FeatureProject], threads: [FeatureThread], repository: PlatformPromptRepository
    ) -> FeatureProject? {
        let matches = projects.filter { $0.repositoryIdentity?.groupingKey.lowercased() == repository.key }
        func activity(_ project: FeatureProject) -> Date {
            threads.lazy.filter {
                $0.environmentID == project.environmentID && ($0.projectID == project.id || $0.projectID == project.wireID)
            }.map(\.updatedAt).max() ?? .distantPast
        }
        // Keep input order on ties, as Array.find does in the shared resolver.
        return matches.reduce(nil as FeatureProject?) { latest, candidate in
            guard let latest else { return candidate }
            return activity(candidate) > activity(latest) ? candidate : latest
        }
    }

    static func pullRequestThread(in threads: [FeatureThread], pullRequest: PlatformPromptPullRequest) -> FeatureThread? {
        threads.reduce(nil as FeatureThread?) { latest, thread in
            let matches: Bool
            if let links = thread.pullRequests, !links.isEmpty {
                matches = links.contains { $0.isVisible && $0.id == pullRequest.key }
            } else if let legacy = thread.linkedPullRequest {
                matches = ThreadPullRequests.parseURL(legacy.url) == pullRequest.key
            } else { matches = false }
            guard matches else { return latest }
            if let latest, thread.updatedAt <= latest.updatedAt { return latest }
            return thread
        }
    }

    static func scratchEnvironment(in snapshot: FeatureSnapshot, environmentID: String? = nil) -> String? {
        let available = snapshot.environments.filter {
            $0.isEnabled && $0.connectionState == .connected && $0.supportsScratch == true
                && (environmentID == nil || $0.id == environmentID)
        }
        func latestActivity(_ id: String) -> Date {
            snapshot.threads.lazy.filter { $0.environmentID == id }.map(\.updatedAt).max() ?? .distantPast
        }
        return available.reduce(nil as FeatureEnvironment?) { latest, candidate in
            guard let latest else { return candidate }
            return latestActivity(candidate.id) > latestActivity(latest.id) ? candidate : latest
        }?.id
    }

    static func modelSelection(
        in snapshot: FeatureSnapshot, environmentID: String, provider: String, model: String?
    ) -> ModelResolution? {
        let driver = provider.lowercased() == "claude" ? "claudeagent" : provider.lowercased()
        let usable = (snapshot.providersByEnvironment?[environmentID] ?? []).filter {
            $0.driver.lowercased() == driver && $0.isAvailable && $0.isEnabled != false
        }
        guard let instance = usable.first(where: { $0.status == "ready" })
                ?? usable.first(where: { $0.status == "warning" }) else { return nil }
        let requested = model.flatMap { requested -> FeatureModel? in
            let value = requested.trimmingCharacters(in: .whitespacesAndNewlines)
            return instance.models.first { $0.id == value }
                ?? instance.models.first { $0.name.lowercased() == value.lowercased() }
                ?? instance.models.first { $0.aliases?.contains(where: { $0.lowercased() == value.lowercased() }) == true }
                ?? instance.models.first { $0.id == normalizedModel(value, driver: driver) }
        }
        guard let chosen = requested ?? instance.models.first(where: \.isDefault) ?? instance.models.first else { return nil }
        return ModelResolution(selection: .init(providerID: instance.id, modelID: chosen.id),
                               exact: model == nil || requested != nil)
    }

    private static func normalizedModel(_ value: String, driver: String) -> String {
        let aliases: [String: String]
        switch driver {
        case "codex":
            aliases = ["gpt-5-codex": "gpt-5.4", "5.4": "gpt-5.4", "5.3": "gpt-5.3-codex",
                       "gpt-5.3": "gpt-5.3-codex", "5.3-spark": "gpt-5.3-codex-spark", "gpt-5.3-spark": "gpt-5.3-codex-spark"]
        case "cursor":
            aliases = ["composer": "composer-2", "composer-1": "composer-1.5", "composer-1.5": "composer-1.5",
                       "opus-4.6-thinking": "claude-opus-4-6", "opus-4.6": "claude-opus-4-6",
                       "sonnet-4.6-thinking": "claude-sonnet-4-6", "sonnet-4.6": "claude-sonnet-4-6",
                       "opus-4.5-thinking": "claude-opus-4-5", "opus-4.5": "claude-opus-4-5"]
        default: aliases = [:]
        }
        return aliases[value] ?? value
    }
}

public struct PlatformThreadPromptRequest: Equatable, Hashable, Sendable {
    let id: UUID
    let prompt: PlatformLinkedPrompt

    init(id: UUID = UUID(), prompt: PlatformLinkedPrompt) {
        self.id = id
        self.prompt = prompt
    }
}

/// Decides which links tapped inside the app navigate in place instead of
/// being handed to the system.
///
/// A T3 link only stays in the app when it names a destination this device can
/// already show, so unknown web links keep opening on the web instead of
/// failing with an in-app error. Pairing links are always left to the system so
/// onboarding keeps owning connection confirmation.
enum PlatformInAppLinkRouter {
    static func route(for url: URL, in snapshot: FeatureSnapshot) -> PlatformRoute? {
        guard let route = try? PlatformDeepLinkParser.parse(url) else { return nil }

        switch route {
        case .usageLimits:
            return route
        case .connection:
            return nil
        case let .thread(environmentID, threadID),
             let .threadDestination(environmentID, threadID, _),
             let .threadPrompt(environmentID, threadID, _):
            guard isSavedEnvironment(environmentID, in: snapshot),
                  PlatformRouteResolver.thread(
                      in: snapshot,
                      environmentID: environmentID,
                      id: threadID
                  ) != nil
            else {
                return nil
            }
            return route
        case let .project(environmentID, projectID):
            guard isSavedEnvironment(environmentID, in: snapshot),
                  PlatformRouteResolver.project(
                      in: snapshot,
                      environmentID: environmentID,
                      id: projectID
                  ) != nil
            else {
                return nil
            }
            return route
        case let .environment(id):
            guard isSavedEnvironment(id, in: snapshot) else { return nil }
            return route
        case let .newTask(environmentID, projectID), let .newPrompt(environmentID, projectID, _):
            guard isSavedEnvironment(environmentID, in: snapshot) else { return nil }
            guard let projectID else { return route }
            guard PlatformRouteResolver.project(
                in: snapshot,
                environmentID: environmentID,
                id: projectID
            ) != nil else {
                return nil
            }
            return route
        }
    }

    private static func isSavedEnvironment(_ id: String?, in snapshot: FeatureSnapshot) -> Bool {
        guard let id else { return true }
        return snapshot.environments.contains { $0.id == id }
    }
}
