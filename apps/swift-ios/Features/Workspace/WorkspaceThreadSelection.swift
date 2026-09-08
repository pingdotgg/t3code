import Foundation

struct WorkspaceThreadSelection: Equatable {
    private(set) var selectedID: String?
    private(set) var lastOpenedID: String?

    var highlightedID: String? { selectedID ?? lastOpenedID }

    mutating func open(_ id: String) {
        selectedID = id
        lastOpenedID = id
    }

    func presentedID(isCompact: Bool, showsDetailColumn: Bool) -> String? {
        isCompact && !showsDetailColumn ? nil : selectedID
    }

    mutating func reconcilePresentation(isCompact: Bool, showsDetailColumn: Bool) {
        if isCompact && !showsDetailColumn { close() }
    }

    mutating func close() {
        selectedID = nil
    }
}
