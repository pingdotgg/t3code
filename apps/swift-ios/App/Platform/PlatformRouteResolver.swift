import Foundation

enum PlatformRouteResolver {
    static func thread(
        in snapshot: FeatureSnapshot,
        environmentID: String?,
        id: String
    ) -> FeatureThread? {
        let activeID = snapshot.environments.first(where: \.isActive)?.id
        return snapshot.threads
            .filter { thread in
                (environmentID == nil || thread.environmentID == environmentID)
                    && (thread.id == id || thread.wireID == id)
            }
            .sorted { lhs, rhs in
                let lhsIsActive = lhs.environmentID == activeID
                let rhsIsActive = rhs.environmentID == activeID
                if lhsIsActive != rhsIsActive { return lhsIsActive }
                return lhs.updatedAt > rhs.updatedAt
            }
            .first
    }

    static func project(
        in snapshot: FeatureSnapshot,
        environmentID: String?,
        id: String
    ) -> FeatureProject? {
        let activeID = snapshot.environments.first(where: \.isActive)?.id
        return snapshot.projects
            .filter { project in
                (environmentID == nil || project.environmentID == environmentID)
                    && (project.id == id || project.wireID == id)
            }
            .sorted { lhs, rhs in
                let lhsIsActive = lhs.environmentID == activeID
                let rhsIsActive = rhs.environmentID == activeID
                if lhsIsActive != rhsIsActive { return lhsIsActive }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
            .first
    }
}
