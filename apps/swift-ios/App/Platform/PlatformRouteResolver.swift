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
        case .connection:
            return nil
        case let .thread(environmentID, threadID):
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
        case let .newTask(environmentID, projectID):
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
