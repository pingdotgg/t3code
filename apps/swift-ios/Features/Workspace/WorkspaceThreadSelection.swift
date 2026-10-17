/// Stores feature-scoped IDs, never wire IDs, so environments cannot share a route.
struct WorkspaceThreadSelection: Equatable {
    private(set) var selectedID: String?
    private(set) var lastOpenedID: String?
    private(set) var history: [String] = []

    var highlightedID: String? { selectedID ?? lastOpenedID }
    var rootID: String? { history.first ?? selectedID }
    var navigationPath: [String] {
        guard let selectedID, !history.isEmpty else { return [] }
        return Array(history.dropFirst()) + [selectedID]
    }

    /// List selection and external navigation begin a new route.
    mutating func open(_ id: String) {
        history.removeAll()
        selectedID = id
        lastOpenedID = id
    }

    mutating func push(_ id: String) {
        guard id != selectedID else { return }
        if let index = history.firstIndex(of: id) {
            history.removeSubrange(index...)
        } else if let selectedID {
            history.append(selectedID)
        }
        selectedID = id
        lastOpenedID = id
    }

    /// Removed parents are skipped without selecting another environment's thread.
    mutating func back(availableIDs: Set<String>) {
        while let parentID = history.popLast() {
            guard availableIDs.contains(parentID) else { continue }
            selectedID = parentID
            lastOpenedID = parentID
            return
        }
        close()
    }

    /// Accepts native Back, back-menu, and interactive-swipe path removals.
    mutating func pop(to path: [String], availableIDs: Set<String>) {
        let currentPath = navigationPath
        guard path.count < currentPath.count, currentPath.starts(with: path), let rootID else { return }
        let remaining = ([rootID] + path).filter { availableIDs.contains($0) }
        guard let selectedID = remaining.last else {
            close()
            return
        }
        history = Array(remaining.dropLast())
        self.selectedID = selectedID
        lastOpenedID = selectedID
    }

    mutating func resetHistory() {
        history.removeAll()
    }

    mutating func close() {
        history.removeAll()
        selectedID = nil
    }
}
